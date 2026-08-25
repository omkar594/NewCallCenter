import axios from 'axios';
import pool from '../config/database.js';
import ariService from './ariService.js';
import { getPlayableMedia } from './remoteAudioService.js';
import { creditsForDuration } from '../utils/creditCalculator.js';

// Runs a call whose conversation lives in the CLIENT's system, not ours.
//
// This is the mirror image of ivrFlowEngine.js. That engine reads the next step from our own
// database; this one asks the client's webhook, plays whatever they answer with, reports what
// happened, and asks again - until they say hang up. Same ARI primitives underneath, opposite
// direction of control.
//
// Both engines share one Stasis application and therefore one WebSocket, so each has to ignore
// what is not its own. The dialplan tags a call-control call with 'cc' as the first Stasis
// argument; ivrFlowEngine returns early on that marker and this file returns early without it.

export const CC_MARKER = 'cc';

const WEBHOOK_TIMEOUT_MS = parseInt(process.env.API_WEBHOOK_TIMEOUT_MS, 10) || 5000;
// A live caller is on the line while we wait, so the ceiling is deliberately low: better to end
// the call politely than to hold someone in silence while a client's server thinks.
const MAX_TURNS = parseInt(process.env.API_CALL_MAX_TURNS, 10) || 100;
// Stock Asterisk sound, present on any install - a fallback that itself fails to play would
// leave exactly the dead air this exists to prevent.
const FALLBACK_MEDIA = process.env.API_CALL_FALLBACK_MEDIA || 'sound:vm-goodbye';

const activeCalls = new Map(); // channelId -> { apiCallId, tenantId }

function isAllowedWebhookUrl(value) {
  try {
    const u = new URL(value);
    return u.protocol === 'https:' || process.env.REMOTE_AUDIO_ALLOW_HTTP === 'true';
  } catch {
    return false;
  }
}

async function loadCall(apiCallId) {
  const { rows } = await pool.query(
    `SELECT id, tenant_id, to_number, from_number, answer_url, status_url, status
       FROM api_calls WHERE id = $1`, [apiCallId]
  );
  return rows[0] || null;
}

/**
 * Asks the client what to do next. Their reply IS the instruction.
 *
 * Returns null on anything unusable - timeout, non-2xx, or a body that is not an object. The
 * caller treats null as "end the call politely", which is the documented behaviour for a slow or
 * broken webhook.
 */
async function askClient(url, payload) {
  // next_url comes back inside a webhook response, so unlike answer_url it never passed through
  // the validation on POST /api/v1/calls. Holding it to the same standard stops a key-holder
  // walking us onto http:// or an internal address one turn into the call.
  if (!isAllowedWebhookUrl(url)) {
    console.warn(`[CallControl] Refusing to call "${url}" - webhook URLs must be https`);
    return null;
  }
  try {
    const res = await axios.post(url, payload, {
      timeout: WEBHOOK_TIMEOUT_MS,
      maxRedirects: 0,
      headers: { 'Content-Type': 'application/json' },
      validateStatus: (s) => s >= 200 && s < 300
    });
    if (!res.data || typeof res.data !== 'object' || Array.isArray(res.data)) {
      console.warn(`[CallControl] ${url} returned a non-object body - ending call`);
      return null;
    }
    return res.data;
  } catch (err) {
    console.warn(`[CallControl] ${url} failed (${err.message}) - ending call`);
    return null;
  }
}

/**
 * Carries out one instruction and returns what to report back.
 *
 * `play` alone plays to completion. `play` + `gather` plays interruptibly, so a caller who
 * already knows the answer can press a key without sitting through the whole prompt - the same
 * behaviour a person expects from any phone menu.
 */
async function runInstruction(instruction, channelId) {
  const gather = instruction.gather;
  let digits = null;

  if (instruction.play) {
    const media = await getPlayableMedia(instruction.play);
    const playback = await ariService.playMedia(channelId, media);

    if (gather) {
      digits = await ariService.gatherDigits(channelId, {
        maxDigits: parseInt(gather.num_digits, 10) || 1,
        terminator: gather.terminator ?? null,
        firstDigitTimeoutMs: (parseInt(gather.timeout, 10) || 6) * 1000,
        interDigitTimeoutMs: (parseInt(gather.timeout, 10) || 6) * 1000
      });
      // Awaited, not fired and forgotten: starting the next playback while this one is still
      // being torn down makes the caller hear both at once.
      if (digits) await ariService.stopPlayback(playback.id).catch(() => {});
    } else {
      await ariService.waitForEvent(
        'PlaybackFinished', (evt) => evt.playback?.id === playback.id, 60000
      );
    }
  } else if (gather) {
    digits = await ariService.gatherDigits(channelId, {
      maxDigits: parseInt(gather.num_digits, 10) || 1,
      terminator: gather.terminator ?? null,
      firstDigitTimeoutMs: (parseInt(gather.timeout, 10) || 6) * 1000,
      interDigitTimeoutMs: (parseInt(gather.timeout, 10) || 6) * 1000
    });
  }

  return gather
    ? { event: 'gather', digits: digits || '' }
    : { event: 'play_complete' };
}

/**
 * Closes the call out: duration, billing and the final webhook.
 *
 * Credit deduction reuses creditsForDuration() unchanged, so a call placed through this API is
 * billed on exactly the same rule as a campaign call - the client simply never sees the balance.
 */
async function finishCall(apiCallId, status, hangupCause = null) {
  try {
    const { rows } = await pool.query(`
      UPDATE api_calls
         SET status = $2,
             hangup_cause = COALESCE($3, hangup_cause),
             ended_at = NOW(),
             duration = CASE WHEN answered_at IS NOT NULL
                             THEN GREATEST(0, EXTRACT(EPOCH FROM (NOW() - answered_at))::int)
                             ELSE 0 END
       WHERE id = $1 AND ended_at IS NULL
      RETURNING tenant_id, to_number, duration, status, status_url, hangup_cause
    `, [apiCallId, status, hangupCause]);

    const call = rows[0];
    if (!call) return; // already finalised - a hangup race, not an error

    const credits = status === 'completed' ? creditsForDuration(call.duration) : 0;
    if (credits > 0) {
      await pool.query(
        'UPDATE tenants SET credit_balance = credit_balance - $1 WHERE id = $2',
        [credits, call.tenant_id]
      );
      await pool.query(`
        INSERT INTO credit_transactions (tenant_id, type, amount, balance_after)
        SELECT $1, 'deduction', $2, credit_balance FROM tenants WHERE id = $1
      `, [call.tenant_id, -credits]).catch((e) =>
        console.error('[CallControl] Failed to log credit transaction:', e.message));
    }

    if (call.status_url) {
      // Best effort. The call is already over and billed; a client whose status endpoint is down
      // can still read the outcome from GET /api/v1/calls/{id}.
      axios.post(call.status_url, {
        call_id: apiCallId,
        event: 'completed',
        status: call.status,
        to: call.to_number,
        duration: call.duration,
        // Explicit null rather than undefined: JSON.stringify drops undefined keys entirely, so
        // a client coding against a documented field would simply never see it. This field was
        // missing from the RETURNING clause above and therefore never reached anyone - worst of
        // all on a failed call, which is exactly when the client needs to know the reason.
        hangup_cause: call.hangup_cause ?? null
      }, { timeout: WEBHOOK_TIMEOUT_MS, maxRedirects: 0 })
        .catch((err) => console.warn(`[CallControl] status_url failed: ${err.message}`));
    }
  } catch (err) {
    console.error(`[CallControl] finishCall(${apiCallId}) failed:`, err.message);
  }
}

async function runCall(channelId, apiCallId) {
  const call = await loadCall(apiCallId);
  if (!call) {
    console.error(`[CallControl] Unknown api_call ${apiCallId} - hanging up`);
    await ariService.hangupChannel(channelId).catch(() => {});
    return;
  }

  activeCalls.set(channelId, { apiCallId, tenantId: call.tenant_id });
  await ariService.answerChannel(channelId);
  await pool.query(
    `UPDATE api_calls SET status = 'answered', answered_at = NOW(), channel_id = $2 WHERE id = $1`,
    [apiCallId, channelId]
  );

  let url = call.answer_url;
  let payload = {
    call_id: apiCallId,
    event: 'answered',
    from: call.from_number,
    to: call.to_number
  };

  let turns = 0;
  let ended = false;

  try {
    while (url && turns < MAX_TURNS) {
      turns++;
      const instruction = await askClient(url, payload);

      // No usable answer, or an explicit hangup. Both end the call; only the first is a problem,
      // and askClient has already logged which it was.
      if (!instruction || instruction.hangup) {
        if (!instruction) {
          await ariService.playMedia(channelId, FALLBACK_MEDIA).catch(() => {});
          await ariService.hangupChannel(channelId).catch(() => {});
          activeCalls.delete(channelId);
          await finishCall(apiCallId, 'failed', 'webhook_error');
          return;
        }
        break;
      }

      const result = await runInstruction(instruction, channelId);
      if (!instruction.next_url) { ended = true; break; }
      url = instruction.next_url;
      payload = { call_id: apiCallId, to: call.to_number, ...result };
    }

    if (turns >= MAX_TURNS) {
      console.error(`[CallControl] Call ${apiCallId} hit the ${MAX_TURNS}-turn cap - the client's webhooks are looping`);
    }
    void ended;
    await ariService.hangupChannel(channelId).catch(() => {});
    activeCalls.delete(channelId);
    await finishCall(apiCallId, 'completed');
  } catch (err) {
    // Most often the caller simply hung up and the channel vanished mid-instruction, which is a
    // normal ending rather than a fault - so it is recorded as completed and still billed for
    // the time that genuinely connected.
    const hungUp = /channel not found|404/i.test(err.message || '');
    console[hungUp ? 'log' : 'error'](
      `[CallControl] Call ${apiCallId} ended: ${err.message}`
    );
    await ariService.hangupChannel(channelId).catch(() => {});
    activeCalls.delete(channelId);
    await finishCall(apiCallId, hungUp ? 'completed' : 'failed', hungUp ? 'caller_hangup' : 'engine_error');
  }
}

ariService.on('StasisStart', (evt) => {
  const args = evt.args || [];
  if (args[0] !== CC_MARKER) return; // an IVR-flow call - ivrFlowEngine.js owns it
  const channelId = evt.channel?.id;
  const apiCallId = args[1];
  if (!channelId || !apiCallId) {
    console.error(`[CallControl] StasisStart with no channel/callId (args=${JSON.stringify(args)})`);
    if (channelId) ariService.hangupChannel(channelId).catch(() => {});
    return;
  }
  runCall(channelId, apiCallId).catch((err) => {
    console.error(`[CallControl] Unhandled failure on channel ${channelId}: ${err.message}`);
    ariService.hangupChannel(channelId).catch(() => {});
    activeCalls.delete(channelId);
  });
});

console.log('[CallControl] Listening for StasisStart on the public call-control API.');
