import crypto from 'crypto';
import dns from 'dns/promises';
import fs from 'fs';
import net from 'net';
import os from 'os';
import path from 'path';
import axios from 'axios';
import pool from '../config/database.js';
import { transcodeCampaignAudio } from './audioTranscoder.js';
import { deliverCampaignAudio } from './audioDeliveryService.js';

// Turns a client-hosted audio URL into something Asterisk can actually play.
//
// Asterisk plays local files only - ARI's play action takes sound:/recording:/digits: media
// URIs, not arbitrary HTTPS. So a client saying "play https://.../greeting.wav" means: download
// it, transcode it to 8kHz telephony WAV, push it to the Asterisk box, and play it by filename.
// That is the same pipeline ttsService.js already uses for synthesized prompts, reused verbatim.
//
// Cached by URL, because without a cache that whole pipeline would run again on every single
// play - in the middle of a live call, with the customer listening to the silence.

const MAX_BYTES = 10 * 1024 * 1024;   // a telephony prompt is seconds long; anything larger is wrong
const FETCH_TIMEOUT_MS = 15000;
const ALLOW_HTTP = process.env.REMOTE_AUDIO_ALLOW_HTTP === 'true'; // local testing only

// These URLs come from outside the company, so every fetch is treated as an attempted attack
// until proved otherwise. Without the checks below this function is a server-side request
// forgery hole: a client could pass http://169.254.169.254/... and have our own server read the
// cloud metadata service - including its credentials - and hand the result back down a phone
// line. Blocking by hostname is not enough (DNS can point anywhere), so the resolved IP is what
// gets checked.
function isBlockedAddress(ip) {
  if (net.isIPv4(ip)) {
    const [a, b] = ip.split('.').map(Number);
    if (a === 10) return true;                          // private
    if (a === 172 && b >= 16 && b <= 31) return true;   // private
    if (a === 192 && b === 168) return true;            // private
    if (a === 127) return true;                         // loopback
    if (a === 169 && b === 254) return true;            // link-local + cloud metadata
    if (a === 0 || a >= 224) return true;               // unspecified, multicast, reserved
    return false;
  }
  const v6 = ip.toLowerCase();
  if (v6 === '::1' || v6 === '::') return true;         // loopback / unspecified
  if (v6.startsWith('fe80')) return true;               // link-local
  if (v6.startsWith('fc') || v6.startsWith('fd')) return true; // unique-local
  if (v6.startsWith('::ffff:')) return isBlockedAddress(v6.slice(7)); // IPv4-mapped
  return false;
}

async function assertSafeUrl(rawUrl) {
  let url;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new Error('Not a valid URL');
  }
  if (url.protocol !== 'https:' && !(ALLOW_HTTP && url.protocol === 'http:')) {
    throw new Error('Audio URL must use https');
  }

  const records = await dns.lookup(url.hostname, { all: true }).catch(() => []);
  if (records.length === 0) {
    throw new Error('Audio URL hostname does not resolve');
  }
  // EVERY resolved address must be safe, not merely the first: a hostname that returns both a
  // public and a private address would otherwise pass here and connect to the private one.
  for (const { address } of records) {
    if (isBlockedAddress(address)) {
      throw new Error('Audio URL resolves to a private or reserved address');
    }
  }
  return url;
}

const urlHash = (url) => crypto.createHash('sha256').update(url).digest('hex');

/**
 * Returns the Asterisk media URI for a client-hosted audio URL, fetching and caching on first use.
 *
 * @param {string} rawUrl - https URL supplied by the client
 * @returns {Promise<string>} e.g. "sound:campaign_audio/api_3f9a...."
 */
export async function getPlayableMedia(rawUrl) {
  const hash = urlHash(rawUrl);

  const cached = await pool.query(
    'SELECT asterisk_filename FROM api_audio_cache WHERE url_hash = $1', [hash]
  );
  if (cached.rows[0]) {
    pool.query('UPDATE api_audio_cache SET last_used_at = NOW() WHERE url_hash = $1', [hash]).catch(() => {});
    return `sound:campaign_audio/${cached.rows[0].asterisk_filename}`;
  }

  const url = await assertSafeUrl(rawUrl);

  const response = await axios.get(url.toString(), {
    responseType: 'arraybuffer',
    timeout: FETCH_TIMEOUT_MS,
    maxContentLength: MAX_BYTES,
    maxBodyLength: MAX_BYTES,
    // A redirect can hop from a safe host to a private one, which would sidestep the check
    // above entirely. Refusing to follow them is simpler and safer than re-validating each hop.
    maxRedirects: 0,
    validateStatus: (s) => s === 200
  });

  const contentType = String(response.headers['content-type'] || '');
  if (!contentType.startsWith('audio/') && contentType !== 'application/octet-stream') {
    throw new Error(`Expected audio, got "${contentType}"`);
  }

  const dir = path.join(os.tmpdir(), 'campaign_audio');
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  const basename = `api_${hash.slice(0, 24)}`;
  const rawPath = path.join(dir, `${basename}_raw`);
  const outPath = path.join(dir, `${basename}.wav`);

  fs.writeFileSync(rawPath, Buffer.from(response.data));
  let delivered;
  try {
    await transcodeCampaignAudio(rawPath, outPath);
    delivered = await deliverCampaignAudio(outPath);
  } finally {
    fs.unlink(rawPath, () => {});
    fs.unlink(outPath, () => {});
  }

  await pool.query(`
    INSERT INTO api_audio_cache (url_hash, source_url, asterisk_filename, bytes)
    VALUES ($1, $2, $3, $4)
    ON CONFLICT (url_hash) DO UPDATE SET last_used_at = NOW()
  `, [hash, rawUrl, delivered, response.data.byteLength]);

  return `sound:campaign_audio/${delivered}`;
}

/**
 * Warms the cache for a batch of URLs so the first in-call play is instant. Reports per-URL
 * success rather than failing the batch: a client checking twenty prompts wants to know which
 * one is broken, not that "something" was.
 */
export async function prefetchAudio(urls) {
  return Promise.all(urls.map(async (url) => {
    try {
      await getPlayableMedia(url);
      return { url, ok: true };
    } catch (err) {
      return { url, ok: false, error: err.message };
    }
  }));
}
