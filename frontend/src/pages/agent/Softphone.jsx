import { useRef, useState } from 'react';
import JsSIP from 'jssip';
import { Radio, PhoneIncoming, PhoneOff, Phone } from 'lucide-react';
import { resolveApiBaseUrl } from '../../api/client.js';

// 1:1 port of frontend_component/agent_softphone/agent_softphone.js. Deliberately NOT wired
// into AuthContext/localStorage - the JWT lives only in a ref for this component's lifetime, so
// a page refresh means logging in again, exactly like the original standalone page. That's a
// simplicity/security tradeoff for a small internal team, not an oversight (see the original
// file's own comment this is ported from).
export default function Softphone() {
  const [loggedIn, setLoggedIn] = useState(false);
  const [online, setOnline] = useState(false);
  const [connecting, setConnecting] = useState(false);
  const [loginError, setLoginError] = useState('');
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [incomingCall, setIncomingCall] = useState(false);
  const [inCall, setInCall] = useState(false);
  const [callerId, setCallerId] = useState('-');

  const jwtTokenRef = useRef(null);
  const uaRef = useRef(null);
  const sessionRef = useRef(null);
  const remoteAudioRef = useRef(null);

  const primeMicPermission = async () => {
    try {
      await navigator.mediaDevices.getUserMedia({ audio: true });
    } catch (err) {
      console.warn('Microphone permission not granted yet:', err.message);
    }
  };

  const registerSoftphone = async () => {
    setConnecting(true);
    const res = await fetch(`${resolveApiBaseUrl()}/api/auth/me/sip-credentials`, {
      headers: { Authorization: `Bearer ${jwtTokenRef.current}` }
    });
    if (!res.ok) {
      setOnline(false);
      setConnecting(false);
      console.error('Failed to fetch SIP credentials - is this account an agent?');
      return;
    }
    const { sipUsername, sipPassword, wssUrl } = await res.json();
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
    ua.on('registrationFailed', () => { setOnline(false); setConnecting(false); });
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
    // banner never lies about being online for long.
    setInterval(() => {
      if (uaRef.current) setOnline(uaRef.current.isRegistered());
    }, 5000);
  };

  const handleLogin = async (e) => {
    e.preventDefault();
    setLoginError('');
    try {
      const res = await fetch(`${resolveApiBaseUrl()}/api/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username, password })
      });
      const data = await res.json();
      if (!res.ok) {
        setLoginError(data.error || 'Login failed');
        return;
      }
      jwtTokenRef.current = data.token;
      setLoggedIn(true);
      // Deliberately NOT awaited: getUserMedia()'s browser permission prompt doesn't resolve
      // until the agent clicks Allow/Block, which can take an arbitrary amount of time. SIP
      // registration must not be blocked waiting on that.
      primeMicPermission();
      await registerSoftphone();
    } catch (err) {
      setLoginError('Login request failed: ' + err.message);
    }
  };

  const answerCall = () => {
    sessionRef.current?.answer({ mediaConstraints: { audio: true, video: false } });
  };

  const rejectOrHangup = () => {
    sessionRef.current?.terminate();
  };

  function onCallEnded() {
    sessionRef.current = null;
    setIncomingCall(false);
    setInCall(false);
  }

  if (!loggedIn) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-slate-900 px-4">
        <div className="w-full max-w-sm bg-white rounded-xl shadow-xl p-8">
          <div className="flex items-center gap-2 mb-6">
            <Radio className="w-6 h-6 text-brand-600" />
            <h1 className="text-lg font-semibold text-slate-900">Agent Softphone</h1>
          </div>
          <form onSubmit={handleLogin} className="space-y-4">
            <input
              autoFocus
              autoComplete="username"
              placeholder="Username"
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              className="w-full border border-slate-300 rounded-md px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-brand-500"
            />
            <input
              type="password"
              autoComplete="current-password"
              placeholder="Password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              className="w-full border border-slate-300 rounded-md px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-brand-500"
            />
            {loginError && <p className="text-sm text-red-600">{loginError}</p>}
            <button type="submit" className="w-full bg-brand-600 hover:bg-brand-700 text-white rounded-md py-2 text-sm font-medium">
              Log in
            </button>
          </form>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-slate-900 flex items-center justify-center px-4">
      <div className="w-full max-w-sm bg-white rounded-xl shadow-xl p-8 space-y-4">
        <div className="flex items-center gap-2">
          <Radio className="w-6 h-6 text-brand-600" />
          <h1 className="text-lg font-semibold text-slate-900">Agent Softphone</h1>
        </div>

        <div className={`rounded-md px-4 py-2.5 text-sm font-semibold text-center ${online ? 'bg-emerald-50 text-emerald-700' : 'bg-red-50 text-red-700'}`}>
          {connecting ? 'Connecting...' : online ? 'Online - ready for calls' : 'OFFLINE - no calls can reach you'}
        </div>

        {incomingCall && (
          <div className="border-2 border-red-200 bg-red-50 rounded-lg p-4 space-y-3">
            <p className="text-sm text-slate-700 flex items-center gap-2">
              <PhoneIncoming className="w-4 h-4" /> Incoming call from <strong>{callerId}</strong>
            </p>
            <div className="flex gap-2">
              <button onClick={answerCall} className="flex-1 flex items-center justify-center gap-1.5 bg-emerald-600 hover:bg-emerald-700 text-white rounded-md py-2 text-sm font-medium">
                <Phone className="w-4 h-4" /> Answer
              </button>
              <button onClick={rejectOrHangup} className="flex-1 flex items-center justify-center gap-1.5 bg-red-600 hover:bg-red-700 text-white rounded-md py-2 text-sm font-medium">
                <PhoneOff className="w-4 h-4" /> Reject
              </button>
            </div>
          </div>
        )}

        {inCall && (
          <div className="space-y-3">
            <p className="text-sm text-slate-600">On a call...</p>
            <button onClick={rejectOrHangup} className="w-full flex items-center justify-center gap-1.5 bg-red-600 hover:bg-red-700 text-white rounded-md py-2 text-sm font-medium">
              <PhoneOff className="w-4 h-4" /> Hang Up
            </button>
          </div>
        )}

        <audio ref={remoteAudioRef} autoPlay />
      </div>
    </div>
  );
}
