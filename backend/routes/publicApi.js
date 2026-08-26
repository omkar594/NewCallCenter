import express from 'express';
import pool from '../config/database.js';
import { apiKeyAuth } from '../middleware/apiKeyAuth.js';
import asteriskService from '../services/asteriskService.js';
import DinstarService from '../services/dinstarService.js';
import { prefetchAudio } from '../services/remoteAudioService.js';
import { mapFailureReason } from '../bulkCampaignWorker.js';
import { normalizePhoneNumber } from '../utils/phoneNormalizer.js';
import { CC_MARKER } from '../services/callControlService.js';
import { pickPortForTenant } from '../services/portRoutingService.js';

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

    // Choose the SIM port before dialling, so the number this call goes out on is known up front
    // rather than being whatever the gateway silently picked. The port is encoded as a dialling
    // prefix the gateway maps straight back to it.
    const port = await pickPortForTenant(req.tenantId);
    if (!port) {
      return res.status(409).json({
        error: 'No SIM lines are allocated to your account. Contact your account manager.'
      });
    }

    // from_number is the SIM's own number, not the caller-supplied `from`. On a GSM line the
    // network presents the SIM's number regardless of what caller ID we ask for, so reporting
    // anything else would be telling the client something untrue about their own call.
    const inserted = await pool.query(`
      INSERT INTO api_calls (tenant_id, to_number, from_number, port_number, answer_url, status_url, status)
      VALUES ($1, $2, $3, $4, $5, $6, 'queued') RETURNING id, status
    `, [req.tenantId, toNumber, port.simNumber, port.portNumber, answerUrl, statusUrl || null]);
    const call = inserted.rows[0];

    const { actionId, ackPromise } = asteriskService.originateAsync(
      `PJSIP/${port.prefix}${toNumber}@DinstarTrunk`,
      toNumber,
      API_CALL_CONTEXT,
      1,
      { API_CALL_ID: call.id },
      port.simNumber || 'VoiceAPI'
    );

    // Answered immediately - the caller gets their id now and the outcome later. Everything
    // below happens after the response has been sent.
    res.status(201).json({
      call_id: call.id,
      status: 'queued',
      to: toNumber,
      from: port.simNumber,
      port: port.portNumber
    });

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

// Shared date-range handling for the reporting endpoints. Both bounds are optional; `to` is
// treated as end-of-day so a single-day range (from = to) still matches everything in it, which
// is what someone asking for "today" means.
function dateRange(query) {
  const params = [];
  let where = '';
  if (query.from) { params.push(query.from); where += ` AND created_at >= $${params.length + 1}::date`; }
  if (query.to)   { params.push(query.to);   where += ` AND created_at < ($${params.length + 1}::date + interval '1 day')`; }
  return { where, params };
}

/**
 * GET /api/v1/calls - list calls, newest first.
 *
 * Filters: from, to (YYYY-MM-DD), status. Paginated with limit/offset.
 *
 * `duration` here - and everywhere in this API - is CONNECTED time only, measured from the
 * moment the callee answered to the moment the call ended. Ringing time is not included, and a
 * call that was never answered has a duration of zero rather than the time it spent ringing.
 */
router.get('/calls', async (req, res) => {
  const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 50, 1), 500);
  const offset = Math.max(parseInt(req.query.offset, 10) || 0, 0);
  const { where, params } = dateRange(req.query);

  const filters = [...params];
  let statusFilter = '';
  if (req.query.status) {
    filters.push(req.query.status);
    statusFilter = ` AND status = $${filters.length + 1}`;
  }

  try {
    const rows = await pool.query(`
      SELECT id AS call_id, to_number AS "to", from_number AS "from", port_number AS port,
             status, duration, hangup_cause, created_at, answered_at, ended_at
        FROM api_calls
       WHERE tenant_id = $1 ${where} ${statusFilter}
       ORDER BY created_at DESC
       LIMIT ${limit} OFFSET ${offset}
    `, [req.tenantId, ...filters]);

    const count = await pool.query(
      `SELECT count(*)::int AS n FROM api_calls WHERE tenant_id = $1 ${where} ${statusFilter}`,
      [req.tenantId, ...filters]
    );

    res.json({
      total: count.rows[0].n,
      limit,
      offset,
      calls: rows.rows
    });
  } catch (err) {
    console.error('[PublicApi] GET /calls failed:', err.message);
    res.status(500).json({ error: 'Failed to list calls' });
  }
});

/**
 * GET /api/v1/reports/summary - totals for a period.
 *
 * Answers the two questions a client actually asks at the end of a month: how many calls did we
 * place, and how long were we actually talking to people.
 */
router.get('/reports/summary', async (req, res) => {
  const { where, params } = dateRange(req.query);
  try {
    const { rows } = await pool.query(`
      SELECT
        count(*)::int                                                       AS total,
        -- "Answered" means the person actually picked up, which is answered_at being set - NOT
        -- that the call finished cleanly. A call the callee answered and which then ended on a
        -- webhook error was still answered; counting only 'completed' here would report it as
        -- unreached and understate what the client's list actually achieved.
        count(*) FILTER (WHERE answered_at IS NOT NULL)::int                 AS answered,
        count(*) FILTER (WHERE status = 'completed')::int                    AS completed,
        count(*) FILTER (WHERE status = 'busy')::int                        AS busy,
        count(*) FILTER (WHERE status = 'no-answer')::int                   AS no_answer,
        count(*) FILTER (WHERE status = 'failed')::int                      AS failed,
        count(*) FILTER (WHERE status IN ('queued','answered'))::int        AS in_progress,
        -- Connected time, for every call where somebody actually picked up. duration is measured
        -- from answer to hang-up, so ringing is already excluded and a call that never connected
        -- contributes zero.
        COALESCE(sum(duration) FILTER (WHERE answered_at IS NOT NULL), 0)::int  AS total_seconds,
        COALESCE(max(duration) FILTER (WHERE answered_at IS NOT NULL), 0)::int  AS longest_seconds,
        COALESCE(round(avg(duration) FILTER (WHERE answered_at IS NOT NULL)), 0)::int AS average_seconds,
        -- Billing counts only calls that finished cleanly, so this can be lower than total_seconds.
        -- Surfacing both stops the client reconciling their usage against an invoice and finding
        -- a gap they cannot explain.
        COALESCE(sum(duration) FILTER (WHERE status = 'completed'), 0)::int  AS billable_seconds
      FROM api_calls
      WHERE tenant_id = $1 ${where}
    `, [req.tenantId, ...params]);

    const r = rows[0];
    const attempted = r.total - r.in_progress;

    res.json({
      period: { from: req.query.from || null, to: req.query.to || null },
      calls: {
        total: r.total,
        answered: r.answered,
        completed: r.completed,
        busy: r.busy,
        no_answer: r.no_answer,
        failed: r.failed,
        in_progress: r.in_progress
      },
      // Share of finished attempts that were actually answered - the number that tells you
      // whether a list is any good. Calls still in progress are excluded so it does not dip
      // while a batch is running.
      answer_rate: attempted > 0 ? Math.round((r.answered / attempted) * 1000) / 1000 : null,
      talk_time: {
        total_seconds: r.total_seconds,
        total_minutes: Math.round((r.total_seconds / 60) * 10) / 10,
        average_seconds: r.average_seconds,
        longest_seconds: r.longest_seconds,
        billable_seconds: r.billable_seconds
      },
      note: 'Durations are connected talk time, measured from the moment the callee answered to the moment the call ended. Ringing is never included, and a call that was never answered counts as zero. "answered" means the callee picked up, however the call later ended; "billable_seconds" counts only calls that finished cleanly and may therefore be lower than total_seconds.'
    });
  } catch (err) {
    console.error('[PublicApi] GET /reports/summary failed:', err.message);
    res.status(500).json({ error: 'Failed to build summary' });
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
      SELECT id AS call_id, to_number AS "to", from_number AS "from", port_number AS port,
             status, duration, hangup_cause, created_at, answered_at, ended_at
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
