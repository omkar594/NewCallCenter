import asteriskService from './asteriskService.js';
import pool from '../config/database.js';

// Listens for the campaign dialplan's UserEvent() markers (see telephony_config/extensions.conf)
// and records them onto campaign_leads for reporting. Kept separate from bulkCampaignWorker.js
// so the worker's dispatch/timeout logic doesn't grow unrelated responsibilities - the one
// overlap is 'AgentTransferStart', which the worker ALSO listens for directly (via
// asteriskService.waitForEvent) to switch to the longer post-transfer call-duration timeout;
// this listener's handling of the same event here is purely for the campaign_leads reporting
// column, not for concurrency/timeout logic.
//
// Asterisk's UserEvent(Name,Key: Value,Key2: Value2) dialplan app arrives over AMI as
// Event=UserEvent, UserEvent=Name, plus each Key as its own top-level field on the event object
// (asteriskService's generic _processBuffer() already emits raw AMI events by their Event name).
asteriskService.on('UserEvent', async (evt) => {
  try {
    if (evt.UserEvent === 'AMDResult' && evt.LeadId) {
      await pool.query(
        `UPDATE campaign_leads SET amd_status = $1, updated_at = NOW() WHERE id = $2`,
        [evt.Status || null, evt.LeadId]
      );
    } else if (evt.UserEvent === 'AgentTransferStart' && evt.LeadId) {
      // Digit 1 is unconditionally "transfer to agent" in the classic (non-flow) dialplan's
      // fixed menu (extensions.conf's exten => 1,1) - this label is accurate as long as that
      // stays true, with no flow/branch config to read one from the way flow campaigns have.
      await pool.query(
        `UPDATE campaign_leads SET dtmf_selected = '1', dtmf_label = 'Transferred to Agent', updated_at = NOW() WHERE id = $1`,
        [evt.LeadId]
      );
    }
  } catch (err) {
    console.error('[CampaignTelemetry] Failed to record UserEvent:', err.message);
  }
});

console.log('[CampaignTelemetry] Listening for dialplan UserEvents (AMD/DTMF markers).');
