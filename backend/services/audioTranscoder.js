import ffmpeg from 'fluent-ffmpeg';
import ffmpegInstaller from '@ffmpeg-installer/ffmpeg';
import path from 'path';

// Render's plain Node runtime has no system ffmpeg binary; @ffmpeg-installer/ffmpeg
// bundles a static binary via npm so this works without a Dockerfile.
ffmpeg.setFfmpegPath(ffmpegInstaller.path);

const TRANSCODE_TIMEOUT_MS = 30000;

// Telephony conditioning, applied before the downsample to 8kHz.
//
// This step used to be a bare resample: whatever level the source happened to have was what the
// caller got. That is the main reason synthesized prompts were described as unclear and lacking
// confidence - measured, raw Piper output landed around -47dB mean, which on a narrowband phone
// line is a mumble. The engine was only part of the problem; nothing was ever setting a level.
//
// What each stage is for, in order (order matters - filter, then control dynamics, then set
// level, then band-limit, then resample):
//   highpass 200Hz  - a phone line reproduces nothing below ~300Hz, so low-frequency energy is
//                     pure wasted headroom that makes everything else quieter after normalizing.
//   acompressor     - narrows the gap between stressed and unstressed syllables. Word endings and
//                     consonants are the first things a narrowband codec loses; lifting them
//                     relative to the peaks is what makes every word land.
//   loudnorm        - EBU R128 to a fixed target, so EVERY prompt arrives at the same level
//                     whatever the source. Confirmed by measurement: a -47dB source and a -29dB
//                     source both come out at -16.5dB mean.
//   lowpass 3400Hz  - the telephony band. Also avoids aliasing artifacts folding back down as
//                     harshness during the resample, which reads to the ear as "robotic".
//   alimiter        - catches any peak the chain would otherwise clip. Measured max stays ~-2dB.
//
// Overridable at runtime because this can only truly be judged by ear on a real call, not on
// laptop speakers - set AUDIO_TELEPHONY_FILTERS to a different ffmpeg filter string to retune, or
// to "none" to go back to the old bare resample without a code change.
const DEFAULT_TELEPHONY_FILTERS = [
  'highpass=f=200',
  'acompressor=threshold=-20dB:ratio=4:attack=5:release=120:makeup=4',
  'loudnorm=I=-16:TP=-1.5:LRA=7',
  'lowpass=f=3400',
  'alimiter=limit=0.95'
].join(',');

const TELEPHONY_FILTERS = process.env.AUDIO_TELEPHONY_FILTERS || DEFAULT_TELEPHONY_FILTERS;

/**
 * Transcodes any input audio file to WAV, 8000Hz, 16-bit, Mono (PCM/alaw/ulaw compatible format).
 * Prevents Asterisk server transcoding overhead.
 *
 * @param {string} inputPath - Absolute path to the source audio file.
 * @param {string} outputPath - Absolute path where the transcoded WAV file will be saved.
 * @returns {Promise<string>} outputPath of the transcoded audio.
 */
export function transcodeCampaignAudio(inputPath, outputPath) {
  return new Promise((resolve, reject) => {
    console.log(`[Transcoder] Starting transcode: ${path.basename(inputPath)} -> ${path.basename(outputPath)}`);

    const command = ffmpeg(inputPath)
      .toFormat('wav')
      .audioChannels(1)          // Mono channel
      .audioFrequency(8000)      // 8kHz sampling rate (PSTN standard)
      .audioCodec('pcm_s16le');   // 16-bit signed PCM WAV

    // Applies to synthesized prompts, uploaded broadcast audio and uploaded IVR prompts alike -
    // they all come through here, so a human recording gets levelled the same way TTS does.
    if (TELEPHONY_FILTERS && TELEPHONY_FILTERS !== 'none') {
      command.audioFilters(TELEPHONY_FILTERS);
    }

    const timer = setTimeout(() => {
      command.kill('SIGKILL');
      reject(new Error(`Transcode timed out after ${TRANSCODE_TIMEOUT_MS}ms`));
    }, TRANSCODE_TIMEOUT_MS);

    command
      .on('end', () => {
        clearTimeout(timer);
        console.log(`[Transcoder] Successfully transcoded file: ${outputPath}`);
        resolve(outputPath);
      })
      .on('error', (err) => {
        clearTimeout(timer);
        console.error('[Transcoder] FFMPEG conversion failed:', err.message);
        reject(err);
      })
      .save(outputPath);
  });
}

export default transcodeCampaignAudio;
