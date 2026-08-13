import pg from 'pg';
import dotenv from 'dotenv';
import asteriskService from './services/asteriskService.js';
import { normalizePhoneNumber } from './utils/phoneNormalizer.js';
import { creditsForDuration } from './utils/creditCalculator.js';

dotenv.config();

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });

// How long to ring before giving up on a lead (Originate's Timeout, ms).
const ORIGINATE_RING_TIMEOUT_MS = parseInt(process.env.ORIGINATE_RING_TIMEOUT_MS) || 45000;
// How long to wait for Asterisk's OriginateResponse event before assuming the dial died silently.
const ORIGINATE_RESPONSE_TIMEOUT_MS = ORIGINATE_RING_TIMEOUT_MS + 20000;
// Safety cap on how long an answered call may hold its slot before we free it even without
// a Hangup event (covers a dropped/missed event - the SIM channel physically stays busy
// through ringing + the voice prompt, so this must comfortably exceed both).
const MAX_CALL_DURATION_MS = parseInt(process.env.MAX_CALL_DURATION_MS) || 5 * 60 * 1000;
// Workstream 7: once a call is transferred to a live agent (dialplan emits
// UserEvent(AgentTransferStart,...) - see extensions.conf), the channel can legitimately stay
// busy far longer than an ordinary broadcast prompt. Using MAX_CALL_DURATION_MS as the cap for
// a transferred call would free its concurrency slot mid-conversation while the SIM port is
// still physically busy, letting a second lead dial out onto a line that isn't actually free -
// the same SIP 480/503 collision this project already fixed once for the plain-broadcast case.
// Ordinary (non-transferred) calls are completely unaffected by this constant.
const MAX_AGENT_CALL_DURATION_MS = parseInt(process.env.MAX_AGENT_CALL_DURATION_MS) || 2 * 60 * 60 * 1000;
// DB-level backstop for leads still stuck 'processing' after a worker crash/restart lost
// its in-memory event listeners entirely.
const STALE_LEAD_TIMEOUT_SEC = parseInt(process.env.STALE_LEAD_TIMEOUT_SEC) || 400;
// Small stagger between simultaneous dispatches within one tick, so a burst of free slots
// doesn't fire a wall of simultaneous INVITEs at the gateway. This is NOT the call-pacing
// mechanism anymore - real concurrency is gated by getMaxConcurrentCalls() below.
const DISPATCH_STAGGER_MS = (() => {
  const raw = parseInt(process.env.PACING_BUFFER_DELAY_SEC);
  return (isNaN(raw) || raw < 0 ? 2 : raw) * 1000;
})();
const POLL_INTERVAL_MS = 2000;
// Used only when gateway_port_telemetry has no live rows yet (e.g. dinstarPoller hasn't
// polled since boot) - a conservative single-call-at-a-time fallback.
const FALLBACK_MAX_CONCURRENT_CALLS = parseInt(process.env.MAX_CONCURRENT_CALLS) || 1;
// How many times a lead may be retried after an immediate gateway-level rejection (e.g. SIP
// 480/503 - "no line free right now") before it's given up on as a genuine failure.
const MAX_DIAL_ATTEMPTS = parseInt(process.env.MAX_DIAL_ATTEMPTS) || 3;
// How stale gateway_port_telemetry is allowed to be before we stop trusting it. dinstarPoller
// polls roughly every 15s; if it hasn't successfully written a row in 90s (gateway unreachable,
// poll timing out), treat capacity as unknown rather than dialing off a last-known-good count
// that may no longer be true - a stale "2 ports registered" reading is what let two calls fire
// at once against a gateway that in practice only had 1 line free, producing SIP 480/503s.
const TELEMETRY_FRESHNESS_SEC = parseInt(process.env.TELEMETRY_FRESHNESS_SEC) || 90;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Track Round-Robin counters for campaigns with specific allowed ports. This remains an
// informational hint only (logged + passed as a channel variable) - actual per-port SIM
// pinning is a Dinstar-gateway-side routing decision, not something this codebase controls.
const campaignPortCounters = {};

function pickPort(allowedPorts, campaignId) {
  if (!allowedPorts || allowedPorts === 'all') {
    return { targetPort: null, label: 'All Gateway Ports (Round-Robin)' };
  }
  const portList = String(allowedPorts).split(',').map(p => p.trim()).filter(Boolean);
  if (portList.length === 0) {
    return { targetPort: null, label: 'All Gateway Ports (Round-Robin)' };
  }
  if (campaignPortCounters[campaignId] === undefined) {
    campaignPortCounters[campaignId] = 0;
  }
  const idx = campaignPortCounters[campaignId] % portList.length;
  const targetPort = portList[idx];
  campaignPortCounters[campaignId]++;
  return { targetPort, label: `Selected Port ${targetPort} (out of restricted ports: [${portList.join(', ')}])` };
}

// Best-effort mapping of AMI OriginateResponse "Reason" codes. Exact values vary slightly
// across Asterisk versions, so unknown codes fall back to the generic 'failed' status rather
// than guessing.
function mapFailureReason(reason) {
  switch (String(reason)) {
    case '4': return 'busy';
    case '1':
    case '8': return 'no-answer';
    default: return 'failed';
  }
}

async function reapStaleLeads() {
  await pool.query(
    `UPDATE campaign_leads SET dial_status = 'failed', updated_at = NOW()
     WHERE dial_status = 'processing' AND updated_at < NOW() - ($1 || ' seconds')::interval`,
    [STALE_LEAD_TIMEOUT_SEC]
  );
}

async function getActiveProcessingCount() {
  const result = await pool.query(`SELECT COUNT(*)::int AS c FROM campaign_leads WHERE dial_status = 'processing'`);
  return result.rows[0].c;
}

// Real concurrency capacity, driven by how many SIM ports are actually registered right now
// (kept live by dinstarPoller.js). Falls back to a conservative default if telemetry is empty
// (poller not running yet, or gateway unreachable) so we never over-dial an unknown gateway.
async function getMaxConcurrentCalls() {
  try {
    const result = await pool.query(
      `SELECT COUNT(*)::int AS registered FROM gateway_port_telemetry
       WHERE registration_status = 'REGISTER_OK' AND last_polled > NOW() - ($1 || ' seconds')::interval`,
      [TELEMETRY_FRESHNESS_SEC]
    );
    const registered = result.rows[0]?.registered || 0;
    return registered > 0 ? registered : FALLBACK_MAX_CONCURRENT_CALLS;
  } catch (err) {
    return FALLBACK_MAX_CONCURRENT_CALLS;
  }
}

async function claimNextPendingLead() {
  const result = await pool.query(`
    WITH target_lead AS (
      SELECT cl.id, cl.phone_number, cl.customer_name, cl.campaign_id, cl.language_code, vc.audio_url, vc.allowed_ports, vc.ivr_flow_id, vc.tenant_id
      FROM campaign_leads cl
      JOIN voice_campaigns vc ON cl.campaign_id = vc.id
      WHERE cl.dial_status = 'pending' AND vc.status IN ('running', 'pending')
      -- Claim a campaign's own leads to completion before moving to another campaign's
      -- leads, ordering by the campaign's creation time (not the lead's own updated_at)
      -- across the WHOLE table. Plain per-lead updated_at ordering let unrelated leftover
      -- test campaigns interleave with (and starve) a brand-new campaign's own 2nd/3rd
      -- lead, which looked like "the 2nd number never dials" even though the dialer itself
      -- was working correctly per-call.
      ORDER BY vc.created_at DESC, cl.updated_at ASC
      LIMIT 1
      FOR UPDATE OF cl SKIP LOCKED
    )
    UPDATE campaign_leads
    SET dial_status = 'processing', attempts = campaign_leads.attempts + 1, updated_at = NOW()
    FROM target_lead
    WHERE campaign_leads.id = target_lead.id
    RETURNING
      campaign_leads.id AS lead_id,
      campaign_leads.attempts,
      target_lead.phone_number,
      target_lead.customer_name,
      target_lead.campaign_id,
      target_lead.language_code,
      target_lead.audio_url,
      target_lead.allowed_ports,
      target_lead.ivr_flow_id,
      target_lead.tenant_id;
  `);
  return result.rows[0] || null;
}

// Workstream 9: AMD costs several real seconds of dead air before the caller hears anything
// (it must listen to real audio before it can decide human vs. machine) - only worth paying
// for flows that actually branch on the result. A flow with no amd_check node never reads
// ${AMDSTATUS} at all, so extensions.conf skips AMD() entirely for it (see NEEDS_AMD below).
async function flowNeedsAmd(flowId) {
  const result = await pool.query(
    `SELECT EXISTS(SELECT 1 FROM ivr_nodes WHERE flow_id = $1 AND type = 'amd_check') AS needed`,
    [flowId]
  );
  return result.rows[0]?.needed || false;
}

// Puts a lead back in the queue instead of finalizing it as a permanent failure. Used only
// for immediate gateway-level rejections (no line free right now), so other pending leads -
// in this campaign or others - get a turn before this one is retried, rather than it either
// blocking everything behind it or being burned as failed on a purely capacity-driven reject.
async function requeueLead(leadId) {
  await pool.query(
    `UPDATE campaign_leads SET dial_status = 'pending', updated_at = NOW() WHERE id = $1`,
    [leadId]
  );
}

async function finalizeLead(leadId, campaignId, dialStatus, durationSec, tenantId) {
  // Credit billing: only a genuinely answered call (real connected duration) is billable -
  // busy/no-answer/failed leads pass durationSec=0/undefined and cost nothing (see
  // utils/creditCalculator.js).
  const credits = dialStatus === 'answered' ? creditsForDuration(durationSec) : 0;
  // A call that never connected gets another try if the campaign's max_retry_attempts allows
  // it - never for 'answered' (nothing to retry) or 'opted_out' (handled by the CASE guard
  // below regardless). Bounded by campaign_leads.attempts, which claimNextPendingLead() already
  // increments on every claim, so "attempts <= max_retry_attempts" is exactly "tries used so far
  // (including this one) still fit inside 1 + max_retry_attempts total tries allowed."
  const retryEligible = ['busy', 'no-answer', 'failed'].includes(dialStatus);
  let wasRequeued = false;

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // Workstream 7: a caller who presses 9 gets marked 'opted_out' by the opt-out webhook
    // (campaignController.js's handleOptOutWebhook) WHILE the call is still up - the real Hangup
    // this function reacts to fires moments later, and without the CASE guard below would
    // overwrite 'opted_out' back to 'answered' since the call genuinely did answer. Once a lead
    // is opted_out, that's terminal - never let the normal answered/busy/failed finalize clobber it.
    const leadResult = await client.query(
      `UPDATE campaign_leads cl
       SET dial_status = CASE
             WHEN cl.dial_status = 'opted_out' THEN cl.dial_status
             WHEN $1 AND cl.attempts <= vc.max_retry_attempts THEN 'pending'
             ELSE $2
           END,
           call_duration = $3, updated_at = NOW()
       FROM voice_campaigns vc
       WHERE cl.id = $4 AND vc.id = cl.campaign_id
       RETURNING cl.dial_status`,
      [retryEligible, dialStatus, durationSec, leadId]
    );
    // Requeued back to 'pending' isn't actually processed yet - only count it toward the
    // campaign's progress once it lands in a real terminal state (matches the campaign
    // detail/list pages' processed_leads/total_leads progress display).
    wasRequeued = leadResult.rows[0]?.dial_status === 'pending';
    if (!wasRequeued) {
      await client.query(
        `UPDATE voice_campaigns SET processed_leads = processed_leads + 1 WHERE id = $1`,
        [campaignId]
      );
    }

    if (credits > 0 && tenantId) {
      const tenantResult = await client.query(
        `UPDATE tenants SET credit_balance = credit_balance - $1 WHERE id = $2 RETURNING credit_balance`,
        [credits, tenantId]
      );
      const newBalance = tenantResult.rows[0]?.credit_balance;
      await client.query(
        `INSERT INTO credit_transactions (tenant_id, type, amount, balance_after, campaign_id, lead_id)
         VALUES ($1, 'deduction', $2, $3, $4, $5)`,
        [tenantId, -credits, newBalance, campaignId, leadId]
      );
      // Balance exhausted mid-campaign: cancel this tenant's active campaigns so
      // claimNextPendingLead()'s `vc.status IN ('running', 'pending')` predicate stops handing
      // out any more of its leads. Any call already dispatched/connected finishes normally -
      // this only blocks leads not yet claimed.
      if (newBalance !== undefined && newBalance <= 0) {
        await client.query(
          `UPDATE voice_campaigns SET status = 'cancelled', updated_at = NOW()
           WHERE tenant_id = $1 AND status IN ('preparing', 'running', 'pending')`,
          [tenantId]
        );
        console.warn(`[Worker] Tenant ${tenantId} credit balance reached ${newBalance} - active campaigns cancelled.`);
      }
    }

    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    console.error(`[Worker] finalizeLead failed for lead ${leadId}:`, err.message || err);
    throw err;
  } finally {
    client.release();
  }

  if (wasRequeued) {
    console.log(`[Worker] Lead ${leadId}: ${dialStatus}, requeued for another attempt`);
  } else {
    console.log(`[Worker] Lead ${leadId} finalized: ${dialStatus} (${durationSec}s)${credits > 0 ? `, ${credits} credit(s) charged` : ''}`);
  }
}

// Dispatches one lead and tracks it through to REAL completion via AMI events, instead of
// marking it done the instant Asterisk acknowledges the Originate request. This is the fix
// for the "2nd number never dials" bug: dial_status now stays 'processing' for the actual
// duration of the call, so the concurrency gate in tick() genuinely reflects channel busy-ness.
async function dispatchLead(lead) {
  const cleanPhoneNumber = normalizePhoneNumber(lead.phone_number);
  const { targetPort, label } = pickPort(lead.allowed_ports, lead.campaign_id);
  const channelName = `PJSIP/${cleanPhoneNumber}@DinstarTrunk`;

  console.log(`\n[Worker] Dispatching lead ${lead.lead_id} -> ${cleanPhoneNumber} | Port strategy: ${label}`);

  // Workstream 8: a campaign with voice_campaigns.ivr_flow_id set dials into the new
  // ivr-campaign-context (Stasis-driven, interpreted by ivrFlowEngine.js) instead of the plain
  // single-prompt campaign-broadcast-context. FLOW_ID replaces CAMPAIGN_AUDIO_FILE as the
  // dialplan-facing variable in that case - the flow engine looks up its own prompts per node.
  const dialContext = lead.ivr_flow_id ? 'ivr-campaign-context' : 'campaign-broadcast-context';
  const originateVars = {
    LEAD_ID: lead.lead_id,
    CAMP_ID: lead.campaign_id,
    TARGET_PORT: targetPort || ''
  };
  if (lead.ivr_flow_id) {
    originateVars.FLOW_ID = lead.ivr_flow_id;
    originateVars.LANGUAGE_CODE = lead.language_code || '';
    originateVars.NEEDS_AMD = (await flowNeedsAmd(lead.ivr_flow_id)) ? 'true' : 'false';
  } else {
    originateVars.CAMPAIGN_AUDIO_FILE = lead.audio_url || '';
  }

  const { actionId, ackPromise } = asteriskService.originateAsync(
    channelName,
    cleanPhoneNumber,
    dialContext,
    1,
    originateVars,
    'VoiceBroadcast',
    ORIGINATE_RING_TIMEOUT_MS
  );

  let ack;
  try {
    ack = await ackPromise;
  } catch (err) {
    console.error(`[Worker] AMI rejected dispatch for lead ${lead.lead_id}: ${err.message}`);
    await finalizeLead(lead.lead_id, lead.campaign_id, 'failed', 0, lead.tenant_id);
    return;
  }

  if (ack.Response !== 'Success') {
    console.error(`[Worker] Asterisk rejected Originate for lead ${lead.lead_id}: ${ack.Message}`);
    await finalizeLead(lead.lead_id, lead.campaign_id, 'failed', 0, lead.tenant_id);
    return;
  }

  const originateResponse = await asteriskService.waitForEvent(
    'OriginateResponse',
    (evt) => evt.ActionID === actionId,
    ORIGINATE_RESPONSE_TIMEOUT_MS
  );

  if (!originateResponse) {
    console.warn(`[Worker] Lead ${lead.lead_id}: no OriginateResponse within ${ORIGINATE_RESPONSE_TIMEOUT_MS}ms - treating as failed and freeing the slot`);
    // 0, not elapsed wait time - the call never connected, so there's no real duration to show.
    await finalizeLead(lead.lead_id, lead.campaign_id, 'failed', 0, lead.tenant_id);
    return;
  }

  if (originateResponse.Response !== 'Success') {
    const status = mapFailureReason(originateResponse.Reason);
    // Reason 0 on an essentially-instant rejection is how this gateway reports "no line free
    // right now" (SIP 480/503 back from Dinstar before the call ever really rang) rather than
    // a real busy-tone/no-answer outcome for the callee. Requeue it - bounded by attempts -
    // instead of burning the lead as permanently failed just because two leads happened to
    // race for the gateway's one actually-available line.
    if (status === 'failed' && String(originateResponse.Reason) === '0' && lead.attempts < MAX_DIAL_ATTEMPTS) {
      console.log(`[Worker] Lead ${lead.lead_id}: gateway had no free line (reason=0) - requeueing (attempt ${lead.attempts}/${MAX_DIAL_ATTEMPTS})`);
      await requeueLead(lead.lead_id);
      return;
    }
    console.log(`[Worker] Lead ${lead.lead_id}: call did not connect (${status}, reason=${originateResponse.Reason})`);
    // 0, not elapsed wait time - same reasoning as the no-OriginateResponse branch above.
    await finalizeLead(lead.lead_id, lead.campaign_id, status, 0, lead.tenant_id);
    return;
  }

  // Call connected - originateResponse.Response === 'Success' is Asterisk's own signal that the
  // callee actually answered (AMI only reports Originate as Success once the far end picks up),
  // so this is the real "call connected" instant. Credit billing and call_duration (see
  // finalizeLead below) must be charged on this connected duration only, never ring/wait time.
  const answeredAt = Date.now();

  // The SIM channel stays genuinely busy through ringing + prompt playback, so keep this lead
  // 'processing' (holding a concurrency slot) until the real Hangup. Race that against an
  // AgentTransferStart marker (Workstream 7) so a press-1 transfer switches to the much longer
  // MAX_AGENT_CALL_DURATION_MS cap instead of the ordinary one.
  const uniqueid = originateResponse.Uniqueid;
  let hangupEvent = null;

  if (uniqueid) {
    const raceResult = await Promise.race([
      asteriskService.waitForEvent('Hangup', (evt) => evt.Uniqueid === uniqueid, MAX_CALL_DURATION_MS)
        .then((evt) => ({ kind: 'hangup', evt })),
      asteriskService.waitForEvent('UserEvent', (evt) => evt.UserEvent === 'AgentTransferStart' && evt.Uniqueid === uniqueid, MAX_CALL_DURATION_MS)
        .then((evt) => ({ kind: 'transfer', evt }))
    ]);

    if (raceResult.kind === 'transfer' && raceResult.evt) {
      console.log(`[Worker] Lead ${lead.lead_id}: transferred to a live agent - extending hold to ${MAX_AGENT_CALL_DURATION_MS}ms`);
      hangupEvent = await asteriskService.waitForEvent('Hangup', (evt) => evt.Uniqueid === uniqueid, MAX_AGENT_CALL_DURATION_MS);
    } else {
      hangupEvent = raceResult.evt;
    }
  }

  if (!hangupEvent) {
    console.warn(`[Worker] Lead ${lead.lead_id}: answered but no Hangup event within the cap - freeing the slot anyway`);
  }

  const durationSec = Math.round((Date.now() - answeredAt) / 1000);
  await finalizeLead(lead.lead_id, lead.campaign_id, 'answered', durationSec, lead.tenant_id);
}

async function tick() {
  if (!asteriskService.isConnected) {
    return; // AMI connects during server startup; skip until it's up rather than burning leads
  }

  await reapStaleLeads();

  const [activeCount, maxConcurrent] = await Promise.all([getActiveProcessingCount(), getMaxConcurrentCalls()]);
  let freeSlots = maxConcurrent - activeCount;

  while (freeSlots > 0) {
    const lead = await claimNextPendingLead();
    if (!lead) break;

    // Fire-and-forget: dispatchLead tracks the call to completion asynchronously via AMI
    // events and does not block this loop, so free slots can keep filling up.
    dispatchLead(lead).catch((err) => {
      console.error(`[Worker] Unhandled error dispatching lead ${lead.lead_id}:`, err.message || err);
    });

    freeSlots--;
    if (freeSlots > 0 && DISPATCH_STAGGER_MS > 0) {
      await sleep(DISPATCH_STAGGER_MS);
    }
  }
}

async function startWorkerLoop() {
  console.log('[Worker] Event-driven campaign dialer started.');
  console.log(`[Worker] Asterisk AMI target: ${process.env.ASTERISK_AMI_HOST || '(default)'}:${process.env.ASTERISK_AMI_PORT || 5038}`);

  while (true) {
    try {
      await tick();
    } catch (error) {
      console.error('[Worker] Error in dialer tick:', error.message || error);
    }
    await sleep(POLL_INTERVAL_MS);
  }
}

// Postgres session-level advisory lock: guards against two backend processes (e.g. a stray
// manually-launched `node bulkCampaignWorker.js`, or two Render instances) both dialing off
// the same table at once. The lock is held for the process lifetime via a dedicated client
// that is never released back to the pool; Postgres frees it automatically if the process dies.
// Bumped from 727511: an orphaned process from an earlier broken two-process deployment
// (before the Start Command was fixed to run a single process) never released the old key,
// permanently blocking every subsequent deploy's worker from ever acquiring it. A fresh key
// means this deploy's worker doesn't contend with that zombie at all - the orphan can only
// ever hold the old key, which nothing else needs anymore.
const WORKER_LOCK_KEY = 727512;

async function acquireSingletonLock() {
  const client = await pool.connect();
  const result = await client.query('SELECT pg_try_advisory_lock($1) AS locked', [WORKER_LOCK_KEY]);
  if (!result.rows[0].locked) {
    client.release();
    return null;
  }
  return client;
}

// Retry wrapper around lock acquisition: a bare `await pool.connect()` failure here (e.g. a
// transient DB-connection hiccup during boot, which Render/Postgres cold starts are prone to)
// used to be an unhandled promise rejection that silently killed the worker forever - the HTTP
// server and AMI connection stayed healthy, /health kept reporting fine, but no lead was ever
// claimed again for the process's entire lifetime, with nothing surfacing the failure anywhere.
const LOCK_RETRY_DELAY_MS = 5000;

async function startWorkerWithRetry() {
  while (true) {
    try {
      const lockClient = await acquireSingletonLock();
      if (!lockClient) {
        // Someone else holds it right now - not a permanent state. A deploy overlap (old
        // instance still shutting down while the new one boots) resolves itself within
        // seconds once the old process dies and Postgres auto-releases its advisory lock,
        // so this must keep retrying rather than give up for the rest of this process's
        // lifetime (previously a `return` here meant a process that lost the race once at
        // boot would never dial another lead again, even after the lock became free).
        console.warn(`[Worker] Another process already holds the campaign dialer lock - retrying in ${LOCK_RETRY_DELAY_MS}ms`);
        await sleep(LOCK_RETRY_DELAY_MS);
        continue;
      }
      console.log('[Worker] Acquired singleton dialer lock.');
      await startWorkerLoop();
      return; // startWorkerLoop() only returns on an unexpected exit, not on normal ticks
    } catch (err) {
      console.error(`[Worker] Failed to acquire dialer lock (${err.message || err}) - retrying in ${LOCK_RETRY_DELAY_MS}ms`);
      await sleep(LOCK_RETRY_DELAY_MS);
    }
  }
}

if (global.isWorkerRunning) {
  console.log('[Worker] Duplicate worker start prevented (already running in this process).');
} else {
  global.isWorkerRunning = true;
  startWorkerWithRetry();
}
