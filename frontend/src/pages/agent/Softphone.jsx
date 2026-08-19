import { useCallback, useEffect, useRef, useState } from 'react';
import JsSIP from 'jssip';
import { Radio, PhoneIncoming, PhoneOff, Phone, Mic, MicOff, Pause, Grid3x3, UserRound, Coffee, CheckCircle2, LogOut } from 'lucide-react';
import { apiGet, apiPost, getToken, resolveApiBaseUrl } from '../../api/client.js';
import { useAuth } from '../../context/AuthContext.jsx';

// Two independent things have to be true before this agent can be sent a call, and the UI keeps
// them visibly separate because they fail for completely different reasons:
//
//   1. SIP REGISTRATION (the "Offline / Available" pill) - the browser's WebSocket connection to
//      Asterisk. Breaks on WiFi blips, laptop sleep, an expired WSS certificate.
//   2. AVAILABILITY (the Ready / Break control) - agent_profiles.current_status in Postgres,
//      which is what actually puts them in their tenant's Asterisk queue.
//
// Registering does NOT make an agent available. Logging in leaves them at status 'login', and
// they only enter the queue when they explicitly press Ready (POST /api/calls/ready) - an agent
// whose browser happens to be open is not the same as an agent who is at their desk ready to
// talk to a customer.
const BREAK_TYPES = [
  { value: 'tea', label: 'Tea' },
  { value: 'lunch', label: 'Lunch' },
  { value: 'meeting', label: 'Meeting' },
  { value: 'other', label: 'Other' }
];

export default function Softphone() {
  const { user, logout } = useAuth();

  const [online, setOnline] = useState(false);
  const [connecting, setConnecting] = useState(true);
  const [sipError, setSipError] = useState('');
  const [available, setAvailable] = useState(false);
  const [availabilityBusy, setAvailabilityBusy] = useState(false);
  const [breakMenuOpen, setBreakMenuOpen] = useState(false);
  const [incomingCall, setIncomingCall] = useState(false);
  const [inCall, setInCall] = useState(false);
  const [callerId, setCallerId] = useState('-');
  // These call real JsSIP RTCSession methods (mute/unmute, hold/unhold, sendDTMF) - not cosmetic
  // toggles, since jssip genuinely supports all three on an active session.
  const [muted, setMuted] = useState(false);
  const [held, setHeld] = useState(false);
  const [keypadOpen, setKeypadOpen] = useState(false);
  const [elapsedSec, setElapsedSec] = useState(0);

  const uaRef = useRef(null);
  const sessionRef = useRef(null);
  const remoteAudioRef = useRef(null);
  const timerRef = useRef(null);
  const pollRef = useRef(null);

  const primeMicPermission = async () => {
    try {
      await navigator.mediaDevices.getUserMedia({ audio: true });
    } catch (err) {
      console.warn('Microphone permission not granted yet:', err.message);
    }
  };

  function onCallEnded() {
    sessionRef.current = null;
    setIncomingCall(false);
    setInCall(false);
    setMuted(false);
    setHeld(false);
    setKeypadOpen(false);
    if (timerRef.current) clearInterval(timerRef.current);
  }

  const registerSoftphone = useCallback(async () => {
    setConnecting(true);
    setSipError('');

    let credentials;
    try {
      credentials = await apiGet('/api/auth/me/sip-credentials');
    } catch (err) {
      setOnline(false);
      setConnecting(false);
      // A 403 here is the plan gate (middleware/tenantFeature.js), not a broken account - say so
      // plainly rather than leaving the agent staring at a dead "Connecting" pill.
      setSipError(err.status === 403
        ? 'Live agents are not enabled on your organisation’s plan.'
        : err.message || 'Could not load your softphone credentials.');
      return;
    }

    const { sipUsername, sipPassword, wssUrl } = credentials;
    const sipHost = wssUrl.replace(/^wss?:\/\//, '').split('/')[0].split(':')[0];

    const ua = new JsSIP.UA({
      sockets: [new JsSIP.WebSocketInterface(wssUrl)],
      uri: `sip:${sipUsername}@${sipHost}`,
      password: sipPassword,
      register: true,
      // Confirmed live (Workstream 7): without an ICE server here, RTCPeerConnection only
      // gathers "host" candidates - the browser's own private/Docker-bridge interface addresses
      // - and never discovers its actual public IP. Asterisk then sends RTP to that private
      // address, which is unreachable from the internet, so audio never arrives even though SIP
      // signaling (which just rides the already-open WSS connection) looks completely fine.
      pcConfig: {
        iceServers: [{ urls: 'stun:stun.l.google.com:19302' }]
      }
    });
    uaRef.current = ua;

    ua.on('registered', () => { setOnline(true); setConnecting(false); });
    ua.on('unregistered', () => setOnline(false));
    ua.on('registrationFailed', (e) => {
      setOnline(false);
      setConnecting(false);
      setSipError(`Could not register with the call server${e?.cause ? ` (${e.cause})` : ''}.`);
    });
    ua.on('disconnected', () => setOnline(false));

    ua.on('newRTCSession', (e) => {
      if (e.originator !== 'remote') return; // ignore sessions this softphone itself started
      if (sessionRef.current) {
        e.session.terminate(); // already on a call - reject a second incoming session outright
        return;
      }
      sessionRef.current = e.session;
      setCallerId((e.session.remote_identity && e.session.remote_identity.uri.user) || 'Unknown');
      setIncomingCall(true);

      e.session.on('ended', onCallEnded);
      e.session.on('failed', onCallEnded);
      e.session.on('accepted', () => {
        setIncomingCall(false);
        setInCall(true);
        setElapsedSec(0);
        timerRef.current = setInterval(() => setElapsedSec((s) => s + 1), 1000);
      });
      e.session.on('peerconnection', (data) => {
        data.peerconnection.addEventListener('track', (ev) => {
          if (remoteAudioRef.current) remoteAudioRef.current.srcObject = ev.streams[0];
        });
      });
    });

    ua.start();

    // Registration can silently drop mid-shift (laptop sleep, WiFi blip) without the
    // 'unregistered'/'disconnected' events always firing promptly - poll as a backstop so the
    // banner never lies about being online for long. Held in a ref so unmount can clear it; the
    // previous version leaked this interval for the lifetime of the tab.
    pollRef.current = setInterval(() => {
      if (uaRef.current) setOnline(uaRef.current.isRegistered());
    }, 5000);
  }, []);

  useEffect(() => {
    // Deliberately NOT awaited: getUserMedia()'s browser permission prompt doesn't resolve until
    // the agent clicks Allow/Block, which can take an arbitrary amount of time. SIP registration
    // must not be blocked waiting on that.
    primeMicPermission();
    registerSoftphone();

    return () => {
      if (timerRef.current) clearInterval(timerRef.current);
      if (pollRef.current) clearInterval(pollRef.current);
      try { uaRef.current?.stop(); } catch { /* UA already torn down */ }
    };
  }, [registerSoftphone]);

  // Leaving the queue when the tab closes matters more than it looks: an agent who is still
  // 'idle' in Postgres but whose browser is gone stays a queue member, so Asterisk keeps ringing
  // a dead endpoint and every caller routed to them waits out the full ring timeout for nothing.
  //
  // keepalive lets the request outlive the page unload (sendBeacon can't be used - it cannot set
  // the Authorization header). Best-effort by design: if it doesn't make it, the agent is simply
  // cleaned up the usual way at their next login or the next AMI resync.
  useEffect(() => {
    const handler = () => {
      const token = getToken();
      if (!token) return;
      try {
        fetch(`${resolveApiBaseUrl()}/api/calls/offline`, {
          method: 'POST',
          headers: { Authorization: `Bearer ${token}` },
          keepalive: true
        });
      } catch { /* nothing useful to do while the page is unloading */ }
    };
    window.addEventListener('pagehide', handler);
    return () => window.removeEventListener('pagehide', handler);
  }, []);

  const goReady = async () => {
    setAvailabilityBusy(true);
    setBreakMenuOpen(false);
    try {
      // /ready and /break are both no-ops as far as SIP is concerned - they move
      // agent_profiles.current_status, and the backend mirrors that into this tenant's Asterisk
      // queue (queueMembershipService.js). Postgres stays the single source of truth.
      await apiPost('/api/calls/ready');
      setAvailable(true);
    } catch (err) {
      setSipError(err.message || 'Could not go ready.');
    } finally {
      setAvailabilityBusy(false);
    }
  };

  const goOnBreak = async (breakType) => {
    setAvailabilityBusy(true);
    setBreakMenuOpen(false);
    try {
      await apiPost('/api/calls/break', { status: 'break', breakType });
      setAvailable(false);
    } catch (err) {
      setSipError(err.message || 'Could not start your break.');
    } finally {
      setAvailabilityBusy(false);
    }
  };

  const answerCall = () => {
    sessionRef.current?.answer({ mediaConstraints: { audio: true, video: false } });
  };

  const rejectOrHangup = () => {
    sessionRef.current?.terminate();
  };

  const toggleMute = () => {
    if (!sessionRef.current) return;
    if (muted) sessionRef.current.unmute({ audio: true });
    else sessionRef.current.mute({ audio: true });
    setMuted(!muted);
  };

  const toggleHold = () => {
    if (!sessionRef.current) return;
    if (held) sessionRef.current.unhold();
    else sessionRef.current.hold();
    setHeld(!held);
  };

  const sendDtmf = (digit) => {
    sessionRef.current?.sendDTMF(digit);
  };

  const timer = `${String(Math.floor(elapsedSec / 60)).padStart(2, '0')}:${String(elapsedSec % 60).padStart(2, '0')}`;

  return (
    <div className="min-h-screen bg-ink-900 dark:bg-abyss-900 flex items-center justify-center px-4 py-8">
      <div className="w-full max-w-sm bg-white dark:bg-abyss-500 border border-line dark:border-abyss-300/40 rounded-2xl shadow-xl overflow-hidden">
        <div className="flex items-center justify-between px-5 py-4 border-b border-brand-50 dark:border-white/10">
          <div className="flex items-center gap-2.5 min-w-0">
            <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-brand-600 dark:bg-neon-cyan/10 dark:text-neon-cyan text-white">
              <Radio className="w-4 h-4" />
            </span>
            <div className="min-w-0">
              <h1 className="text-sm font-semibold font-display text-ink-900 dark:text-white truncate">{user?.username || 'Agent'}</h1>
              <p className="text-[10px] uppercase tracking-wider text-ink-400 dark:text-abyss-50 truncate">
                {user?.tenant_name || 'Agent softphone'}
              </p>
            </div>
          </div>
          <span className={`flex shrink-0 items-center gap-1.5 rounded-full px-2.5 py-1 text-[10px] font-bold ${online ? 'bg-emerald-50 text-emerald-700 dark:bg-neon-green/10 dark:text-neon-green' : 'bg-red-50 text-red-700 dark:bg-red-400/10 dark:text-red-300'}`}>
            <span className={`h-1.5 w-1.5 rounded-full ${online ? 'bg-emerald-500 dark:bg-neon-green' : 'bg-red-500'}`} />
            {connecting ? 'Connecting' : online ? 'Connected' : 'Offline'}
          </span>
        </div>

        {/* Availability is separate from SIP registration on purpose - see the note at the top of
            this file. An agent can be connected but on a break, and must never be silently put
            into the queue just because their browser managed to register. */}
        <div className="px-5 py-4 border-b border-brand-50 dark:border-white/10">
          <div className="flex items-center justify-between mb-2.5">
            <span className="text-[10px] font-bold uppercase tracking-wider text-ink-400 dark:text-abyss-50">Availability</span>
            <span className={`text-[10px] font-bold ${available ? 'text-emerald-600 dark:text-neon-green' : 'text-amber-600 dark:text-gold-300'}`}>
              {available ? 'Ready for calls' : 'Not taking calls'}
            </span>
          </div>
          <div className="flex gap-2">
            <button
              onClick={goReady}
              disabled={availabilityBusy || available || !online}
              title={!online ? 'Waiting for the call server connection' : undefined}
              className={`flex-1 flex items-center justify-center gap-1.5 rounded-lg py-2.5 text-sm font-bold transition-colors disabled:opacity-50 disabled:cursor-not-allowed ${available ? 'bg-emerald-600 text-white' : 'bg-emerald-50 text-emerald-700 hover:bg-emerald-100 dark:bg-neon-green/10 dark:text-neon-green'}`}
            >
              <CheckCircle2 className="w-4 h-4" /> Ready
            </button>
            <div className="relative flex-1">
              <button
                onClick={() => setBreakMenuOpen((v) => !v)}
                disabled={availabilityBusy || !available}
                className="w-full flex items-center justify-center gap-1.5 rounded-lg py-2.5 text-sm font-bold bg-amber-50 text-amber-700 hover:bg-amber-100 dark:bg-gold-400/10 dark:text-gold-300 disabled:opacity-50 disabled:cursor-not-allowed"
              >
                <Coffee className="w-4 h-4" /> Break
              </button>
              {breakMenuOpen && (
                <div className="absolute right-0 z-10 mt-1 w-full rounded-lg border border-line dark:border-abyss-300/40 bg-white dark:bg-abyss-500 shadow-lg overflow-hidden">
                  {BREAK_TYPES.map((b) => (
                    <button
                      key={b.value}
                      onClick={() => goOnBreak(b.value)}
                      className="block w-full px-3 py-2 text-left text-xs font-semibold text-ink-700 dark:text-white hover:bg-brand-50 dark:hover:bg-abyss-400/40"
                    >
                      {b.label}
                    </button>
                  ))}
                </div>
              )}
            </div>
          </div>
          {sipError && <p className="mt-2.5 text-xs text-red-600 dark:text-red-300">{sipError}</p>}
        </div>

        <div className="p-5 space-y-4">
          {incomingCall && (
            <div className="border-2 border-red-200 dark:border-coral-500/30 bg-red-50 dark:bg-coral-500/10 rounded-xl p-4 space-y-3">
              <p className="text-sm text-ink-700 dark:text-slate-200 flex items-center gap-2">
                <PhoneIncoming className="w-4 h-4 animate-pulse" /> Incoming call from <strong>{callerId}</strong>
              </p>
              <div className="flex gap-2">
                <button onClick={answerCall} className="flex-1 flex items-center justify-center gap-1.5 bg-emerald-600 hover:bg-emerald-700 text-white rounded-lg py-2.5 text-sm font-bold">
                  <Phone className="w-4 h-4" /> Answer
                </button>
                <button onClick={rejectOrHangup} className="flex-1 flex items-center justify-center gap-1.5 bg-red-600 hover:bg-red-700 text-white rounded-lg py-2.5 text-sm font-bold">
                  <PhoneOff className="w-4 h-4" /> Reject
                </button>
              </div>
            </div>
          )}

          {inCall && (
            <div className="space-y-4">
              <div className="flex items-center gap-3">
                <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl bg-brand-50 dark:bg-neon-cyan/10 text-brand-600 dark:text-neon-cyan">
                  <UserRound className="w-5 h-5" />
                </span>
                <div className="min-w-0 flex-1">
                  <p className="text-sm font-semibold text-ink-900 dark:text-white truncate">{callerId}</p>
                  <p className="text-xs text-ink-400 dark:text-abyss-50">{held ? 'On hold' : 'Connected'}</p>
                </div>
                <span className="font-mono text-sm font-bold text-brand-600 dark:text-neon-cyan flex items-center gap-1.5">
                  <span className="h-1.5 w-1.5 rounded-full bg-emerald-500 dark:bg-neon-green animate-pulse" />
                  {timer}
                </span>
              </div>

              <div className="flex items-center justify-center gap-2">
                <button onClick={toggleMute} className={`flex flex-col items-center gap-1 rounded-xl border px-3 py-2 text-[10px] font-semibold ${muted ? 'border-brand-300 bg-brand-50 text-brand-700 dark:border-neon-cyan/40 dark:bg-neon-cyan/10 dark:text-neon-cyan' : 'border-line dark:border-abyss-300/30 text-ink-600 dark:text-abyss-50'}`}>
                  {muted ? <MicOff className="w-4 h-4" /> : <Mic className="w-4 h-4" />} {muted ? 'Unmute' : 'Mute'}
                </button>
                <button onClick={toggleHold} className={`flex flex-col items-center gap-1 rounded-xl border px-3 py-2 text-[10px] font-semibold ${held ? 'border-brand-300 bg-brand-50 text-brand-700 dark:border-neon-cyan/40 dark:bg-neon-cyan/10 dark:text-neon-cyan' : 'border-line dark:border-abyss-300/30 text-ink-600 dark:text-abyss-50'}`}>
                  <Pause className="w-4 h-4" /> {held ? 'Resume' : 'Hold'}
                </button>
                <button onClick={() => setKeypadOpen(!keypadOpen)} className={`flex flex-col items-center gap-1 rounded-xl border px-3 py-2 text-[10px] font-semibold ${keypadOpen ? 'border-brand-300 bg-brand-50 text-brand-700 dark:border-neon-cyan/40 dark:bg-neon-cyan/10 dark:text-neon-cyan' : 'border-line dark:border-abyss-300/30 text-ink-600 dark:text-abyss-50'}`}>
                  <Grid3x3 className="w-4 h-4" /> Keypad
                </button>
              </div>

              {keypadOpen && (
                <div className="grid grid-cols-3 gap-2 bg-brand-50 dark:bg-abyss-400/40 rounded-xl p-3">
                  {['1', '2', '3', '4', '5', '6', '7', '8', '9', '*', '0', '#'].map((key) => (
                    <button key={key} onClick={() => sendDtmf(key)} className="rounded-lg bg-white dark:bg-abyss-500 py-2 text-sm font-bold text-ink-700 dark:text-white shadow-card">
                      {key}
                    </button>
                  ))}
                </div>
              )}

              <button onClick={rejectOrHangup} className="w-full flex items-center justify-center gap-1.5 bg-red-600 hover:bg-red-700 text-white rounded-lg py-2.5 text-sm font-bold">
                <PhoneOff className="w-4 h-4" /> Hang Up
              </button>
            </div>
          )}

          {!incomingCall && !inCall && (
            <p className="text-sm text-ink-400 dark:text-abyss-50 text-center py-6">
              {!online
                ? 'Connecting to the call system…'
                : available
                  ? "You're ready - waiting for a call."
                  : 'Press Ready when you’re at your desk to start receiving calls.'}
            </p>
          )}
        </div>

        <div className="px-5 py-3 border-t border-brand-50 dark:border-white/10">
          <button
            onClick={logout}
            className="flex items-center gap-1.5 text-xs font-semibold text-ink-400 dark:text-abyss-50 hover:text-ink-700 dark:hover:text-white"
          >
            <LogOut className="w-3.5 h-3.5" /> Sign out
          </button>
        </div>

        <audio ref={remoteAudioRef} autoPlay />
      </div>
    </div>
  );
}
