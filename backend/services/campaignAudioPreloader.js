import pool from '../config/database.js';
import { synthesizeAndDeliver, hasVariablePlaceholders } from './ttsService.js';

// Only fully static prompt_text can be pre-synthesized - a node whose text contains a
// {{variable}} placeholder (e.g. {{provider_name}}) depends on a value only known once a
// lookup/collect_input node runs mid-call, so those keep synthesizing lazily on first real
// occurrence exactly as before this file existed (still cached by ttsService.js after that).
async function getStaticPromptTexts(flowId) {
  const result = await pool.query(
    `SELECT DISTINCT prompt_text FROM ivr_nodes WHERE flow_id = $1 AND prompt_text IS NOT NULL`,
    [flowId]
  );
  return result.rows
    .map((r) => r.prompt_text)
    .filter((text) => !hasVariablePlaceholders(text));
}

// Pre-synthesizes every static prompt for every language the campaign's leads actually use,
// BEFORE the worker is allowed to dial anyone - bulkCampaignWorker.js's claimNextPendingLead()
// only claims leads whose campaign status is 'running'/'pending', so a campaign sitting in
// 'preparing' (set by campaignController.js at creation time, for any IVR-flow campaign) is
// simply not dialable yet. Without this, the first live call to hit a never-before-spoken
// phrase pays the full synthesis cost (SSH to the box, run Piper, SSH again to deliver the
// file) live, on a real ringing call - confirmed ~20s on this project. This moves that cost
// up front instead, once per (phrase, language) pair, not once per call.
export async function prepareCampaignAudio(campaignId, flowId) {
  try {
    const [staticTexts, langResult] = await Promise.all([
      getStaticPromptTexts(flowId),
      pool.query(`SELECT DISTINCT language_code FROM campaign_leads WHERE campaign_id = $1`, [campaignId])
    ]);
    const languages = langResult.rows.map((r) => r.language_code).filter(Boolean);

    console.log(`[AudioPreloader] Campaign ${campaignId}: pre-synthesizing ${staticTexts.length} prompt(s) x ${languages.length} language(s)`);

    for (const languageCode of languages) {
      for (const text of staticTexts) {
        try {
          await synthesizeAndDeliver(text, { languageCode });
        } catch (err) {
          // Best-effort: one bad phrase/language combo (e.g. an unconfigured voice model)
          // shouldn't leave the whole campaign stuck in 'preparing' forever - a call that
          // actually reaches this node just pays the synthesis cost live instead, same
          // failure mode as before this file existed.
          console.error(`[AudioPreloader] Failed to pre-synthesize (lang=${languageCode}): ${err.message}`);
        }
      }
    }
  } catch (err) {
    console.error(`[AudioPreloader] Campaign ${campaignId} preload failed: ${err.message}`);
  } finally {
    // Only flip the status this function itself is responsible for advancing - WHERE status =
    // 'preparing' guards against clobbering a status some other action set out from under us
    // while preload was still in flight (e.g. a tenant deactivation cancelling this campaign).
    // An unconditional UPDATE here previously could silently undo that kind of change moments
    // after it happened.
    const result = await pool.query(
      `UPDATE voice_campaigns SET status = 'running', updated_at = NOW() WHERE id = $1 AND status = 'preparing'`,
      [campaignId]
    );
    if (result.rowCount > 0) {
      console.log(`[AudioPreloader] Campaign ${campaignId} is now running.`);
    } else {
      console.log(`[AudioPreloader] Campaign ${campaignId} was no longer 'preparing' (status changed elsewhere) - leaving it as-is.`);
    }
  }
}
