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
// Preferred over PIPER_SSH_PRIVATE_KEY_PATH's Secret File approach: a multi-line PEM block
// pasted into a dashboard's Secret File editor is easy to silently corrupt (a dropped newline,
// trailing whitespace, a truncated paste) with no error anywhere until the SSH handshake itself
// fails - confirmed live, repeatedly, on this exact deployment. Base64-encoding the key into one
// line and storing it as a normal env var removes that whole failure class - single-line values
// are far harder for a UI paste to mangle. Set with: base64 -w0 tts_runner_key
const PIPER_SSH_PRIVATE_KEY_B64 = process.env.PIPER_SSH_PRIVATE_KEY_B64;

function loadPiperPrivateKey() {
  if (PIPER_SSH_PRIVATE_KEY_B64) {
    return Buffer.from(PIPER_SSH_PRIVATE_KEY_B64, 'base64');
  }
  if (PIPER_SSH_PRIVATE_KEY_PATH) {
    if (!fs.existsSync(PIPER_SSH_PRIVATE_KEY_PATH)) {
      throw new Error(`PIPER_SSH_PRIVATE_KEY_PATH does not exist on disk: ${PIPER_SSH_PRIVATE_KEY_PATH}`);
    }
    return fs.readFileSync(PIPER_SSH_PRIVATE_KEY_PATH);
  }
  return null;
}

const PIPER_BIN = process.env.PIPER_BIN || 'piper';
const PIPER_MODEL_DIR = process.env.PIPER_MODEL_DIR || '/opt/piper/models';
const PIPER_DEFAULT_MODEL = process.env.PIPER_DEFAULT_MODEL || 'en_IN-model.onnx';
const PIPER_TIMEOUT_MS = 20000;
const DEFAULT_LANGUAGE_CODE = process.env.TTS_DEFAULT_LANGUAGE_CODE || 'en-IN';

// Naturalness tuning: previously no flags were passed at all, so Piper fell back to its own
// library defaults (noise_scale 0.667, noise_w 0.8, length_scale 1.0) - the flattest, most
// metronomic setting it has. noise_w is phoneme-duration variance (how much natural timing
// wobble speech has - too low reads as robotic/metronomic); noise_scale is overall vocal
// variation (too high introduces graininess/artifacts, so nudged up only slightly). length_scale
// is speaking rate - left at Piper's own default since pacing preference is call-script-specific,
// but still exposed here so it can be tuned without another code change.
const PIPER_NOISE_SCALE = process.env.PIPER_NOISE_SCALE || '0.72';
const PIPER_NOISE_W = process.env.PIPER_NOISE_W || '0.92';
const PIPER_LENGTH_SCALE = process.env.PIPER_LENGTH_SCALE || '1.0';

// Per-language tuning override, on top of the global defaults above. Indic Piper models
// (hi_IN-priyamvada) are trained on noticeably less data than the English ones and read as more
// monotone/chanting at the same noise_w - nudged up here specifically for Hindi. 1.05 was tried
// first and confirmed live to overshoot into audible glitching/breaking mid-sentence - 0.85 stays
// much closer to Piper's own flat-but-stable baseline (0.8) while still reading less robotic than
// the un-tuned default. Override or add more languages via
// PIPER_LANGUAGE_TUNING='{"hi-IN":{"noiseW":"0.9"}}' without a redeploy.
const DEFAULT_LANGUAGE_TUNING = {
  'hi-IN': { noiseScale: '0.78', noiseW: '0.85' }
};
let languageTuningOverrides = {};
try {
  languageTuningOverrides = JSON.parse(process.env.PIPER_LANGUAGE_TUNING || '{}');
} catch (err) {
  console.warn('[TtsService] PIPER_LANGUAGE_TUNING is not valid JSON - falling back to defaults only:', err.message);
}

function resolveTuning(languageCode) {
  const override = { ...(DEFAULT_LANGUAGE_TUNING[languageCode] || {}), ...(languageTuningOverrides[languageCode] || {}) };
  return {
    noiseScale: override.noiseScale || PIPER_NOISE_SCALE,
    noiseW: override.noiseW || PIPER_NOISE_W,
    lengthScale: override.lengthScale || PIPER_LENGTH_SCALE
  };
}

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
function runPiperRemote(text, modelFile, languageCode) {
  const privateKey = loadPiperPrivateKey();
  if (!PIPER_SSH_HOST || !PIPER_SSH_USER || !privateKey) {
    throw new Error(
      'TTS is not configured. Set PIPER_SSH_HOST/USER and either PIPER_SSH_PRIVATE_KEY_B64 ' +
      '(preferred) or PIPER_SSH_PRIVATE_KEY_PATH to a dedicated, least-privilege SSH credential ' +
      'that can execute Piper on the Asterisk box - this must be separate from ASTERISK_SSH_* ' +
      '(that account is SFTP-only and cannot exec anything).'
    );
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
      const tuning = resolveTuning(languageCode);
      // --output_file - streams the synthesized WAV to stdout instead of a remote file.
      // noise_scale/noise_w/length_scale: see PIPER_NOISE_SCALE etc. above - without these,
      // Piper synthesizes with zero prosody variation, which is what read as "robotic."
      const command = `${PIPER_BIN} --model ${modelPath} --output_file - ` +
        `--noise_scale ${tuning.noiseScale} --noise_w ${tuning.noiseW} --length_scale ${tuning.lengthScale}`;
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
      privateKey,
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
 *
 * `returnBuffer: true` (used by the FlowEditor's pronunciation-preview endpoint) also returns
 * the transcoded WAV bytes alongside the basename, so a flow author can hear exactly what the
 * caller will hear - and since this still goes through the same cache/delivery path, previewing
 * a phrase also warms the cache for the campaign that uses it later, skipping re-synthesis at
 * "preparing" time. A cache hit alone can't satisfy `returnBuffer` (the earlier transcoded file
 * was already deleted), so that case re-synthesizes rather than serving stale bytes - a cost
 * only a preview call pays, never the hot call-answering path.
 */
export async function synthesizeAndDeliver(text, { languageCode = DEFAULT_LANGUAGE_CODE, returnBuffer = false } = {}) {
  const modelFile = resolveModelFile(languageCode);
  const hash = contentHash(text, modelFile);
  if (!returnBuffer && synthesisCache.has(hash)) {
    return synthesisCache.get(hash);
  }

  const targetDir = path.join(os.tmpdir(), 'campaign_audio');
  if (!fs.existsSync(targetDir)) {
    fs.mkdirSync(targetDir, { recursive: true });
  }
  const rawPath = path.join(targetDir, `tts_${hash}_raw.wav`);
  const outputPath = path.join(targetDir, `tts_${hash}.wav`);

  const wavBuffer = await runPiperRemote(text, modelFile, languageCode);
  fs.writeFileSync(rawPath, wavBuffer);

  let basename, audioBuffer;
  try {
    await transcodeCampaignAudio(rawPath, outputPath);
    if (returnBuffer) audioBuffer = fs.readFileSync(outputPath);
    basename = await deliverCampaignAudio(outputPath);
  } finally {
    fs.unlink(rawPath, () => {});
    fs.unlink(outputPath, () => {});
  }

  synthesisCache.set(hash, basename);
  return returnBuffer ? { basename, audioBuffer } : basename;
}
