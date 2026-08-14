import express from 'express';
import multer from 'multer';
import os from 'os';
import fs from 'fs';
import path from 'path';
import { getCampaigns, getLiveCalls, getCampaignReport, exportCampaignLeadsCsv, pauseCampaign, resumeCampaign, createBroadcastCampaign, handleCampaignCallback, handleOptOutWebhook } from '../controllers/campaignController.js';
import { authenticateToken, authorizeRoles } from '../middleware/auth.js';

const AUDIO_FIELDS = new Set(['broadcastAudio', 'audioFile', 'audio', 'file']);
const CSV_FIELDS = new Set(['leadsCsv', 'csv']);
const MAX_AUDIO_BYTES = 25 * 1024 * 1024; // 25MB - generous for a short voice prompt
const MAX_CSV_BYTES = 10 * 1024 * 1024; // 10MB - generous for a large lead list

// Use OS temporary directory for upload stream buffer (guaranteed to exist on all cloud platforms like Render)
const router = express.Router();
const upload = multer({
  dest: os.tmpdir(),
  limits: { fileSize: MAX_AUDIO_BYTES, files: 2 },
  fileFilter: (req, file, cb) => {
    if (AUDIO_FIELDS.has(file.fieldname)) {
      if (!file.mimetype.startsWith('audio/')) {
        return cb(new Error(`Field "${file.fieldname}" must be an audio file, got ${file.mimetype}`));
      }
      return cb(null, true);
    }
    if (CSV_FIELDS.has(file.fieldname)) {
      const okType = file.mimetype === 'text/csv' || file.mimetype === 'text/plain' || file.mimetype === 'application/vnd.ms-excel';
      if (!okType) {
        return cb(new Error(`Field "${file.fieldname}" must be a CSV file, got ${file.mimetype}`));
      }
      return cb(null, true);
    }
    cb(new Error(`Unexpected upload field "${file.fieldname}"`));
  }
});

// Conditional upload middleware: handles multipart/form-data uploads OR skips for application/json payloads
const optionalUpload = (req, res, next) => {
  if (req.is('multipart/form-data')) {
    return upload.fields([
      { name: 'leadsCsv', maxCount: 1 },
      { name: 'csv', maxCount: 1 },
      { name: 'broadcastAudio', maxCount: 1 },
      { name: 'audioFile', maxCount: 1 },
      { name: 'audio', maxCount: 1 },
      { name: 'file', maxCount: 1 }
    ])(req, res, (err) => {
      if (err) {
        return res.status(400).json({ error: err.message || 'Upload rejected' });
      }
      next();
    });
  }
  next();
};

// Workstream 9: campaign creation/listing/reporting now require login and get scoped to the
// caller's own tenant_id (see campaignController.js's resolveTenantId()) - previously these were
// zero-auth and every campaign landed under one shared default tenant regardless of who created
// it, which meant flows/lookup-tables were properly isolated per client but campaigns were not.
// /callback and /optout stay zero-auth deliberately below - they're hit by Asterisk's dialplan
// via CURL() during a live call, which has no way to carry a JWT.
const requireCampaignAccess = [authenticateToken, authorizeRoles(['super_admin', 'client_admin', 'team_leader'])];

// 1. Get all campaigns list
router.get('/', requireCampaignAccess, getCampaigns);

// 1b. Live "Ongoing Calls" widget - registered before '/:id' so "live-calls" is never matched
// as a campaign id (same route-shadowing reason as /callback and /optout below).
router.get('/live-calls', requireCampaignAccess, getLiveCalls);

// 2. Create new Outbound Voice Broadcast Campaign
router.post('/broadcast', requireCampaignAccess, optionalUpload, createBroadcastCampaign);

// 3. Webhook for Asterisk dialplan to report call status - deliberately zero-auth (see above).
// MUST be registered before '/:id' or Express matches it as a campaign id lookup instead
// (see server.js history for the bug this fixes).
router.get('/callback', handleCampaignCallback);

// 3b. Workstream 7: DTMF-9 opt-out webhook, hit via CURL() from the dialplan the same way
// /callback is - GET with a query string, since func_curl defaults to GET. Also registered
// before '/:id' for the same route-shadowing reason as above, and deliberately zero-auth too.
router.get('/optout', handleOptOutWebhook);

// 4. Get campaign detailed status & call progress
router.get('/:id', requireCampaignAccess, getCampaignReport);

// 4b. Download the same report as CSV - a two-segment path, so it's unambiguous against '/:id'
// regardless of registration order (Express only matches '/:id' against a single segment).
router.get('/:id/export', requireCampaignAccess, exportCampaignLeadsCsv);

// 4c/4d. Pause/resume a campaign mid-run - same two-segment-path reasoning as /:id/export above.
router.post('/:id/pause', requireCampaignAccess, pauseCampaign);
router.post('/:id/resume', requireCampaignAccess, resumeCampaign);

export default router;
