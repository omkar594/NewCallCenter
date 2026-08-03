import axios from 'axios';
import WebSocket from 'ws';
import EventEmitter from 'events';
import dotenv from 'dotenv';

dotenv.config();

/**
 * Service to connect to and control Asterisk's ARI (REST + WebSocket events), for Workstream 8's
 * IVR flow engine. Mirrors asteriskService.js's AMI wrapper pattern (singleton, reconnect-on-drop,
 * event emitter) since ivrFlowEngine.js needs the same call-control primitives AMI never exposed:
 * step-by-step answer/play/gather/hangup/redirect driven from Node, not a pre-written dialplan.
 */
class AriService extends EventEmitter {
  constructor() {
    super();
    // Reuses the same TLS port (8089) and cert the agent softphone's WSS transport already uses -
    // no separate security-group port needed (confirmed live: externally reachable already).
    this.baseUrl = process.env.ARI_BASE_URL || 'https://127.0.0.1:8089';
    this.username = process.env.ARI_USERNAME || 'ivr_engine';
    this.password = process.env.ARI_PASSWORD || 'change_me';
    this.appName = process.env.ARI_APP_NAME || 'ivr_engine';
    this.ws = null;
    this.isConnected = false;
    // Same reasoning as AMI_MOCK_MODE - explicit opt-in only, for local dev without a real
    // Asterisk box. Must never silently activate on a real connection failure in production.
    this.useMock = process.env.ARI_MOCK_MODE === 'true';
  }

  get restBaseUrl() {
    return `${this.baseUrl}/ari`;
  }

  connect() {
    if (this.useMock) {
      console.warn('[AriService] ARI_MOCK_MODE=true - REST calls are no-ops, no real Asterisk connection.');
      this.isConnected = true;
      this.emit('ari_ready');
      return Promise.resolve(true);
    }

    return new Promise((resolve) => {
      const wsUrl = `${this.baseUrl.replace(/^http/, 'ws')}/ari/events` +
        `?api_key=${encodeURIComponent(this.username)}:${encodeURIComponent(this.password)}` +
        `&app=${encodeURIComponent(this.appName)}&subscribeAll=true`;

      console.log(`[AriService] Connecting to Asterisk ARI events at ${this.baseUrl}/ari/events (app=${this.appName})...`);
      this.ws = new WebSocket(wsUrl);

      this.ws.on('open', () => {
        console.log('[AriService] ARI WebSocket connected.');
        this.isConnected = true;
        this.emit('ari_ready');
        resolve(true);
      });

      this.ws.on('message', (raw) => {
        let evt;
        try {
          evt = JSON.parse(raw.toString());
        } catch (err) {
          console.error('[AriService] Failed to parse ARI event:', err.message);
          return;
        }
        this.emit('ari_event', evt);
        if (evt.type) this.emit(evt.type, evt);
      });

      this.ws.on('error', (err) => {
        console.error(`[AriService] ARI WebSocket error: ${err.message}.`);
        this.isConnected = false;
        resolve(false);
      });

      this.ws.on('close', () => {
        console.warn('[AriService] ARI WebSocket closed. Reconnecting in 5s...');
        this.isConnected = false;
        setTimeout(() => this.connect(), 5000);
      });
    });
  }

  /**
   * Generic authenticated ARI REST call. Every wrapper method below funnels through this so
   * auth/base-URL/error-shape handling lives in exactly one place.
   */
  async _rest(method, path, { params, data } = {}) {
    if (this.useMock) {
      console.log(`[AriService Mock] ${method} ${path}`, params || data || '');
      return { id: `mock-${Date.now()}` };
    }
    const res = await axios({
      method,
      url: `${this.restBaseUrl}${path}`,
      auth: { username: this.username, password: this.password },
      params,
      data
    });
    return res.data;
  }

  /**
   * Resolves once an event matching `predicate` fires on `eventType`, or null after `timeoutMs`.
   * Same shape as asteriskService.waitForEvent - used to await e.g. PlaybackFinished for a
   * specific playback id, or StasisEnd for a specific channel.
   */
  waitForEvent(eventType, predicate, timeoutMs) {
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.removeListener(eventType, handler);
        resolve(null);
      }, timeoutMs);

      const handler = (evt) => {
        if (predicate(evt)) {
          clearTimeout(timer);
          this.removeListener(eventType, handler);
          resolve(evt);
        }
      };

      this.on(eventType, handler);
    });
  }

  /**
   * Reads a channel variable set earlier in the dialplan (e.g. AMDSTATUS, set by AMD() before
   * the channel enters Stasis) - needed by the 'amd_check' node, since AMD itself has no ARI
   * equivalent and must run as a dialplan step ahead of Stasis().
   */
  async getChannelVar(channelId, variable) {
    const result = await this._rest('get', `/channels/${channelId}/variable`, { params: { variable } });
    return result?.value;
  }

  async answerChannel(channelId) {
    return this._rest('post', `/channels/${channelId}/answer`);
  }

  async hangupChannel(channelId, reason) {
    return this._rest('delete', `/channels/${channelId}`, { params: reason ? { reason } : undefined });
  }

  /**
   * Plays a prompt (sound: or a TTS-cached filename per Workstream 8.9) on a channel. Returns
   * the playback object; caller awaits waitForEvent('PlaybackFinished', evt => evt.playback.id
   * === result.id, ...) to know when it's actually done, since this call itself only confirms
   * playback started.
   */
  async playMedia(channelId, media) {
    return this._rest('post', `/channels/${channelId}/play`, { params: { media } });
  }

  async stopPlayback(playbackId) {
    return this._rest('delete', `/playbacks/${playbackId}`);
  }

  /**
   * Hands the channel back to the static dialplan at a specific context/exten/priority.
   * Needed for the 'transfer_queue' node type, which reuses Workstream 7's Queue()/
   * queueMembershipService.js mechanism as-is rather than reimplementing agent bridging over ARI.
   */
  async continueInDialplan(channelId, context, extension, priority = 1) {
    return this._rest('post', `/channels/${channelId}/continue`, {
      params: { context, extension, priority }
    });
  }

  /**
   * The "digit-gather equivalent" ARI itself doesn't provide as a single action: accumulates
   * ChannelDtmfReceived events for one channel into a string. Pure collection only - min/max
   * validation and re-prompt-on-too-short is the collect_input node's job (ivrFlowEngine.js),
   * not this service's, since what counts as "valid" is flow-specific.
   */
  gatherDigits(channelId, {
    maxDigits = 20,
    terminator = '#',
    firstDigitTimeoutMs = 8000,
    interDigitTimeoutMs = 4000
  } = {}) {
    return new Promise((resolve) => {
      let digits = '';
      let timer = null;

      const finish = () => {
        clearTimeout(timer);
        this.removeListener('ChannelDtmfReceived', onDtmf);
        resolve(digits);
      };

      const armTimer = (ms) => {
        clearTimeout(timer);
        timer = setTimeout(finish, ms);
      };

      const onDtmf = (evt) => {
        if (evt.channel?.id !== channelId) return;
        const digit = evt.digit;
        if (digit === terminator) {
          finish();
          return;
        }
        digits += digit;
        if (digits.length >= maxDigits) {
          finish();
          return;
        }
        armTimer(interDigitTimeoutMs);
      };

      this.on('ChannelDtmfReceived', onDtmf);
      armTimer(firstDigitTimeoutMs);
    });
  }
}

// Singleton pattern, matching asteriskService.js
const ariService = new AriService();
export default ariService;
