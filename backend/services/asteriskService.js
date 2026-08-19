import net from 'net';
import EventEmitter from 'events';
import dotenv from 'dotenv';
import logger from '../utils/logger.js';

dotenv.config();

/**
 * Service to connect to and control Asterisk Manager Interface (AMI).
 * Fires events when calls status changes.
 */
class AsteriskService extends EventEmitter {
  constructor() {
    super();
    this.host = process.env.ASTERISK_AMI_HOST || '192.168.1.85';
    this.port = parseInt(process.env.ASTERISK_AMI_PORT) || 5038;
    this.username = process.env.ASTERISK_AMI_USER || 'admin';
    this.secret = process.env.ASTERISK_AMI_PASS || 'admin_password';
    this.socket = null;
    this.isConnected = false;
    this.buffer = '';
    this.actionCallbacks = new Map();
    this.actionIdCounter = 1;
    // Exponential backoff for AMI reconnects (5s -> 10s -> 20s ... capped at 60s), reset to the
    // base delay on every successful login. A flat 5s-forever retry hammers a genuinely-down
    // Asterisk box or network path just as hard on minute 30 as on second 5.
    this.baseReconnectDelayMs = 5000;
    this.maxReconnectDelayMs = 60000;
    this.reconnectDelayMs = this.baseReconnectDelayMs;
    // Tracks every in-flight sendAction/waitForEvent so a socket drop can fail them fast instead
    // of leaving callers hanging until their own long timeout (up to MAX_CALL_DURATION_MS = 5min).
    this.pendingWaiters = new Set();
    // Mock mode must be an explicit opt-in for local dev without a real Asterisk box.
    // It used to auto-enable on ANY connection/auth failure, which silently hid real
    // outages behind fake "Success" responses in production - see plan Workstream 2.
    this.useMock = process.env.AMI_MOCK_MODE === 'true';
  }

  /**
   * Connect to Asterisk AMI server
   */
  async connect() {
    if (this.useMock) {
      logger.warn('[AsteriskService] AMI_MOCK_MODE=true - using the AMI simulator, not a real Asterisk connection.');
      this.isConnected = true;
      this.emit('ami_ready');
      return true;
    }

    return new Promise((resolve) => {
      logger.info({ host: this.host, port: this.port }, 'Attempting connection to Asterisk AMI');

      this.socket = net.connect({ host: this.host, port: this.port });
      this.socket.setKeepAlive(true);

      this.socket.on('connect', async () => {
        logger.info('Connected to Asterisk AMI socket. Performing Login...');
        try {
          const response = await this.sendAction('Login', {
            Username: this.username,
            Secret: this.secret
          });
          if (response.Response === 'Success') {
            logger.info('Successfully authenticated with Asterisk AMI');
            this.isConnected = true;
            this.reconnectDelayMs = this.baseReconnectDelayMs;
            // Lets queueMembershipService resync every tenant's agent queue membership against
            // Postgres on every (re)connect, including after Asterisk restarts where any
            // AMI-only queue state would otherwise be lost - see Workstream 7.
            this.emit('ami_ready');
            resolve(true);
          } else {
            logger.error({ message: response.Message }, 'Asterisk AMI authentication failed');
            this.isConnected = false;
            resolve(false);
          }
        } catch (err) {
          logger.error({ err }, 'Asterisk AMI login command failed');
          this.isConnected = false;
          resolve(false);
        }
      });

      this.socket.on('data', (chunk) => {
        this.buffer += chunk.toString();
        this._processBuffer();
      });

      this.socket.on('error', (err) => {
        logger.error({ err }, 'Asterisk AMI connection failed');
        this.isConnected = false;
        resolve(false);
      });

      this.socket.on('close', () => {
        const delay = this.reconnectDelayMs;
        logger.warn({ reconnectInMs: delay }, 'Asterisk AMI socket connection closed');
        this.isConnected = false;
        this._failAllPending('AMI disconnected');
        this.reconnectDelayMs = Math.min(this.reconnectDelayMs * 2, this.maxReconnectDelayMs);
        setTimeout(() => this.connect(), delay);
      });
    });
  }

  /**
   * Fails every in-flight sendAction callback and waitForEvent listener immediately, instead of
   * leaving them to hang until their own timeout - called the moment the AMI socket drops.
   */
  _failAllPending(reason) {
    for (const { reject } of this.actionCallbacks.values()) {
      reject(new Error(reason));
    }
    this.actionCallbacks.clear();

    for (const cleanup of Array.from(this.pendingWaiters)) {
      cleanup();
    }
  }

  /**
   * Send an AMI Action
   * @param {string} action - Action name (e.g. Originate, Hangup)
   * @param {Object} parameters - Key-value pair parameters
   */
  async sendAction(action, parameters = {}) {
    const actionId = `act_${this.actionIdCounter++}`;
    const payload = {
      Action: action,
      ActionID: actionId,
      ...parameters
    };

    if (this.useMock) {
      return this._simulateAction(action, payload);
    }

    return new Promise((resolve, reject) => {
      if (!this.isConnected && action !== 'Login') {
        return reject(new Error('Asterisk AMI not connected'));
      }

      this.actionCallbacks.set(actionId, { resolve, reject });
      
      let rawString = '';
      for (const [key, value] of Object.entries(payload)) {
        rawString += `${key}: ${value}\r\n`;
      }
      rawString += '\r\n';
      
      this.socket.write(rawString);
    });
  }

  /**
   * Originates an outbound call via SIP channel
   */
  async originateCall(channel, exten, context, priority, variables = {}, callerId = 'ContactCenter') {
    const variablesStr = Object.entries(variables)
      .map(([k, v]) => `${k}=${v}`)
      .join(',');

    return this.sendAction('Originate', {
      Channel: channel,
      Exten: exten,
      Context: context,
      Priority: priority,
      CallerID: callerId,
      Variable: variablesStr,
      Timeout: 15000, // 15 seconds SLA ring timeout
      Async: 'true'
    });
  }

  /**
   * Originates an outbound call and returns immediately with the ActionID plus a promise
   * for the immediate AMI ack (accepted/rejected). Callers that need the REAL call outcome
   * (answered/busy/no-answer, and when the channel actually frees up) must separately listen
   * for the 'OriginateResponse' event (matched by ActionID) and then the 'Hangup' event
   * (matched by the Uniqueid carried on that OriginateResponse) - the ack alone only means
   * "Asterisk accepted the request", not "the call happened". See bulkCampaignWorker.js.
   */
  originateAsync(channel, exten, context, priority, variables = {}, callerId = 'ContactCenter', timeoutMs = 45000) {
    const actionId = `act_${this.actionIdCounter++}`;
    const variablesStr = Object.entries(variables)
      .map(([k, v]) => `${k}=${v}`)
      .join(',');
    const payload = {
      Action: 'Originate',
      ActionID: actionId,
      Channel: channel,
      Exten: exten,
      Context: context,
      Priority: priority,
      CallerID: callerId,
      Variable: variablesStr,
      Timeout: timeoutMs,
      Async: 'true'
    };

    let ackPromise;
    if (this.useMock) {
      ackPromise = this._simulateAction('Originate', payload);
    } else {
      ackPromise = new Promise((resolve, reject) => {
        if (!this.isConnected) {
          return reject(new Error('Asterisk AMI not connected'));
        }
        this.actionCallbacks.set(actionId, { resolve, reject });
        let rawString = '';
        for (const [key, value] of Object.entries(payload)) {
          rawString += `${key}: ${value}\r\n`;
        }
        rawString += '\r\n';
        this.socket.write(rawString);
      });
    }

    return { actionId, ackPromise };
  }

  /**
   * Resolves once an event matching `predicate` fires on `eventName`, or null after `timeoutMs`.
   * Used to correlate OriginateResponse/Hangup events back to a specific dispatched call.
   */
  waitForEvent(eventName, predicate, timeoutMs) {
    return new Promise((resolve) => {
      const cleanup = () => {
        clearTimeout(timer);
        this.removeListener(eventName, handler);
        this.pendingWaiters.delete(cleanup);
        resolve(null);
      };

      const timer = setTimeout(cleanup, timeoutMs);

      const handler = (evt) => {
        if (predicate(evt)) {
          clearTimeout(timer);
          this.removeListener(eventName, handler);
          this.pendingWaiters.delete(cleanup);
          resolve(evt);
        }
      };

      this.on(eventName, handler);
      this.pendingWaiters.add(cleanup);
    });
  }

  /**
   * Hang up a live channel
   */
  async hangupChannel(channel) {
    return this.sendAction('Hangup', { Channel: channel });
  }

  /**
   * Adds/removes a dynamic member from an Asterisk queue. Used by queueMembershipService.js to
   * keep each tenant's own queue live membership in sync with agent_profiles.current_status -
   * Postgres stays the single source of truth for who's idle, Asterisk's queue membership is
   * just a mirror of it. The queue name is always passed in by the caller and is per-tenant;
   * there is no default queue here on purpose. No AMI Bridge/Transfer action is
   * needed for the press-1-to-agent feature - Queue() bridges natively inside the dialplan.
   */
  async queueAdd(queue, interfaceName, opts = {}) {
    return this.sendAction('QueueAdd', { Queue: queue, Interface: interfaceName, Penalty: 0, ...opts });
  }

  async queueRemove(queue, interfaceName) {
    return this.sendAction('QueueRemove', { Queue: queue, Interface: interfaceName });
  }

  /**
   * Parser for raw buffer
   */
  _processBuffer() {
    let packetEnd;
    while ((packetEnd = this.buffer.indexOf('\r\n\r\n')) !== -1) {
      const packetStr = this.buffer.substring(0, packetEnd);
      this.buffer = this.buffer.substring(packetEnd + 4);
      
      const parsedMsg = this._parsePacket(packetStr);
      if (parsedMsg.Event) {
        this.emit('ami_event', parsedMsg);
        this.emit(parsedMsg.Event, parsedMsg);
      } else if (parsedMsg.Response) {
        const actionId = parsedMsg.ActionID;
        if (actionId && this.actionCallbacks.has(actionId)) {
          const { resolve } = this.actionCallbacks.get(actionId);
          this.actionCallbacks.delete(actionId);
          resolve(parsedMsg);
        } else if (parsedMsg.Response === 'Success' && !actionId) {
          // Check for initial handshake login response
          this.emit('login_response', parsedMsg);
        }
      }
    }
  }

  _parsePacket(packetStr) {
    const lines = packetStr.split('\r\n');
    const msg = {};
    for (const line of lines) {
      const colon = line.indexOf(':');
      if (colon !== -1) {
        const key = line.substring(0, colon).trim();
        const value = line.substring(colon + 1).trim();
        msg[key] = value;
      }
    }
    return msg;
  }

  /**
   * Internal Simulator for AMI actions when hardware is missing.
   */
  _simulateAction(action, payload) {
    logger.debug({ action, payload }, '[AMI Simulator] Received Action');

    // Simulate events async to verify backend flow
    if (action === 'Originate') {
      const uniqueid = `sim-${payload.ActionID}`;
      const isAbsent = payload.Channel.includes('absent');

      const emit = (evt) => {
        this.emit('ami_event', evt);
        this.emit(evt.Event, evt);
      };

      setTimeout(() => {
        // Trigger ringing state
        emit({
          Event: 'Newstate',
          Channel: payload.Channel,
          Uniqueid: uniqueid,
          ChannelState: '4', // Ringing
          ChannelStateDesc: 'Ringing',
          CallerIDNum: payload.CallerID,
          Exten: payload.Exten
        });

        // Simulate answer or no-answer, then a real OriginateResponse (the actual completion signal)
        setTimeout(() => {
          if (isAbsent) {
            emit({
              Event: 'OriginateResponse',
              ActionID: payload.ActionID,
              Response: 'Failure',
              Reason: '1', // no-answer
              Uniqueid: uniqueid,
              Channel: payload.Channel
            });
            emit({
              Event: 'Hangup',
              Channel: payload.Channel,
              Uniqueid: uniqueid,
              Cause: '19' // No answer
            });
          } else {
            emit({
              Event: 'Newstate',
              Channel: payload.Channel,
              Uniqueid: uniqueid,
              ChannelState: '6', // Up/Active
              ChannelStateDesc: 'Up',
              CallerIDNum: payload.CallerID,
              Exten: payload.Exten
            });
            emit({
              Event: 'BridgeEnter',
              Channel1: payload.Channel,
              Channel2: `SIP/${payload.Exten}-peer`,
              CallerIDNum: payload.CallerID
            });
            emit({
              Event: 'OriginateResponse',
              ActionID: payload.ActionID,
              Response: 'Success',
              Reason: '2', // Answered
              Uniqueid: uniqueid,
              Channel: payload.Channel
            });
            // Simulated prompt playback keeps the "channel" busy a bit longer before hangup.
            setTimeout(() => {
              emit({
                Event: 'Hangup',
                Channel: payload.Channel,
                Uniqueid: uniqueid,
                Cause: '16' // Normal clearing
              });
            }, 3000);
          }
        }, 2000);
      }, 500);
    }

    return Promise.resolve({
      Response: 'Success',
      ActionID: payload.ActionID,
      Message: 'Originate successfully queued (Simulated)'
    });
  }
}

// Singleton pattern
const asteriskService = new AsteriskService();
export default asteriskService;
