import express from 'express';
import pool from '../config/database.js';
import { apiKeyAuth } from '../middleware/apiKeyAuth.js';
import asteriskService from '../services/asteriskService.js';
import DinstarService from '../services/dinstarService.js';
import { prefetchAudio } from '../services/remoteAudioService.js';
import { mapFailureReason } from '../bulkCampaignWorker.js';
import { normalizePhoneNumber } from '../utils/phoneNormalizer.js';
import { CC_MARKER } from '../services/callControlService.js';

// The public call-control API - the only endpoints an outside company ever sees.
//
// Kept in its own router on purpose. Everything here is reachable with a long-lived API key
// rather than a staff login, so folding these into the existing routers would make it far too
// easy to expose an internal endpoint by adding it to a file that happens to be mounted here.
//
// Contract: the client places a call, we call their webhook when it is answered, and each reply
// they give is the instruction for the next turn. See services/callControlService.js.

const router = express.Router();
const API_CALL_CONTEXT = process.env.API_CALL_CONTEXT || 'api-call-context';
const ORIGINATE_RESPONSE_TIMEOUT_MS = 60000;

router.use(apiKeyAuth);

function isHttpsUrl(value) {
  try {
    const u = new URL(value);
    return u.protocol === 'https:' || process.env.REMOTE_AUDIO_ALLOW_HTTP === 'true';
  } catch {
    return false;
  }
}

/**
 * POST /api/v1/calls - place a call.
 *
 * Returns as soon as the call is handed to the telephone system, BEFORE it is answered, because
 * that is what the client's integration expects: an id it can correlate webhooks against. The
 * outcome arrives later, on their status_url and via GET /api/v1/calls/{id}.
 */
router.post('/calls', async (req, res) => {
  const { to, answer_url: answerUrl, from, status_url: statusUrl } = req.body || {};

  if (!to || !answerUrl) {
    return res.status(400).json({ error: '"to" and "answer_url" are required' });
  }
  if (!isHttpsUrl(answerUrl) || (statusUrl && !isHttpsUrl(statusUrl))) {
    return res.status(400).json({ error: 'answer_url and status_url must be https URLs' });
  }
  const toNumber = normalizePhoneNumber(to);
  if (!toNumber) {
    return res.status(400).json({ error: `"${to}" is not a usable phone number` });
  }

  try {
    // Same guard as campaign creation: refuse before anything dials, rather than discovering an
    // empty balance halfway through a batch.
    const balance = await pool.query('SELECT credit_balance FROM tenants WHERE id = $1', [req.tenantId]);
    if ((balance.rows[0]?.credit_balance ?? 0) <= 0) {
      return res.status(402).json({ error: 'Insufficient credit balance' });
    }

    const inserted = await pool.query(`
      INSERT INTO api_calls (tenant_id, to_number, from_number, answer_url, status_url, status)
      VALUES ($1, $2, $3, $4, $5, 'queued') RETURNING id, status
    `, [req.tenantId, toNumber, from || null, answerUrl, statusUrl || null]);
    const call = inserted.rows[0];

    const { actionId, ackPromise } = asteriskService.originateAsync(
      `PJSIP/${toNumber}@DinstarTrunk`,
      toNumber,
      API_CALL_CONTEXT,
      1,
      { API_CALL_ID: call.id },
      from || 'VoiceAPI'
    );

    // Answered immediately - the caller gets their id now and the outcome later. Everything
    // below happens after the response has been sent.
    res.status(201).json({ call_id: call.id, status: 'queued', to: toNumber });

    ackPromise
      .then(async (ack) => {
        if (ack?.Response !== 'Success') {
          await pool.query(
            `UPDATE api_calls SET status='failed', hangup_cause='rejected', ended_at=NOW() WHERE id=$1`,
            [call.id]);
          return;
        }
        // If the callee answers, Asterisk enters Stasis and callControlService takes over from
        // here. This branch only records the outcomes where that never happens.
        const originate = await asteriskService.waitForEvent(
          'OriginateResponse', (evt) => evt.ActionID === actionId, ORIGINATE_RESPONSE_TIMEOUT_MS);

        if (!originate) {
          await pool.query(
            `UPDATE api_calls SET status='failed', hangup_cause='no_response', ended_at=NOW()
              WHERE id=$1 AND ended_at IS NULL`, [call.id]);
          return;
        }
        if (String(originate.Response) !== 'Success') {
          const status = mapFailureReason(originate.Reason);
          await pool.query(
            `UPDATE api_calls SET status=$2, hangup_cause=$3, ended_at=NOW()
              WHERE id=$1 AND ended_at IS NULL`,
            [call.id, status, `reason_${originate.Reason}`]);
        }
      })
      .catch(async (err) => {
        console.error(`[PublicApi] Originate failed for ${call.id}: ${err.message}`);
        await pool.query(
          `UPDATE api_calls SET status='failed', hangup_cause='originate_error', ended_at=NOW()
            WHERE id=$1 AND ended_at IS NULL`, [call.id]).catch(() => {});
      });
  } catch (err) {
    console.error('[PublicApi] POST /calls failed:', err.message);
    if (!res.headersSent) res.status(500).json({ error: 'Failed to place call' });
  }
});

/**
 * GET /api/v1/calls/:id - outcome of one call.
 *
 * Scoped by tenant_id as well as id, so a valid key for one client cannot read another client's
 * call by guessing an identifier. A call belonging to someone else is reported as not found.
 */
router.get('/calls/:id', async (req, res) => {
  try {
    const { rows } = await pool.query(`
      SELECT id AS call_id, to_number AS "to", from_number AS "from", status, duration,
             hangup_cause, created_at, answered_at, ended_at
        FROM api_calls WHERE id = $1 AND tenant_id = $2
    `, [req.params.id, req.tenantId]);

    if (!rows[0]) return res.status(404).json({ error: 'Call not found' });
    res.json(rows[0]);
  } catch (err) {
    console.error('[PublicApi] GET /calls/:id failed:', err.message);
    res.status(500).json({ error: 'Failed to read call' });
  }
});

/**
 * POST /api/v1/sms - send a text message.
 */
router.post('/sms', async (req, res) => {
  const { to, text } = req.body || {};
  if (!to || !text) {
    return res.status(400).json({ error: '"to" and "text" are required' });
  }
  const toNumber = normalizePhoneNumber(to);
  if (!toNumber) {
    return res.status(400).json({ error: `"${to}" is not a usable phone number` });
  }

  try {
    const dinstar = new DinstarService(
      process.env.DINSTAR_GATEWAY_IP, process.env.DINSTAR_API_USER, process.env.DINSTAR_API_PASS
    );
    const result = await dinstar.sendSms(String(text), toNumber);
    res.json({ status: 'sent', to: toNumber, reference: result.ref_id });
  } catch (err) {
    console.error('[PublicApi] POST /sms failed:', err.message);
    // 502, not 500: the failure is the SMS gateway's, and the distinction tells the client
    // whether retrying is worth anything.
    res.status(502).json({ error: `SMS gateway rejected the message: ${err.message}` });
  }
});

/**
 * POST /api/v1/audio/prefetch - warm the audio cache.
 *
 * Optional, but worth using. Asterisk can only play a local file, so the first play of any URL
 * has to download and convert it first - which happens mid-call, with the customer listening.
 * Prefetching the prompts a script uses moves that cost to before the call.
 *
 * Reports per-URL rather than failing the batch, so a client checking twenty prompts learns
 * exactly which one is broken.
 */
router.post('/audio/prefetch', async (req, res) => {
  const urls = req.body?.urls;
  if (!Array.isArray(urls) || urls.length === 0) {
    return res.status(400).json({ error: '"urls" must be a non-empty array' });
  }
  if (urls.length > 50) {
    return res.status(400).json({ error: 'At most 50 URLs per request' });
  }
  try {
    res.json({ results: await prefetchAudio(urls.map(String)) });
  } catch (err) {
    console.error('[PublicApi] prefetch failed:', err.message);
    res.status(500).json({ error: 'Prefetch failed' });
  }
});

void CC_MARKER; // imported so this router fails loudly if the engine module is ever removed

export default router;
