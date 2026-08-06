import { executeTenantQuery } from '../config/database.js';
import pool from '../config/database.js';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { parse as parseCsv } from 'csv-parse/sync';
import { transcodeCampaignAudio } from '../services/audioTranscoder.js';
import { deliverCampaignAudio } from '../services/audioDeliveryService.js';
import { normalizePhoneNumber } from '../utils/phoneNormalizer.js';
import { prepareCampaignAudio } from '../services/campaignAudioPreloader.js';

const PHONE_HEADER_ALIASES = ['phone', 'phone_number', 'phonenumber', 'number', 'mobile', 'msisdn'];
const NAME_HEADER_ALIASES = ['name', 'customer_name', 'customername', 'full_name'];
// Workstream 9: lets a client tag each lead with its own language in the same CSV, so one IVR
// flow speaks correctly to every customer - see campaign_leads.language_code / ivrFlowEngine.js.
const LANGUAGE_HEADER_ALIASES = ['language', 'language_code', 'lang'];
const DEFAULT_LEAD_LANGUAGE_CODE = 'en-US';
// Same default every other write path in this backend falls back to when a caller (e.g.
// super_admin, whose JWT tenant_id already points at this same default) doesn't have a distinct
// tenant of their own - matches ivrController.js's DEFAULT_TENANT_ID.
const DEFAULT_TENANT_ID = 'a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11';
// PostgreSQL's wire protocol caps bound parameters at 65535 per query (an unsigned 16-bit
// count field, not a config value). Each lead contributes 3 params (phone, name, language)
// on top of the shared campaign_id - a single INSERT stopped working above ~21,844 leads,
// which broke real bulk campaigns (e.g. a 100k-row CSV) outright. 5000 leads/batch keeps
// every batch at 15,001 params, comfortably under the limit.
const LEAD_INSERT_BATCH_SIZE = 5000;

// Workstream 9: campaigns are now scoped to the authenticated caller's own tenant_id, closing
// the gap where every campaign previously landed under one shared default tenant regardless of
// who created it - flows/lookup-tables were already isolated this way (ivrController.js), this
// makes campaigns match.
function resolveTenantId(req) {
  return req.user?.tenant_id || DEFAULT_TENANT_ID;
}

// Parses a lead CSV using its header row (quote/escape-aware), instead of assuming
// column position, so "name,phone" and "phone,name" files both work correctly.
function parseLeadsCsv(csvContent) {
  const records = parseCsv(csvContent, {
    columns: (header) => header.map(h => h.trim().toLowerCase()),
    skip_empty_lines: true,
    trim: true,
    relax_column_count: true
  });

  const leads = [];
  for (const record of records) {
    const phoneKey = PHONE_HEADER_ALIASES.find(k => record[k]);
    const nameKey = NAME_HEADER_ALIASES.find(k => record[k]);
    const languageKey = LANGUAGE_HEADER_ALIASES.find(k => record[k]);
    const phoneNumber = phoneKey ? String(record[phoneKey]).trim() : '';
    if (!phoneNumber) continue;
    leads.push({
      phoneNumber,
      customerName: nameKey ? String(record[nameKey]).trim() : 'Valued Customer',
      languageCode: languageKey ? String(record[languageKey]).trim() : DEFAULT_LEAD_LANGUAGE_CODE
    });
  }
  return leads;
}

// Inserts every lead in batches of LEAD_INSERT_BATCH_SIZE, all within ONE transaction (a
// dedicated client, not executeTenantQuery - that helper opens/commits its own transaction per
// call, which would make a multi-batch insert only partially atomic). set_config() replicates
// executeTenantQuery's RLS tenant-context setup inside this same transaction, since we're
// bypassing that helper. If any batch fails, everything rolls back - the caller never ends up
// with a campaign row claiming e.g. 100,000 total_leads while only 40,000 actually landed.
async function insertCampaignLeads(campaignId, leads, tenantId) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    if (tenantId) {
      await client.query('SELECT set_config(\'app.current_tenant_id\', $1, true)', [tenantId]);
    } else {
      await client.query('SELECT set_config(\'app.current_tenant_id\', \'\', true)');
    }

    for (let offset = 0; offset < leads.length; offset += LEAD_INSERT_BATCH_SIZE) {
      const batch = leads.slice(offset, offset + LEAD_INSERT_BATCH_SIZE);
      const valuesSql = batch.map((_, i) => {
        const base = i * 3;
        return `($1, $${base + 2}, $${base + 3}, $${base + 4}, 'pending')`;
      }).join(', ');
      const params = [campaignId];
      for (const lead of batch) {
        params.push(lead.phoneNumber, lead.customerName, lead.languageCode || DEFAULT_LEAD_LANGUAGE_CODE);
      }
      await client.query(`
        INSERT INTO campaign_leads (campaign_id, phone_number, customer_name, language_code, dial_status)
        VALUES ${valuesSql}
      `, params);
    }

    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

// Webhook for Asterisk dialplan to report voice campaign call status updates.
// Moved here (and mounted before '/:id' in routes/campaign.js) to fix a route-shadowing
// bug where Express matched this as GET /api/campaigns/:id with id='callback'.
export async function handleCampaignCallback(req, res) {
  const { leadId, status, duration } = req.query;

  if (!leadId || !status) {
    return res.status(400).send('Missing leadId or status');
  }

  try {
    await pool.query(`
      UPDATE campaign_leads
      SET dial_status = $1, call_duration = $2, updated_at = NOW()
      WHERE id = $3
    `, [status, parseInt(duration) || 0, leadId]);

    console.log(`[Campaign Callback] Lead ID: ${leadId} status updated to: ${status}`);
    res.send('OK');
  } catch (error) {
    console.error('[Campaign Callback] Database update failed:', error.message);
    res.status(500).send(error.message);
  }
}

// Workstream 7: hit via CURL() from the dialplan's DTMF-9 branch. Must respond fast - the
// caller's channel is blocked on this CURL() before it can play the confirmation prompt and
// hang up, so func_curl's timeout option on the dialplan side is what protects the caller if
// this endpoint is ever slow/unreachable, not anything here.
export async function handleOptOutWebhook(req, res) {
  const { leadId, phone } = req.query;

  if (!phone) {
    return res.status(400).send('Missing phone');
  }

  const normalized = normalizePhoneNumber(phone);

  try {
    await pool.query(`
      INSERT INTO dnc_numbers (phone_number, source_lead_id)
      VALUES ($1, $2)
      ON CONFLICT (phone_number) DO NOTHING
    `, [normalized, leadId || null]);

    if (leadId) {
      await pool.query(`
        UPDATE campaign_leads SET dial_status = 'opted_out', updated_at = NOW() WHERE id = $1
      `, [leadId]);
    }

    console.log(`[Opt-Out] ${normalized} added to do-not-call list (lead ${leadId || 'n/a'})`);
    res.send('OK');
  } catch (error) {
    console.error('[Opt-Out] Failed to record opt-out:', error.message);
    res.status(500).send(error.message);
  }
}

// 1. Get list of all campaigns with progress metrics
export async function getCampaigns(req, res) {
  try {
    const result = await executeTenantQuery(null, `
      SELECT
        vc.id,
        vc.name,
        vc.audio_url,
        vc.status,
        vc.allowed_ports,
        vc.total_leads,
        vc.processed_leads,
        vc.created_at,
        COUNT(CASE WHEN cl.dial_status = 'answered' THEN 1 END) AS answered_count,
        COUNT(CASE WHEN cl.dial_status = 'busy' THEN 1 END) AS busy_count,
        COUNT(CASE WHEN cl.dial_status = 'no-answer' THEN 1 END) AS no_answer_count,
        COUNT(CASE WHEN cl.dial_status = 'failed' THEN 1 END) AS failed_count,
        COUNT(CASE WHEN cl.dial_status = 'processing' THEN 1 END) AS processing_count,
        COUNT(CASE WHEN cl.dial_status = 'pending' THEN 1 END) AS pending_count
      FROM voice_campaigns vc
      LEFT JOIN campaign_leads cl ON vc.id = cl.campaign_id
      WHERE vc.tenant_id = $1
      GROUP BY vc.id
      ORDER BY vc.created_at DESC
    `, [resolveTenantId(req)]);
    res.json(result.rows);
  } catch (error) {
    console.error('[CampaignController] getCampaigns failed:', error);
    res.status(500).json({ error: 'Failed to retrieve campaigns' });
  }
}

// 2. Get detailed campaign status report (Connected vs Failed breakdown)
export async function getCampaignReport(req, res) {
  const { id } = req.params;
  try {
    // tenant_id filter here means a wrong-tenant id 404s exactly like a nonexistent one -
    // matches ivrController.js's getFlow(), no separate "forbidden" leak distinguishing
    // "doesn't exist" from "exists but isn't yours".
    const campaignResult = await executeTenantQuery(null, `
      SELECT * FROM voice_campaigns WHERE id = $1 AND tenant_id = $2
    `, [id, resolveTenantId(req)]);

    if (campaignResult.rows.length === 0) {
      return res.status(404).json({ error: 'Campaign not found' });
    }

    const campaign = campaignResult.rows[0];

    const leadsResult = await executeTenantQuery(null, `
      SELECT id, phone_number, customer_name, dial_status, attempts, call_duration, updated_at
      FROM campaign_leads
      WHERE campaign_id = $1
      ORDER BY updated_at DESC
    `, [id]);

    const leads = leadsResult.rows;
    const metrics = {
      total: leads.length,
      answered: leads.filter(l => l.dial_status === 'answered').length,
      busy: leads.filter(l => l.dial_status === 'busy').length,
      noAnswer: leads.filter(l => l.dial_status === 'no-answer').length,
      failed: leads.filter(l => l.dial_status === 'failed').length,
      processing: leads.filter(l => l.dial_status === 'processing').length,
      pending: leads.filter(l => l.dial_status === 'pending').length
    };

    res.json({
      campaign,
      metrics,
      leads
    });
  } catch (error) {
    console.error('[CampaignController] getCampaignReport failed:', error);
    res.status(500).json({ error: 'Failed to fetch campaign report' });
  }
}

// 3. Initiate Bulk Outbound Voice Broadcast (Supports JSON payloads OR Multipart Form-Data)
export async function createBroadcastCampaign(req, res) {
  const { name, allowedPorts, phoneNumbers, audioBase64, ivrFlowId } = req.body;

  if (!name) {
    return res.status(400).json({ error: 'Campaign name is required' });
  }

  // Audio prompt input check (Supports file upload OR Base64 JSON).
  // Note: an earlier "audioUrl"/"audioPath" option that fed an unauthenticated client-supplied
  // filesystem path straight into ffmpeg (arbitrary local file read) was removed - see plan Workstream 1.
  const audioFile = req.files?.broadcastAudio?.[0] || req.files?.audioFile?.[0] || req.files?.audio?.[0] || req.files?.file?.[0] || null;

  // Workstream 9: an IVR-flow campaign gets its prompts from the flow itself (uploads/prompt_text
  // per node) - a placeholder audio file here would only ever be dead weight, and requiring one
  // just to satisfy this endpoint was actively misleading during testing (nothing plays it, but
  // its presence looks meaningful). Only the classic single-prompt path still requires real audio.
  if (!ivrFlowId && !audioFile && !audioBase64) {
    return res.status(400).json({
      error: 'Audio prompt is required. Pass audioFile / broadcastAudio file OR audioBase64 string (unless ivrFlowId is set)'
    });
  }

  const csvFile = req.files?.leadsCsv?.[0] || req.files?.csv?.[0] || null;

  // Extract phone numbers from CSV file OR manual phoneNumbers input
  let leads = [];

  if (csvFile) {
    const csvContent = fs.readFileSync(csvFile.path, 'utf8');
    try {
      leads = parseLeadsCsv(csvContent);
    } catch (err) {
      return res.status(400).json({ error: `Invalid CSV file: ${err.message}` });
    }
  }

  if (phoneNumbers) {
    let rawNumbers = [];
    if (Array.isArray(phoneNumbers)) {
      rawNumbers = phoneNumbers;
    } else if (typeof phoneNumbers === 'string') {
      try {
        const parsed = JSON.parse(phoneNumbers);
        rawNumbers = Array.isArray(parsed) ? parsed : phoneNumbers.split(/[\n,]+/);
      } catch (e) {
        rawNumbers = phoneNumbers.split(/[\n,]+/);
      }
    }

    for (const entry of rawNumbers) {
      // Workstream 9: each entry may be a bare phone-number string (unchanged) or
      // {phoneNumber, customerName, languageCode} for callers who want to tag a language
      // without going through a CSV upload.
      const isObject = entry && typeof entry === 'object';
      const cleanNum = String(isObject ? entry.phoneNumber : entry).trim();
      if (cleanNum && !leads.some(l => l.phoneNumber === cleanNum)) {
        leads.push({
          phoneNumber: cleanNum,
          customerName: (isObject && entry.customerName) ? String(entry.customerName).trim() : 'Contact',
          languageCode: (isObject && entry.languageCode) ? String(entry.languageCode).trim() : DEFAULT_LEAD_LANGUAGE_CODE
        });
      }
    }
  }

  if (leads.length === 0) {
    return res.status(400).json({ error: 'No valid target phone numbers provided (upload leadsCsv or pass phoneNumbers in JSON)' });
  }

  // Workstream 7: drop any number that opted out (DTMF 9) in a previous campaign, checked
  // before any transcode/SFTP work happens so a fully-opted-out upload fails fast. Uses the
  // SAME normalizePhoneNumber() the dialplan's opt-out webhook writes with, and the worker
  // dials with, so a number written as "+919876543210" here still matches one opted out as
  // a bare "9876543210" (or vice versa) - matching normalization everywhere is what makes
  // this list actually enforceable rather than just occasionally effective.
  let excludedDncCount = 0;
  {
    const normalizedToLead = new Map();
    for (const lead of leads) {
      normalizedToLead.set(normalizePhoneNumber(lead.phoneNumber), lead);
    }
    const dncResult = await executeTenantQuery(null,
      `SELECT phone_number FROM dnc_numbers WHERE phone_number = ANY($1)`,
      [[...normalizedToLead.keys()]]
    );
    for (const row of dncResult.rows) {
      normalizedToLead.delete(row.phone_number);
    }
    excludedDncCount = leads.length - normalizedToLead.size;
    leads = [...normalizedToLead.values()];
  }

  if (leads.length === 0) {
    return res.status(400).json({
      error: 'No valid target phone numbers provided (upload leadsCsv or pass phoneNumbers in JSON)',
      excludedDncCount
    });
  }

  // Workstream 9: a campaign can only ever request SIM ports actually allocated to the
  // caller's own tenant (gateway_ports.tenant_id, assigned via POST /api/gateways/ports/allocate)
  // - previously allowedPorts was whatever the caller typed, completely unchecked. A tenant with
  // NO explicit allocation on file is unrestricted (today's 'all' behavior) - the restriction
  // only activates once a super_admin has actually assigned specific ports to that tenant, so
  // this never breaks an unconfigured client or the platform's own default tenant retroactively.
  let parsedPorts = 'all';
  try {
    const portsTenantId = resolveTenantId(req);
    const allocatedResult = await executeTenantQuery(null,
      `SELECT port_number FROM gateway_ports WHERE tenant_id = $1 ORDER BY port_number`,
      [portsTenantId]
    );
    const allocatedPorts = allocatedResult.rows.map((r) => r.port_number);

    if (allocatedPorts.length > 0) {
      if (allowedPorts) {
        let requested;
        try {
          requested = typeof allowedPorts === 'string' ? JSON.parse(allowedPorts) : allowedPorts;
        } catch (e) {
          requested = String(allowedPorts).split(',').map(Number);
        }
        if (!Array.isArray(requested)) requested = [requested];
        requested = requested.map(Number);
        const notAllocated = requested.filter((p) => !allocatedPorts.includes(p));
        if (notAllocated.length > 0) {
          return res.status(400).json({
            error: `Port(s) ${notAllocated.join(', ')} are not allocated to your account. Ports allocated to you: ${allocatedPorts.join(', ') || '(none)'}`
          });
        }
        parsedPorts = requested.join(',');
      } else {
        // No allowedPorts specified - default to every port this tenant actually owns,
        // instead of the global 'all'.
        parsedPorts = allocatedPorts.join(',');
      }
    } else if (allowedPorts) {
      // No allocation on file for this tenant - nothing to validate against, so fall back to
      // the original unrestricted parsing (still respects whatever the caller asked for).
      try {
        const p = typeof allowedPorts === 'string' ? JSON.parse(allowedPorts) : allowedPorts;
        if (Array.isArray(p) && p.length > 0) {
          parsedPorts = p.map(Number).join(',');
        }
      } catch (e) {
        parsedPorts = String(allowedPorts);
      }
    }
  } catch (err) {
    console.error('[CampaignController] Port allocation lookup failed:', err.message);
    return res.status(500).json({ error: 'Failed to verify port allocation' });
  }

  let tempInputPath = null;

  try {
    // Prepare directory paths for transcoded voice prompts (using OS tmpdir guaranteed to be writable on cloud hosts like Render)
    const targetDir = path.join(os.tmpdir(), 'campaign_audio');
    try {
      if (!fs.existsSync(targetDir)) {
        fs.mkdirSync(targetDir, { recursive: true });
      }
    } catch (err) {
      console.warn('[CampaignController] Storage directory creation notice:', err.message);
    }

    // Handle Audio Source, then push the transcoded prompt to the Asterisk box itself -
    // it must live where Playback() can find it, not just in Render's ephemeral /tmp. Skipped
    // entirely for an IVR-flow campaign with no audio provided - the flow supplies its own
    // prompts per node, so there's nothing to transcode/deliver and audio_url stays null.
    let audioFilename = null;
    if (audioFile || audioBase64) {
      const outputFilename = `${Date.now()}_transcoded.wav`;
      const outputPath = path.join(targetDir, outputFilename);
      if (audioFile) {
        await transcodeCampaignAudio(audioFile.path, outputPath);
      } else {
        tempInputPath = path.join(targetDir, `temp_${Date.now()}.mp3`);
        const base64Data = audioBase64.replace(/^data:audio\/\w+;base64,/, '');
        fs.writeFileSync(tempInputPath, Buffer.from(base64Data, 'base64'));
        await transcodeCampaignAudio(tempInputPath, outputPath);
      }
      // audioFilename is the extension-less basename Asterisk's Playback() expects,
      // once the file has actually landed in its sounds directory over SFTP.
      audioFilename = await deliverCampaignAudio(outputPath);
      try { fs.unlinkSync(outputPath); } catch (e) {}
    }

    // Workstream 9: was a hardcoded shared default regardless of who created the campaign -
    // every client's campaigns landed in the same bucket even though their flows/lookup-tables
    // were already properly isolated. Now scoped to the authenticated caller's own tenant.
    const campaignTenantId = resolveTenantId(req);

    // Workstream 9: setting ivr_flow_id in this SAME INSERT (rather than requiring a separate
    // POST /api/ivr/flows/:id/activate call afterward) closes a real race - the worker polls
    // every 2s and claims 'pending' leads as soon as they exist, so a campaign created first and
    // linked to its flow a moment later could get its first lead(s) dispatched through the plain
    // audio_url path in that gap, before the link ever took effect. Passing ivrFlowId up front
    // means a lead can never be claimed while ivr_flow_id is still null.
    const ivrFlowIdValue = ivrFlowId || null;

    // Workstream 9: an IVR-flow campaign starts 'preparing' instead of 'running' - the worker's
    // claimNextPendingLead() only claims leads whose campaign status is 'running'/'pending', so
    // this alone keeps every lead undialable until prepareCampaignAudio() (triggered below, once
    // leads exist) has pre-synthesized every static prompt for every language this campaign's
    // leads actually use and flips the status itself. A classic (non-IVR) campaign has no TTS to
    // prepare and starts 'running' immediately, unchanged from before.
    const initialStatus = ivrFlowIdValue ? 'preparing' : 'running';

    // Insert Campaign Master Record with fallback if tenant_id column missing
    let campaignResult;
    try {
      campaignResult = await executeTenantQuery(null, `
        INSERT INTO voice_campaigns (tenant_id, name, audio_url, status, allowed_ports, total_leads, ivr_flow_id)
        VALUES ($1, $2, $3, $4, $5, $6, $7)
        RETURNING *
      `, [campaignTenantId, name, audioFilename, initialStatus, parsedPorts, leads.length, ivrFlowIdValue]);
    } catch (err) {
      if (err.message.includes('tenant_id')) {
        campaignResult = await executeTenantQuery(null, `
          INSERT INTO voice_campaigns (name, audio_url, status, allowed_ports, total_leads, ivr_flow_id)
          VALUES ($1, $2, $3, $4, $5, $6)
          RETURNING *
        `, [name, audioFilename, initialStatus, parsedPorts, leads.length, ivrFlowIdValue]);
      } else {
        throw err;
      }
    }

    const campaign = campaignResult.rows[0];

    // Batched (LEAD_INSERT_BATCH_SIZE per round-trip), all inside one transaction - a single
    // multi-row INSERT here used to blow past PostgreSQL's 65535-bound-parameter limit on any
    // CSV above ~21,844 leads, which broke real bulk campaigns outright. See
    // insertCampaignLeads() above for why a dedicated client/transaction is used here instead
    // of executeTenantQuery.
    try {
      await insertCampaignLeads(campaign.id, leads, campaignTenantId);
    } catch (leadsError) {
      // The campaign row above already committed (executeTenantQuery is its own transaction) -
      // without this cleanup, a failed/partial lead insert would leave a zombie campaign behind
      // claiming total_leads leads that don't actually exist.
      console.error(`[CampaignController] Lead insert failed for campaign ${campaign.id}, removing the orphaned campaign row:`, leadsError.message);
      await executeTenantQuery(null, `DELETE FROM voice_campaigns WHERE id = $1`, [campaign.id]).catch((cleanupErr) => {
        console.error(`[CampaignController] Failed to clean up orphaned campaign ${campaign.id}:`, cleanupErr.message);
      });
      throw leadsError;
    }

    // Fire-and-forget: leads exist now (needed so the preloader can read their language_code
    // values), so kick off preparation without blocking this response on it - the worker can't
    // dial anyone yet anyway since the campaign is still 'preparing'. Poll GET /api/campaigns/:id
    // and watch status flip to 'running'.
    if (ivrFlowIdValue) {
      prepareCampaignAudio(campaign.id, ivrFlowIdValue).catch((err) => {
        console.error(`[CampaignController] prepareCampaignAudio failed for campaign ${campaign.id}:`, err.message);
      });
    }

    res.status(201).json({
      message: 'Outbound campaign initiated successfully',
      campaignId: campaign.id,
      name: campaign.name,
      totalLeads: leads.length,
      excludedDncCount,
      allowedPorts: parsedPorts,
      ivrFlowId: campaign.ivr_flow_id,
      status: campaign.status
    });

  } catch (error) {
    console.error('[CampaignController] Error initiating voice broadcast:', error);
    res.status(500).json({ error: `Campaign initiation failed: ${error.message}` });
  } finally {
    // Always clean up temp uploads, including on the error path (previously these leaked on any throw).
    try { if (tempInputPath && fs.existsSync(tempInputPath)) fs.unlinkSync(tempInputPath); } catch (e) {}
    try { if (csvFile && fs.existsSync(csvFile.path)) fs.unlinkSync(csvFile.path); } catch (e) {}
    try { if (audioFile && fs.existsSync(audioFile.path)) fs.unlinkSync(audioFile.path); } catch (e) {}
  }
}
