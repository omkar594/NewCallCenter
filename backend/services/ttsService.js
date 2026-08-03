import crypto from 'crypto';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { Client as SshClient } from 'ssh2';
import { transcodeCampaignAudio } from './audioTranscoder.js';
import { deliverCampaignAudio } from './audioDeliveryService.js';

// Piper (https://github.com/rhasspy/piper) - offline, local neural TTS, chosen over a cloud
// provider so dynamic/variable-driven prompts need no external API key, have no per-call cost,
// and never leak caller data (a phone number, a looked-up name) to a third-party TTS service.
// Piper runs ON the Asterisk box itself, not on Render (which has no model storage and would
// need the exact same install duplicated for zero benefit) - invoked over its own dedicated,
// least-privilege SSH credential, deliberately SEPARATE from ASTERISK_SSH_* (audioDeliveryService.js):
// that account's shell is /usr/sbin/nologin (confirmed live) and is SFTP-transfer only by
// design, so it cannot exec anything. This credential's user should be restricted the same
// way - a forced command in authorized_keys that can only ever run the Piper wrapper, never an
// arbitrary shell command, regardless of what a caller-influenced text string happens to contain
// (that text only ever goes over stdin, never onto a command line, so it can't inject anything
// even if this restriction were somehow bypassed).
const PIPER_SSH_HOST = process.env.PIPER_SSH_HOST || process.env.ASTERISK_SSH_HOST;
const PIPER_SSH_PORT = parseInt(process.env.PIPER_SSH_PORT) || parseInt(process.env.ASTERISK_SSH_PORT) || 22;
const PIPER_SSH_USER = process.env.PIPER_SSH_USER;
const PIPER_SSH_PRIVATE_KEY_PATH = process.env.PIPER_SSH_PRIVATE_KEY_PATH;

const PIPER_BIN = process.env.PIPER_BIN || 'piper';
const PIPER_MODEL_DIR = process.env.PIPER_MODEL_DIR || '/opt/piper/models';
const PIPER_DEFAULT_MODEL = process.env.PIPER_DEFAULT_MODEL || 'en_IN-model.onnx';
const PIPER_TIMEOUT_MS = 20000;
const DEFAULT_LANGUAGE_CODE = process.env.TTS_DEFAULT_LANGUAGE_CODE || 'en-IN';

// Optional per-language model override, e.g. PIPER_VOICE_MODELS='{"hi-IN":"hi_IN-model.onnx","mr-IN":"mr_IN-model.onnx"}'.
// Falls back to PIPER_DEFAULT_MODEL for any language not listed here.
let voiceModelMap = {};
try {
  voiceModelMap = JSON.parse(process.env.PIPER_VOICE_MODELS || '{}');
} catch (err) {
  console.warn('[TtsService] PIPER_VOICE_MODELS is not valid JSON - falling back to PIPER_DEFAULT_MODEL only:', err.message);
}

// Cached by content hash (model + final substituted text), not by template - two different
// callers hearing "your provider is Ek Vira Gas Service" reuse the same synthesized file even
// though they came from different calls/flows. In-memory only: a cold cache after a restart
// just means the next occurrence of that exact phrase re-synthesizes once.
const synthesisCache = new Map();

function contentHash(text, modelFile) {
  return crypto.createHash('sha256').update(`${modelFile}|${text}`).digest('hex').slice(0, 24);
}

export function substituteVars(template, vars) {
  return String(template || '').replace(/\{\{(\w+)\}\}/g, (_, key) => (
    vars[key] !== undefined && vars[key] !== null ? String(vars[key]) : ''
  ));
}

export function hasVariablePlaceholders(template) {
  return /\{\{\w+\}\}/.test(String(template || ''));
}

function resolveModelFile(languageCode) {
  return voiceModelMap[languageCode] || PIPER_DEFAULT_MODEL;
}

// Runs Piper on the Asterisk box over SSH exec, piping `text` in on stdin and capturing the
// synthesized WAV off stdout - no remote temp files to clean up, and the caller-influenced text
// never touches a shell command line (only a stdin stream), so it can't inject anything into
// the remote command regardless of its contents.
function runPiperRemote(text, modelFile) {
  if (!PIPER_SSH_HOST || !PIPER_SSH_USER || !PIPER_SSH_PRIVATE_KEY_PATH) {
    throw new Error(
      'TTS is not configured. Set PIPER_SSH_HOST/USER/PRIVATE_KEY_PATH to a dedicated, ' +
      'least-privilege SSH credential that can execute Piper on the Asterisk box - this must ' +
      'be separate from ASTERISK_SSH_* (that account is SFTP-only and cannot exec anything).'
    );
  }
  if (!fs.existsSync(PIPER_SSH_PRIVATE_KEY_PATH)) {
    throw new Error(`PIPER_SSH_PRIVATE_KEY_PATH does not exist on disk: ${PIPER_SSH_PRIVATE_KEY_PATH}`);
  }

  return new Promise((resolve, reject) => {
    const conn = new SshClient();
    let settled = false;

    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      conn.end();
      reject(new Error(`Piper synthesis timed out after ${PIPER_TIMEOUT_MS}ms`));
    }, PIPER_TIMEOUT_MS);

    const finish = (fn, arg) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      conn.end();
      fn(arg);
    };

    conn.on('ready', () => {
      const modelPath = `${PIPER_MODEL_DIR}/${modelFile}`;
      // --output_file - streams the synthesized WAV to stdout instead of a remote file.
      const command = `${PIPER_BIN} --model ${modelPath} --output_file -`;
      conn.exec(command, (err, stream) => {
        if (err) return finish(reject, err);

        const chunks = [];
        let stderr = '';
        stream.on('data', (data) => chunks.push(data));
        stream.stderr.on('data', (data) => { stderr += data.toString(); });
        stream.on('close', (code) => {
          if (code !== 0) {
            return finish(reject, new Error(`piper exited with code ${code}: ${stderr.trim()}`));
          }
          finish(resolve, Buffer.concat(chunks));
        });
        stream.end(text);
      });
    });

    conn.on('error', (err) => finish(reject, err));

    conn.connect({
      host: PIPER_SSH_HOST,
      port: PIPER_SSH_PORT,
      username: PIPER_SSH_USER,
      privateKey: fs.readFileSync(PIPER_SSH_PRIVATE_KEY_PATH),
      readyTimeout: 15000
    });
  });
}

/**
 * Synthesizes `text` via Piper (running on the Asterisk box) and delivers it through the same
 * transcode+SFTP pipeline uploaded campaign audio uses (Workstream 3) - Piper's own output
 * sample rate varies per model, so it still gets normalized to 8kHz/16-bit mono like every
 * other prompt rather than assuming it already matches. Returns the extension-less basename to
 * use in `sound:campaign_audio/<basename>`.
 */
export async function synthesizeAndDeliver(text, { languageCode = DEFAULT_LANGUAGE_CODE } = {}) {
  const modelFile = resolveModelFile(languageCode);
  const hash = contentHash(text, modelFile);
  if (synthesisCache.has(hash)) {
    return synthesisCache.get(hash);
  }

  const targetDir = path.join(os.tmpdir(), 'campaign_audio');
  if (!fs.existsSync(targetDir)) {
    fs.mkdirSync(targetDir, { recursive: true });
  }
  const rawPath = path.join(targetDir, `tts_${hash}_raw.wav`);
  const outputPath = path.join(targetDir, `tts_${hash}.wav`);

  const wavBuffer = await runPiperRemote(text, modelFile);
  fs.writeFileSync(rawPath, wavBuffer);

  let basename;
  try {
    await transcodeCampaignAudio(rawPath, outputPath);
    basename = await deliverCampaignAudio(outputPath);
  } finally {
    fs.unlink(rawPath, () => {});
    fs.unlink(outputPath, () => {});
  }

  synthesisCache.set(hash, basename);
  return basename;
}
