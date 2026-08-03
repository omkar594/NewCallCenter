import axios from 'axios';
import ariService from './ariService.js';
import pool from '../config/database.js';
import DinstarService from './dinstarService.js';
import { normalizePhoneNumber } from '../utils/phoneNormalizer.js';
import { synthesizeAndDeliver, substituteVars, hasVariablePlaceholders } from './ttsService.js';

// How long a client's lookup webhook may take before this node gives up and takes the 'error'
// branch - plan's explicit edge case: a slow/dead client backend must never hang the caller.
const LOOKUP_TIMEOUT_MS = 8000;
// Dialplan context transfer_queue hands the channel to via ariService.continueInDialplan() -
// must exist in extensions.conf (Workstream 8.8) as a single Queue(${EXTEN},...) step, reusing
// Workstream 7's queueMembershipService.js-backed bridging mechanism unchanged.
const IVR_TRANSFER_CONTEXT = process.env.IVR_TRANSFER_CONTEXT || 'ivr-transfer-context';
// Menu/collect_input digit-wait ceilings, overridable per flow via node config.
const DEFAULT_MENU_DIGIT_TIMEOUT_MS = 8000;
const DEFAULT_COLLECT_TIMEOUT_MS = 15000;
// Safety cap against a misconfigured flow (e.g. a branch cycle with no terminal node) looping
// forever and pinning the channel - mirrors bulkCampaignWorker.js's STALE_LEAD_TIMEOUT_SEC
// spirit of "never trust an event graph to always terminate on its own".
const MAX_STEPS_PER_CALL = 300;

// One entry per live call, keyed by ARI channel id. Flow variables and small bits of per-call
// state (has the channel already left Stasis?) live here - this is the engine's only state,
// nothing about a flow's definition is ever mutated at runtime.
const activeCalls = new Map();

// A prompt_id containing {{variable}} placeholders is a TTS template, not a literal
// pre-recorded filename - synthesized on the fly (Workstream 8.9) with the call's current flow
// variables substituted in, cached by content hash, and delivered through the same
// transcode+SFTP pipeline uploaded campaign audio uses. Everything else is treated as before:
// a literal basename already sitting in the Asterisk box's campaign_audio sounds directory.
async function resolvePromptMedia(promptId, vars) {
  if (hasVariablePlaceholders(promptId)) {
    const text = substituteVars(promptId, vars);
    const basename = await synthesizeAndDeliver(text);
    return `sound:campaign_audio/${basename}`;
  }
  return `sound:campaign_audio/${promptId}`;
}

async function playAndWait(channelId, media, timeoutMs = 30000) {
  const playback = await ariService.playMedia(channelId, media);
  await ariService.waitForEvent('PlaybackFinished', (evt) => evt.playback?.id === playback.id, timeoutMs);
  return playback;
}

async function loadFlow(flowId) {
  const flowRes = await pool.query(`SELECT * FROM ivr_flows WHERE id = $1`, [flowId]);
  if (!flowRes.rows[0]) {
    throw new Error(`IVR flow ${flowId} not found`);
  }
  const nodesRes = await pool.query(`SELECT * FROM ivr_nodes WHERE flow_id = $1`, [flowId]);
  const branchesRes = await pool.query(
    `SELECT b.* FROM ivr_node_branches b JOIN ivr_nodes n ON n.id = b.node_id WHERE n.flow_id = $1`,
    [flowId]
  );

  const nodesById = new Map(nodesRes.rows.map((n) => [n.id, n]));
  const branchesByNode = new Map();
  for (const branch of branchesRes.rows) {
    if (!branchesByNode.has(branch.node_id)) branchesByNode.set(branch.node_id, []);
    branchesByNode.get(branch.node_id).push(branch);
  }

  const startNode = nodesRes.rows.find((n) => n.is_start);
  if (!startNode) {
    throw new Error(`IVR flow ${flowId} has no start node`);
  }

  return { flow: flowRes.rows[0], nodesById, branchesByNode, startNode };
}

function followBranch(node, state, flowCtx, matchValue) {
  const branches = flowCtx.branchesByNode.get(node.id) || [];
  const match = branches.find((b) => b.match_value === matchValue);
  return match ? match.next_node_id : node.next_node_id;
}

async function handlePlay(node, state) {
  const media = await resolvePromptMedia(node.prompt_id, state.vars);
  await playAndWait(state.channelId, media);
  return node.next_node_id;
}

// Waits for exactly one DTMF digit, branching via ivr_node_branches keyed by that digit -
// generalizes Workstream 7's fixed 1/2/9 dialplan menu to however many options a flow defines.
// Interruptible like the dialplan's Background() was: the prompt is cut short the instant a
// digit arrives instead of forcing the caller to hear it out first.
async function handleMenu(node, state, flowCtx) {
  const menuMedia = await resolvePromptMedia(node.prompt_id, state.vars);
  const playback = await ariService.playMedia(state.channelId, menuMedia);
  const digitTimeoutMs = node.config?.digit_timeout_ms || DEFAULT_MENU_DIGIT_TIMEOUT_MS;

  const digitsPromise = ariService.gatherDigits(state.channelId, {
    maxDigits: 1,
    terminator: null,
    firstDigitTimeoutMs: digitTimeoutMs,
    interDigitTimeoutMs: digitTimeoutMs
  });
  digitsPromise.then((digits) => {
    if (digits) ariService.stopPlayback(playback.id).catch(() => {});
  });
  const digit = await digitsPromise;

  if (!digit) {
    // Timeout / no digit pressed - re-offer the same menu rather than erroring, matching the
    // dialplan version's 't' (timeout) behavior.
    return node.id;
  }
  const nextNodeId = followBranch(node, state, flowCtx, digit);
  // No branch defined for this digit - matches the dialplan version's 'i' (invalid) behavior.
  return nextNodeId || node.id;
}

// Collects a full number (not just one keypress) - e.g. the provider/consumer number in the
// gas-booking worked example - terminated by a configurable digit, max length, or timeout.
async function handleCollectInput(node, state) {
  const config = node.config || {};
  const maxDigits = config.max_digits || 20;
  const minDigits = config.min_digits || 1;
  const terminator = config.terminator !== undefined ? config.terminator : '#';
  const timeoutMs = config.timeout_ms || DEFAULT_COLLECT_TIMEOUT_MS;

  if (node.prompt_id) {
    const media = await resolvePromptMedia(node.prompt_id, state.vars);
    await playAndWait(state.channelId, media);
  }

  const digits = await ariService.gatherDigits(state.channelId, {
    maxDigits,
    terminator,
    firstDigitTimeoutMs: timeoutMs,
    interDigitTimeoutMs: timeoutMs
  });

  if (digits.length < minDigits) {
    // Plan's explicit edge case: fewer digits than min_digits then the terminator - re-prompt
    // rather than accepting a short entry as valid.
    return node.id;
  }
  if (config.store_as) state.vars[config.store_as] = digits;
  return node.next_node_id;
}

// Looks a collected value up against either a client's own webhook or a hosted CSV-uploaded
// table - same node type, two source options, per plan decision. Branches on found/not_found/
// error via ivr_node_branches; result fields become new flow variables for later prompts.
async function handleLookup(node, state, flowCtx) {
  const config = node.config || {};
  const inputValue = config.lookup_key ? state.vars[config.lookup_key] : undefined;
  const varPrefix = config.response_var_prefix || '';
  let result = 'error';
  let data = {};

  try {
    if (config.source_type === 'webhook') {
      const res = await axios.post(config.webhook_url, {
        flowId: state.flowId,
        callId: state.channelId,
        nodeId: node.id,
        input: { [config.lookup_key]: inputValue }
      }, {
        timeout: LOOKUP_TIMEOUT_MS,
        headers: config.webhook_auth_header ? { Authorization: config.webhook_auth_header } : undefined
      });
      if (res.data?.status === 'found' || res.data?.status === 'not_found') {
        result = res.data.status;
      }
      data = res.data?.data || {};
    } else if (config.source_type === 'table') {
      const rowRes = await pool.query(
        `SELECT data FROM ivr_lookup_rows WHERE table_id = $1 AND key_value = $2`,
        [config.table_id, inputValue]
      );
      if (rowRes.rows[0]) {
        result = 'found';
        data = rowRes.rows[0].data;
      } else {
        result = 'not_found';
      }
    }
  } catch (err) {
    console.error(`[IvrFlowEngine] Lookup node ${node.id} failed: ${err.message}`);
    result = 'error';
  }

  for (const [key, value] of Object.entries(data)) {
    state.vars[`${varPrefix}${key}`] = value;
  }

  return followBranch(node, state, flowCtx, result);
}

function evaluateCondition(config, vars) {
  const actual = vars[config.variable];
  switch (config.operator || 'eq') {
    case 'eq': return String(actual) === String(config.value);
    case 'neq': return String(actual) !== String(config.value);
    case 'gt': return Number(actual) > Number(config.value);
    case 'gte': return Number(actual) >= Number(config.value);
    case 'lt': return Number(actual) < Number(config.value);
    case 'lte': return Number(actual) <= Number(config.value);
    case 'exists': return actual !== undefined && actual !== null && actual !== '';
    default: return false;
  }
}

// Generic conditional on any flow variable, for branches beyond a lookup's own found/not_found
// (e.g. "if daily_transfer_count >= 3").
async function handleBranch(node, state, flowCtx) {
  const result = evaluateCondition(node.config || {}, state.vars) ? 'true' : 'false';
  return followBranch(node, state, flowCtx, result);
}

// Reuses Workstream 7's Queue()/queueMembershipService.js bridging mechanism unchanged instead
// of reimplementing agent bridging over ARI - hands the channel back to the static dialplan.
// The channel's Uniqueid is stable across this handoff, so bulkCampaignWorker.js's existing
// Hangup-based completion tracking (including the long-transfer-call timeout) keeps working
// with no changes needed there.
async function handleTransferQueue(node, state) {
  const queueName = node.config?.queue_name || process.env.CAMPAIGN_AGENT_QUEUE || 'campaign_agents';
  await ariService.continueInDialplan(state.channelId, IVR_TRANSFER_CONTEXT, queueName, 1);
  state.leftStasis = true;
  return null;
}

async function handleSms(node, state) {
  const config = node.config || {};
  const message = substituteVars(config.message_template, state.vars);
  const toRaw = config.to_variable ? state.vars[config.to_variable] : state.callerNumber;
  try {
    const dinstar = new DinstarService(
      process.env.DINSTAR_GATEWAY_IP,
      process.env.DINSTAR_API_USER,
      process.env.DINSTAR_API_PASS
    );
    await dinstar.sendSms(message, normalizePhoneNumber(toRaw));
  } catch (err) {
    // Non-fatal - a failed SMS shouldn't kill an otherwise-working call.
    console.error(`[IvrFlowEngine] SMS node ${node.id} failed to send: ${err.message}`);
  }
  return node.next_node_id;
}

// Reuses Workstream 7's dnc_numbers/opt-out logic as a node instead of a hardcoded DTMF-9
// dialplan branch - same normalizePhoneNumber() campaignController.js's webhook and
// bulkCampaignWorker.js both already use, so a number opted out here is filtered the same way
// on the next campaign upload.
async function handleOptout(node, state) {
  const normalized = normalizePhoneNumber(state.callerNumber);
  try {
    await pool.query(
      `INSERT INTO dnc_numbers (phone_number, source_lead_id) VALUES ($1, $2) ON CONFLICT (phone_number) DO NOTHING`,
      [normalized, state.leadId || null]
    );
    if (state.leadId) {
      await pool.query(
        `UPDATE campaign_leads SET dial_status = 'opted_out', updated_at = NOW() WHERE id = $1`,
        [state.leadId]
      );
    }
  } catch (err) {
    console.error(`[IvrFlowEngine] Optout node ${node.id} failed: ${err.message}`);
  }
  if (node.prompt_id) {
    const media = await resolvePromptMedia(node.prompt_id, state.vars);
    await playAndWait(state.channelId, media);
  }
  return node.next_node_id;
}

// AMD itself has no ARI equivalent - it must run as a dialplan step (AMD()) BEFORE the channel
// enters Stasis (see Workstream 8.8's dialplan entry point), which sets AMDSTATUS as a channel
// variable. This node just reads that variable back and branches on it the same way Workstream
// 7's dialplan did (machine/human/notsure), generalized to whatever branches the flow defines.
async function handleAmdCheck(node, state, flowCtx) {
  const amdStatus = await ariService.getChannelVar(state.channelId, 'AMDSTATUS').catch(() => null);
  return followBranch(node, state, flowCtx, amdStatus || '');
}

async function handleHangup(node, state) {
  await ariService.hangupChannel(state.channelId).catch(() => {});
  state.leftStasis = true;
  return null;
}

const NODE_HANDLERS = {
  play: handlePlay,
  menu: handleMenu,
  collect_input: handleCollectInput,
  lookup: handleLookup,
  branch: handleBranch,
  transfer_queue: handleTransferQueue,
  sms: handleSms,
  optout: handleOptout,
  amd_check: handleAmdCheck,
  hangup: handleHangup
};

async function executeNode(node, state, flowCtx) {
  const handler = NODE_HANDLERS[node.type];
  if (!handler) {
    console.error(`[IvrFlowEngine] Unknown node type '${node.type}' (node ${node.id}) - ending call.`);
    return null;
  }
  return handler(node, state, flowCtx);
}

async function runFlow(channelId, flowId, leadId, callerNumber) {
  const flowCtx = await loadFlow(flowId);
  const state = { channelId, flowId, leadId, callerNumber, vars: {}, leftStasis: false };
  activeCalls.set(channelId, state);

  await ariService.answerChannel(channelId);

  let currentNode = flowCtx.startNode;
  let steps = 0;
  while (currentNode && !state.leftStasis && steps < MAX_STEPS_PER_CALL) {
    steps++;
    const nextNodeId = await executeNode(currentNode, state, flowCtx);
    if (!nextNodeId || state.leftStasis) break;
    currentNode = flowCtx.nodesById.get(nextNodeId);
    if (!currentNode) {
      console.error(`[IvrFlowEngine] Flow ${flowId} references missing node ${nextNodeId} - ending call.`);
      break;
    }
  }
  if (steps >= MAX_STEPS_PER_CALL) {
    console.error(`[IvrFlowEngine] Flow ${flowId} on channel ${channelId} hit the ${MAX_STEPS_PER_CALL}-step safety cap - likely a cycle with no terminal node.`);
  }

  if (!state.leftStasis) {
    await ariService.hangupChannel(channelId).catch(() => {});
  }
  activeCalls.delete(channelId);
}

ariService.on('StasisStart', (evt) => {
  const channelId = evt.channel?.id;
  const [flowId, leadId] = evt.args || [];
  if (!channelId || !flowId) {
    console.error(`[IvrFlowEngine] StasisStart with no channel/flowId (args=${JSON.stringify(evt.args)}) - hanging up.`);
    if (channelId) ariService.hangupChannel(channelId).catch(() => {});
    return;
  }
  const callerNumber = evt.channel?.caller?.number || '';
  runFlow(channelId, flowId, leadId, callerNumber).catch((err) => {
    console.error(`[IvrFlowEngine] Flow execution failed for channel ${channelId}: ${err.message}`);
    ariService.hangupChannel(channelId).catch(() => {});
    activeCalls.delete(channelId);
  });
});

ariService.on('StasisEnd', (evt) => {
  const channelId = evt.channel?.id;
  const state = activeCalls.get(channelId);
  if (state) state.leftStasis = true;
});

console.log('[IvrFlowEngine] Listening for ARI StasisStart (Workstream 8 IVR-flow campaigns).');
