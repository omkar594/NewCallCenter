import express from 'express';
import multer from 'multer';
import os from 'os';
import {
  createFlow,
  updateFlow,
  getFlow,
  listFlows,
  activateFlow,
  uploadLookupTable,
  getLookupTable,
  uploadPromptAudio,
  previewPromptTts,
  transliteratePrompt
} from '../controllers/ivrController.js';
import { authenticateToken, authorizeRoles } from '../middleware/auth.js';

const MAX_CSV_BYTES = 10 * 1024 * 1024; // matches routes/campaign.js's lead-CSV limit
const MAX_AUDIO_BYTES = 25 * 1024 * 1024; // matches routes/campaign.js's broadcast-audio limit

const router = express.Router();
const upload = multer({
  dest: os.tmpdir(),
  limits: { fileSize: MAX_CSV_BYTES, files: 1 },
  fileFilter: (req, file, cb) => {
    const okType = file.mimetype === 'text/csv' || file.mimetype === 'text/plain' || file.mimetype === 'application/vnd.ms-excel';
    if (!okType) {
      return cb(new Error(`Field "${file.fieldname}" must be a CSV file, got ${file.mimetype}`));
    }
    cb(null, true);
  }
});
const uploadCsv = (req, res, next) => {
  upload.single('csv')(req, res, (err) => {
    if (err) return res.status(400).json({ error: err.message || 'Upload rejected' });
    next();
  });
};

const uploadAudioMiddleware = multer({
  dest: os.tmpdir(),
  limits: { fileSize: MAX_AUDIO_BYTES, files: 1 },
  fileFilter: (req, file, cb) => {
    if (!file.mimetype.startsWith('audio/')) {
      return cb(new Error(`Field "${file.fieldname}" must be an audio file, got ${file.mimetype}`));
    }
    cb(null, true);
  }
});
const uploadAudio = (req, res, next) => {
  uploadAudioMiddleware.single('audio')(req, res, (err) => {
    if (err) return res.status(400).json({ error: err.message || 'Upload rejected' });
    next();
  });
};

router.use(authenticateToken);
router.use(authorizeRoles(['super_admin', 'client_admin', 'team_leader']));

// Workstream 8: client-configurable IVR flow engine. Wire format for the flow body:
// { name, nodes: [{ client_id, type, is_start, prompt_id, config, next, branches: {matchValue: client_id} }] }
// - nodes reference each other by a caller-chosen client_id, translated to real DB UUIDs on
// write (see ivrController.js's persistFlowNodes). This is the same shape a future visual
// builder would author and read back via GET.
router.post('/flows', createFlow);
router.get('/flows', listFlows);
router.put('/flows/:id', updateFlow);
router.get('/flows/:id', getFlow);
router.post('/flows/:id/activate', activateFlow);

// FlowEditor authoring helpers: hear a prompt_text node's pronunciation before saving, and
// convert Hinglish typing to native script for languages where Piper needs it (see ttsService.js
// and utils/transliteration.js).
router.post('/preview-tts', previewPromptTts);
router.post('/transliterate', transliteratePrompt);

router.post('/lookup-tables', uploadCsv, uploadLookupTable);
router.get('/lookup-tables/:id', getLookupTable);

// Returns { prompt_id } - the caller-supplied audio, transcoded and delivered to the Asterisk
// box's sounds directory. Use the returned prompt_id as any node's prompt_id when authoring a
// flow via POST/PUT /flows above (the same tenant-scoped auth already applied to this router).
router.post('/prompts', uploadAudio, uploadPromptAudio);

export default router;
