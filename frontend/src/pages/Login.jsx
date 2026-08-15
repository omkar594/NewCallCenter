import { useState } from 'react';
import { useNavigate, Link } from 'react-router-dom';
import { Radio, AlertCircle, PhoneCall, Workflow, ShieldCheck, Lock, User, Activity, Wifi } from 'lucide-react';
import { useAuth } from '../context/AuthContext.jsx';
import { homeForRole } from '../components/ProtectedRoute.jsx';
import PlexusBackground from '../components/PlexusBackground.jsx';

const HIGHLIGHTS = [
  { icon: PhoneCall, text: 'Run outbound voice broadcasts at scale' },
  { icon: Workflow, text: 'Design IVR call flows visually' },
  { icon: ShieldCheck, text: 'Isolated, secure multi-tenant control' }
];

// variant: 'client' (default, /login) or 'admin' (/admin/login) - two separate URLs so an admin
// bookmark/link never doubles as a client-facing login page and vice versa. Enforced server-side
// (authController.js's login() rejects a wrong-portal login with the exact same response as a
// wrong password) rather than here - a client-side "you logged in, but wrong portal" message
// would confirm the credentials were valid, letting anyone probing this page with guessed admin
// credentials tell when they'd found a real one. So a portal mismatch just surfaces as the same
// generic err.message below as any other failed login; the link out to the other portal (see
// OTHER_PORTAL below) is shown unconditionally, never tied to whether an attempt succeeded.
const OTHER_PORTAL = {
  client: { path: '/admin/login', label: 'Admin sign in' },
  admin: { path: '/login', label: 'Client sign in' }
};

export default function Login({ variant = 'client' }) {
  const { login } = useAuth();
  const navigate = useNavigate();
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [submitting, setSubmitting] = useState(false);

  const handleSubmit = async (e) => {
    e.preventDefault();
    setError('');
    setSubmitting(true);
    try {
      const { user } = await login(username, password, variant);
      navigate(homeForRole(user.role), { replace: true });
    } catch (err) {
      setError(err.message || 'Login failed');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="min-h-screen flex bg-slate-950">
      <div className="relative hidden lg:flex lg:w-1/2 items-center justify-center overflow-hidden bg-gradient-to-br from-slate-950 via-slate-900 to-slate-950">
        <PlexusBackground />
        <div className="pointer-events-none absolute inset-0 bg-gradient-to-t from-slate-950 via-transparent to-slate-950/40" />
        <div className="relative z-10 max-w-md px-10">
          <div className="flex items-center gap-2 mb-8">
            <span className="relative flex h-10 w-10 items-center justify-center rounded-lg bg-amber-400/10 ring-1 ring-amber-400/30">
              <Radio className="w-5 h-5 text-amber-400" />
              <span className="absolute inline-flex h-2 w-2 rounded-full bg-amber-400 -top-0.5 -right-0.5 animate-ping" />
              <span className="absolute inline-flex h-2 w-2 rounded-full bg-amber-400 -top-0.5 -right-0.5" />
            </span>
            <span className="text-xl font-semibold text-white tracking-tight">CallCenter Console</span>
          </div>
          <h1 className="text-3xl font-semibold text-white leading-tight mb-4">
            Your outbound voice platform,<br />under one console.
          </h1>
          <p className="text-slate-400 text-sm mb-8">
            Manage campaigns, IVR flows, gateway ports and live calls across every tenant from a single, unified control room.
          </p>
          <ul className="space-y-3">
            {HIGHLIGHTS.map(({ icon: Icon, text }) => (
              <li key={text} className="flex items-center gap-3 text-sm text-slate-300">
                <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md bg-white/5 ring-1 ring-white/10">
                  <Icon className="w-4 h-4 text-teal-400" />
                </span>
                {text}
              </li>
            ))}
          </ul>
        </div>
      </div>

      <div className="relative flex flex-1 items-center justify-center px-4 py-12 bg-slate-950 lg:bg-[#f3f6f5] overflow-hidden">
        <div className="lg:hidden absolute inset-0 overflow-hidden">
          <PlexusBackground />
          <div className="absolute inset-0 bg-slate-950/70" />
        </div>

        {/* Technical chrome: dot-grid + soft glows + corner brackets, desktop only */}
        <div
          className="hidden lg:block pointer-events-none absolute inset-0"
          style={{
            backgroundImage: 'radial-gradient(circle, rgba(78,148,143,0.50) 1px, transparent 1px)',
            backgroundSize: '28px 28px'
          }}
        />
        <div className="hidden lg:block pointer-events-none absolute -top-24 -right-24 w-96 h-96 rounded-full bg-brand-300/25 blur-3xl" />
        <div className="hidden lg:block pointer-events-none absolute -bottom-24 -left-16 w-80 h-80 rounded-full bg-coral-300/20 blur-3xl" />

        <div className="hidden lg:flex items-center gap-2 absolute top-6 right-6 text-[11px] font-medium tracking-wide text-brand-700 bg-white/70 backdrop-blur border border-brand-200 rounded-full px-3 py-1.5">
          <span className="relative flex h-1.5 w-1.5">
            <span className="absolute inline-flex h-full w-full rounded-full bg-brand-500 opacity-75 animate-ping" />
            <span className="relative inline-flex h-1.5 w-1.5 rounded-full bg-brand-500" />
          </span>
          ALL SYSTEMS OPERATIONAL
        </div>
        <div className="hidden lg:flex items-center gap-4 absolute bottom-6 left-6 text-[11px] font-medium tracking-wide text-ink-400">
          <span className="flex items-center gap-1.5"><ShieldCheck className="w-3.5 h-3.5 text-brand-600" /> TLS ENCRYPTED</span>
          <span className="flex items-center gap-1.5"><Wifi className="w-3.5 h-3.5 text-brand-600" /> REALTIME SYNC</span>
          <span className="flex items-center gap-1.5"><Activity className="w-3.5 h-3.5 text-brand-600" /> LIVE MONITORING</span>
        </div>
        {/* corner brackets */}
        <div className="hidden lg:block pointer-events-none absolute top-10 left-10 w-8 h-8 border-t-2 border-l-2 border-brand-300/60 rounded-tl-md" />
        <div className="hidden lg:block pointer-events-none absolute bottom-10 right-10 w-8 h-8 border-b-2 border-r-2 border-brand-300/60 rounded-br-md" />

        <div className="relative z-10 w-full max-w-sm">
          <div className="flex items-center gap-2 mb-6 lg:hidden justify-center">
            <Radio className="w-6 h-6 text-amber-400" />
            <h1 className="text-lg font-semibold text-white">CallCenter Console</h1>
          </div>

          <div className="bg-white/95 backdrop-blur lg:bg-white/90 rounded-2xl shadow-2xl shadow-black/40 lg:shadow-brand-900/10 border border-white/10 lg:border-brand-100 p-8">
            <div className="mb-6">
              <div className="flex items-center gap-2">
                <h2 className="text-xl font-semibold text-ink-900">Welcome back</h2>
                {variant === 'admin' && (
                  <span className="text-[10px] font-semibold tracking-wide text-coral-700 bg-coral-100 rounded-full px-2 py-0.5">
                    ADMIN PORTAL
                  </span>
                )}
              </div>
              <p className="text-sm text-ink-400 mt-1">
                {variant === 'admin' ? 'Super admin sign in' : 'Sign in to your console'}
              </p>
            </div>

            <form onSubmit={handleSubmit} className="space-y-4">
              <div>
                <label className="block text-sm font-medium text-ink-700 mb-1">Username</label>
                <div className="relative">
                  <User className="w-4 h-4 text-slate-400 absolute left-3 top-1/2 -translate-y-1/2" />
                  <input
                    autoFocus
                    autoComplete="username"
                    value={username}
                    onChange={(e) => setUsername(e.target.value)}
                    className="w-full border border-slate-300 rounded-lg pl-9 pr-3 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-brand-500 focus:border-transparent transition-shadow"
                  />
                </div>
              </div>
              <div>
                <label className="block text-sm font-medium text-ink-700 mb-1">Password</label>
                <div className="relative">
                  <Lock className="w-4 h-4 text-slate-400 absolute left-3 top-1/2 -translate-y-1/2" />
                  <input
                    type="password"
                    autoComplete="current-password"
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    className="w-full border border-slate-300 rounded-lg pl-9 pr-3 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-brand-500 focus:border-transparent transition-shadow"
                  />
                </div>
              </div>
              {error && (
                <div className="flex items-start gap-2 text-sm text-red-600 bg-red-50 rounded-lg px-3 py-2 animate-[shake_0.3s_ease-in-out]">
                  <AlertCircle className="w-4 h-4 mt-0.5 shrink-0" />
                  {error}
                </div>
              )}
              <button
                type="submit"
                disabled={submitting}
                className="w-full bg-brand-600 hover:bg-brand-700 disabled:opacity-60 text-white rounded-lg py-2.5 text-sm font-medium transition-all shadow-lg shadow-brand-600/20 hover:shadow-brand-600/30 hover:-translate-y-px active:translate-y-0"
              >
                {submitting ? 'Signing in…' : 'Log in'}
              </button>
            </form>
          </div>

          <p className="text-center text-xs text-slate-400 lg:text-ink-400 mt-6">
            Secured multi-tenant access · CallCenter Console
          </p>
          <p className="text-center text-xs mt-2">
            <Link to={OTHER_PORTAL[variant].path} className="text-brand-300 lg:text-brand-600 hover:underline">
              {OTHER_PORTAL[variant].label} →
            </Link>
          </p>
        </div>
      </div>
    </div>
  );
}
