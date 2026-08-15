import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import {
  Users, Plus, AlertCircle, Megaphone, PhoneCall, TrendingUp, Building2, X, Wallet,
  Radio, ShieldAlert, Play, UserRound, CreditCard, Ban, XCircle
} from 'lucide-react';
import {
  ResponsiveContainer, LineChart, Line, CartesianGrid, XAxis, YAxis, Tooltip, PieChart, Pie, Cell
} from 'recharts';
import { apiGet, apiPost } from '../../api/client.js';
import { useAuth } from '../../context/AuthContext.jsx';
import { useTheme } from '../../context/ThemeContext.jsx';
import DataTable from '../../components/DataTable.jsx';
import StatusBadge from '../../components/StatusBadge.jsx';

// Chart colors can't be Tailwind classes (recharts renders raw SVG props), so the neon/brand
// palette is duplicated here as literal values, one set per theme - kept in sync by hand with
// tailwind.config.js's `neon`/`brand`/`coral` scales.
const PALETTE = {
  light: { primary: '#4e948f', secondary: '#ff6363', grid: '#e2e8f0', text: '#64748b' },
  dark: { primary: '#00f0ff', secondary: '#ff6363', grid: 'rgba(255,255,255,0.08)', text: '#8892a6' }
};

const ACCENTS = {
  cyan: { icon: 'dark:text-neon-cyan', ring: 'dark:shadow-[0_0_20px_-4px_rgba(0,240,255,0.35)] dark:hover:shadow-[0_0_24px_-2px_rgba(0,240,255,0.5)]', bg: 'dark:bg-neon-cyan/10' },
  purple: { icon: 'dark:text-neon-purple', ring: 'dark:shadow-[0_0_20px_-4px_rgba(176,38,255,0.35)] dark:hover:shadow-[0_0_24px_-2px_rgba(176,38,255,0.5)]', bg: 'dark:bg-neon-purple/10' },
  green: { icon: 'dark:text-neon-green', ring: 'dark:shadow-[0_0_20px_-4px_rgba(0,255,102,0.35)] dark:hover:shadow-[0_0_24px_-2px_rgba(0,255,102,0.5)]', bg: 'dark:bg-neon-green/10' }
};

const RANGE_DAYS = { today: 1, '14d': 14, '30d': 30 };

function greeting() {
  const h = new Date().getHours();
  if (h < 12) return 'Good morning';
  if (h < 17) return 'Good afternoon';
  return 'Good evening';
}

function initials(name) {
  const parts = name.trim().split(/\s+/);
  return parts.length > 1 ? (parts[0][0] + parts[1][0]).toUpperCase() : name.slice(0, 2).toUpperCase();
}

function timeAgo(iso) {
  const diffMs = Date.now() - new Date(iso).getTime();
  const mins = Math.floor(diffMs / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins} min ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs} hr ago`;
  return `${Math.floor(hrs / 24)}d ago`;
}

function StatCard({ icon: Icon, label, value, sub, accent = 'cyan' }) {
  const a = ACCENTS[accent];
  return (
    <div className={`bg-white dark:bg-abyss-500/60 dark:backdrop-blur border border-brand-100 dark:border-white/10 rounded-xl p-5 shadow-sm transition-shadow ${a.ring}`}>
      <div className={`w-9 h-9 rounded-lg flex items-center justify-center mb-3 bg-brand-50 text-brand-600 ${a.bg} ${a.icon}`}>
        <Icon className="w-4 h-4" />
      </div>
      <div className="text-2xl font-semibold font-display text-ink-900 dark:text-white leading-none">{value}</div>
      <div className="text-xs text-ink-400 dark:text-abyss-50 mt-2">{label}</div>
      {sub && <div className="text-[11px] text-ink-300 dark:text-abyss-100 mt-0.5">{sub}</div>}
    </div>
  );
}

const CardShell = ({ title, sub, icon: Icon, action, children }) => (
  <div className="bg-white dark:bg-abyss-500/60 dark:backdrop-blur border border-brand-100 dark:border-white/10 rounded-xl p-5 dark:shadow-[0_0_20px_-8px_rgba(0,240,255,0.25)]">
    <div className="flex items-start justify-between mb-1">
      <div>
        <h2 className="font-medium text-ink-900 dark:text-white flex items-center gap-2">
          {Icon && <Icon className="w-4 h-4 text-brand-500 dark:text-neon-cyan" />}
          {title}
        </h2>
        {sub && <p className="text-xs text-ink-400 dark:text-abyss-50 mt-0.5">{sub}</p>}
      </div>
      {action}
    </div>
    <div className="mt-4">{children}</div>
  </div>
);

export default function SuperAdminDashboard() {
  const { user } = useAuth();
  const { theme } = useTheme();
  const colors = PALETTE[theme] || PALETTE.light;
  const [tenants, setTenants] = useState(null);
  const [ports, setPorts] = useState([]);
  const [overview, setOverview] = useState(null);
  const [error, setError] = useState('');
  const [range, setRange] = useState('14d');
  const [alertDismissed, setAlertDismissed] = useState(false);
  const [resumingId, setResumingId] = useState(null);

  const load = () => {
    Promise.all([apiGet('/api/auth/clients'), apiGet('/api/gateways/ports'), apiGet('/api/analytics/admin-overview')])
      .then(([tenantRows, portRows, overviewData]) => {
        setTenants(tenantRows);
        setPorts(portRows);
        setOverview(overviewData);
      })
      .catch((err) => setError(err.message));
  };

  useEffect(load, []);

  const portsByTenant = (tenantId) => ports.filter((p) => p.tenant_id === tenantId).map((p) => p.port_number).sort((a, b) => a - b);

  const successRate = overview && overview.totalDialed > 0
    ? Math.round((overview.outcomeCounts.answered / overview.totalDialed) * 100)
    : 0;

  const trendData = useMemo(() => {
    const days = RANGE_DAYS[range];
    const all = overview?.dailyTrend || [];
    return all.slice(-days).map((d) => ({
      day: new Date(d.day).toLocaleDateString(undefined, { month: 'short', day: 'numeric' }),
      Answered: d.answered,
      Rejected: d.rejected
    }));
  }, [overview, range]);

  const outcomeLabels = [
    { key: 'answered', name: 'Answered', light: '#4e948f', dark: '#00ff66' },
    { key: 'busy', name: 'Busy', light: '#f59e0b', dark: '#f59e0b' },
    { key: 'failed', name: 'Failed', light: '#ef4444', dark: '#ff6363' },
    { key: 'no-answer', name: 'No Answer', light: '#fb923c', dark: '#fb923c' }
  ];
  const outcomeChartData = overview
    ? outcomeLabels
        .map((o) => ({ name: o.name, value: overview.outcomeCounts[o.key], color: theme === 'dark' ? o.dark : o.light }))
        .filter((o) => o.value > 0)
    : [];

  const handleResume = async (campaignId, tenantId) => {
    setResumingId(campaignId);
    try {
      await apiPost(`/api/campaigns/${campaignId}/resume?tenantId=${tenantId}`);
      load();
    } catch (err) {
      setError(err.message);
    } finally {
      setResumingId(null);
    }
  };

  const portPct = overview?.portCapacity
    ? Math.round((overview.portCapacity.registered_ports / Math.max(1, overview.portCapacity.total_ports)) * 100)
    : 0;

  const ACTIVITY_ICON = { dnc: Ban, topup: CreditCard, cancelled: XCircle };
  const ACTIVITY_COLOR = {
    dnc: 'text-brand-600 dark:text-neon-green bg-brand-50 dark:bg-neon-green/10',
    topup: 'text-brand-600 dark:text-neon-cyan bg-brand-50 dark:bg-neon-cyan/10',
    cancelled: 'text-coral-600 dark:text-coral-400 bg-coral-50 dark:bg-coral-500/10'
  };
  const activityText = (a) => {
    if (a.type === 'dnc') return `Opt-out recorded${a.tenant_name ? ` · ${a.tenant_name}` : ''}`;
    if (a.type === 'topup') return `${a.tenant_name} topped up ${a.detail} credits`;
    return `${a.tenant_name} / ${a.detail} cancelled`;
  };

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-xl font-semibold text-slate-900 dark:text-white dark:font-display">{greeting()}, {user?.username}</h1>
          <p className="text-sm text-slate-500 dark:text-abyss-50">Here's what's happening across every client right now.</p>
        </div>
        <Link
          to="/admin/onboard"
          className="flex items-center gap-2 bg-brand-600 hover:bg-brand-700 dark:bg-neon-cyan/10 dark:hover:bg-neon-cyan/20 dark:text-neon-cyan dark:shadow-[0_0_16px_-4px_rgba(0,240,255,0.5)] dark:border dark:border-neon-cyan/30 text-white text-sm font-medium px-4 py-2 rounded-md"
        >
          <Plus className="w-4 h-4" />
          Onboard Client
        </Link>
      </div>

      {error && (
        <div className="flex items-center gap-2 text-sm text-red-600 bg-red-50 dark:bg-red-400/10 dark:text-red-300 rounded-md px-3 py-2">
          <AlertCircle className="w-4 h-4" /> {error}
        </div>
      )}

      {!alertDismissed && overview?.lowBalanceClients?.length > 0 && (
        <div className="flex items-center gap-3 bg-amber-50 dark:bg-amber-400/10 border border-amber-200 dark:border-amber-400/20 rounded-lg px-4 py-3 text-sm">
          <Wallet className="w-4 h-4 text-amber-600 dark:text-amber-400 shrink-0" />
          <span className="text-amber-900 dark:text-amber-200 flex-1">
            <strong>Credit safety:</strong> {overview.lowBalanceClients.length} client wallet{overview.lowBalanceClients.length > 1 ? 's' : ''} need attention before their next campaign window —{' '}
            {overview.lowBalanceClients.slice(0, 3).map((c) => c.name).join(', ')}
            {overview.lowBalanceClients.length > 3 ? ', …' : ''}.
          </span>
          <button onClick={() => setAlertDismissed(true)} className="text-amber-600 dark:text-amber-400 hover:text-amber-800 dark:hover:text-amber-200 shrink-0">
            <X className="w-4 h-4" />
          </button>
        </div>
      )}

      <div className="flex items-center justify-between">
        <div>
          <p className="text-[11px] font-semibold tracking-wide uppercase text-brand-600 dark:text-neon-cyan">Platform Pulse</p>
          <h2 className="text-lg font-semibold text-ink-900 dark:text-white">Operations Overview</h2>
        </div>
        <div className="flex items-center bg-brand-50 dark:bg-abyss-400/40 rounded-lg p-1 text-xs font-medium">
          {[['today', 'Today'], ['14d', '14 days'], ['30d', '30 days']].map(([key, label]) => (
            <button
              key={key}
              onClick={() => setRange(key)}
              className={`px-3 py-1.5 rounded-md transition-colors ${
                range === key
                  ? 'bg-brand-600 dark:bg-neon-cyan/15 text-white dark:text-neon-cyan dark:shadow-[0_0_10px_rgba(0,240,255,0.4)]'
                  : 'text-ink-500 dark:text-abyss-50 hover:text-ink-900 dark:hover:text-white'
              }`}
            >
              {label}
            </button>
          ))}
        </div>
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
        <StatCard icon={Building2} label="Active Clients" value={overview ? overview.totalTenants : '...'} accent="cyan" />
        <StatCard icon={Megaphone} label="Total Campaigns" value={overview ? overview.totalCampaigns : '...'} accent="purple" />
        <StatCard icon={PhoneCall} label="Calls Dialed" value={overview ? overview.totalDialed.toLocaleString() : '...'} sub="Across all tenants" accent="cyan" />
        <StatCard icon={TrendingUp} label="Success Rate" value={overview ? `${successRate}%` : '...'} accent="green" />
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
        <div className="lg:col-span-2">
          <CardShell title="Answered vs Rejected" sub={`Call outcomes · ${range === 'today' ? 'today' : `last ${RANGE_DAYS[range]} days`}`} icon={TrendingUp}>
            {trendData.length === 0 ? (
              <p className="text-sm text-slate-400 dark:text-abyss-100 py-16 text-center">No dialed calls in this window yet.</p>
            ) : (
              <div className="chart-glow-cyan">
                <ResponsiveContainer width="100%" height={240}>
                  <LineChart data={trendData}>
                    <CartesianGrid strokeDasharray="3 3" stroke={colors.grid} />
                    <XAxis dataKey="day" stroke={colors.text} fontSize={12} tickLine={false} />
                    <YAxis stroke={colors.text} fontSize={12} tickLine={false} allowDecimals={false} />
                    <Tooltip
                      contentStyle={{
                        background: theme === 'dark' ? '#0d0f17' : '#fff',
                        border: `1px solid ${theme === 'dark' ? 'rgba(0,240,255,0.2)' : '#e2e8f0'}`,
                        borderRadius: 8,
                        fontSize: 13
                      }}
                      labelStyle={{ color: colors.text }}
                    />
                    <Line type="monotone" dataKey="Answered" stroke={theme === 'dark' ? '#00ff66' : '#4e948f'} strokeWidth={2} dot={false} />
                    <Line type="monotone" dataKey="Rejected" stroke={colors.secondary} strokeWidth={2} dot={false} />
                  </LineChart>
                </ResponsiveContainer>
              </div>
            )}
          </CardShell>
        </div>

        <CardShell title="Outcome Mix" sub={overview ? `${overview.totalDialed.toLocaleString()} total calls` : ''} icon={PhoneCall}>
          {outcomeChartData.length === 0 ? (
            <p className="text-sm text-slate-400 dark:text-abyss-100 py-16 text-center">No calls dialed yet.</p>
          ) : (
            <div className="flex items-center gap-4">
              <div className="relative w-28 h-28 shrink-0 dark:drop-shadow-[0_0_10px_rgba(0,240,255,0.3)]">
                <ResponsiveContainer width="100%" height="100%">
                  <PieChart>
                    <Pie data={outcomeChartData} dataKey="value" nameKey="name" innerRadius="65%" outerRadius="100%" paddingAngle={3} stroke="none">
                      {outcomeChartData.map((o) => <Cell key={o.name} fill={o.color} />)}
                    </Pie>
                    <Tooltip contentStyle={{ background: theme === 'dark' ? '#0d0f17' : '#fff', border: `1px solid ${theme === 'dark' ? 'rgba(0,240,255,0.2)' : '#e2e8f0'}`, borderRadius: 8, fontSize: 13 }} />
                  </PieChart>
                </ResponsiveContainer>
                <div className="absolute inset-0 flex flex-col items-center justify-center pointer-events-none">
                  <span className="text-lg font-semibold font-display text-ink-900 dark:text-white">{successRate}%</span>
                  <span className="text-[9px] text-ink-400 dark:text-abyss-50">answered</span>
                </div>
              </div>
              <div className="space-y-1.5 min-w-0 flex-1">
                {outcomeChartData.map((o) => (
                  <div key={o.name} className="flex items-center gap-2 text-xs">
                    <span className="w-2 h-2 rounded-full shrink-0" style={{ backgroundColor: o.color, boxShadow: theme === 'dark' ? `0 0 6px ${o.color}` : 'none' }} />
                    <span className="text-ink-700 dark:text-slate-300 truncate">{o.name}</span>
                    <span className="text-ink-400 dark:text-abyss-50 ml-auto">{o.value.toLocaleString()}</span>
                  </div>
                ))}
              </div>
            </div>
          )}
        </CardShell>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
        <CardShell title="Most Active Clients" sub="By dialed calls" icon={Building2} action={<Link to="/admin" className="text-xs text-brand-600 dark:text-neon-cyan hover:underline">View all</Link>}>
          {!overview?.topTenants?.length ? (
            <p className="text-sm text-slate-400 dark:text-abyss-100 py-6 text-center">No activity yet.</p>
          ) : (
            <div className="space-y-3">
              {overview.topTenants.map((t) => {
                const max = overview.topTenants[0].dialed || 1;
                return (
                  <div key={t.name} className="flex items-center gap-2.5">
                    <span className="w-7 h-7 shrink-0 rounded-full bg-brand-50 dark:bg-neon-cyan/10 text-brand-700 dark:text-neon-cyan text-[10px] font-bold flex items-center justify-center">
                      {initials(t.name)}
                    </span>
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center justify-between text-xs mb-1">
                        <span className="text-ink-900 dark:text-slate-200 truncate">{t.name}</span>
                        <span className="text-ink-400 dark:text-abyss-50 shrink-0 ml-2">{t.dialed}</span>
                      </div>
                      <div className="h-1.5 bg-brand-50 dark:bg-abyss-400/60 rounded-full overflow-hidden">
                        <div className="h-full rounded-full bg-brand-500 dark:bg-neon-cyan dark:shadow-[0_0_8px_rgba(0,240,255,0.8)]" style={{ width: `${Math.max(4, (t.dialed / max) * 100)}%` }} />
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </CardShell>

        <CardShell title="Port Capacity" sub={overview?.portCapacity ? `${overview.portCapacity.registered_ports} of ${overview.portCapacity.total_ports} lines in use` : ''} icon={Radio}>
          {overview?.portCapacity && (
            <>
              <div className="flex items-center justify-between text-xs mb-1.5">
                <span className="text-ink-700 dark:text-slate-300">Overall utilization</span>
                <span className="text-ink-900 dark:text-white font-semibold">{portPct}%</span>
              </div>
              <div className="h-2.5 bg-brand-50 dark:bg-abyss-400/60 rounded-full overflow-hidden mb-2">
                <div
                  className={`h-full rounded-full ${portPct > 90 ? 'bg-amber-500' : 'bg-brand-500 dark:bg-neon-cyan dark:shadow-[0_0_8px_rgba(0,240,255,0.8)]'}`}
                  style={{ width: `${portPct}%` }}
                />
              </div>
              <p className="text-xs text-ink-400 dark:text-abyss-50">
                {Math.max(0, overview.portCapacity.total_ports - overview.portCapacity.registered_ports)} lines available for new work
              </p>
            </>
          )}
        </CardShell>

        <CardShell
          title="Live Call Room"
          sub={`${overview?.liveCalls?.length || 0} active connections now`}
          icon={PhoneCall}
          action={overview?.liveCalls?.length > 0 && (
            <span className="flex items-center gap-1.5 text-[10px] font-semibold text-coral-600 dark:text-neon-green">
              <span className="relative flex h-1.5 w-1.5">
                <span className="absolute inline-flex h-full w-full rounded-full bg-coral-500 dark:bg-neon-green opacity-75 animate-ping" />
                <span className="relative inline-flex h-1.5 w-1.5 rounded-full bg-coral-500 dark:bg-neon-green" />
              </span>
              LIVE
            </span>
          )}
        >
          {!overview?.liveCalls?.length ? (
            <p className="text-sm text-slate-400 dark:text-abyss-100 py-6 text-center">No calls in progress right now.</p>
          ) : (
            <div className="space-y-2 max-h-52 overflow-y-auto">
              {overview.liveCalls.map((c) => (
                <div key={c.lead_id} className="flex items-center gap-2 text-xs">
                  <UserRound className="w-3.5 h-3.5 text-ink-300 dark:text-abyss-100 shrink-0" />
                  <span className="text-ink-900 dark:text-slate-200 truncate flex-1">{c.tenant_name} · {c.campaign_name}</span>
                  <span className="text-ink-400 dark:text-abyss-50 shrink-0 font-mono">{timeAgo(c.dispatched_at)}</span>
                </div>
              ))}
            </div>
          )}
        </CardShell>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
        <div className="lg:col-span-2">
          <CardShell title="Campaign Control" sub="The work requiring your attention" icon={ShieldAlert}>
            {!overview?.attentionCampaigns?.length ? (
              <p className="text-sm text-slate-400 dark:text-abyss-100 py-6 text-center">Nothing needs attention right now.</p>
            ) : (
              <div className="space-y-2">
                {overview.attentionCampaigns.map((c) => (
                  <div key={c.id} className="flex items-center justify-between gap-3 bg-amber-50 dark:bg-amber-400/10 border border-amber-200 dark:border-amber-400/20 rounded-lg px-3 py-2.5">
                    <div className="min-w-0">
                      <div className="text-sm font-medium text-ink-900 dark:text-white truncate">{c.tenant_name} / {c.name}</div>
                      <div className="text-xs text-amber-700 dark:text-amber-300">
                        {c.status === 'paused' ? 'Paused' : `Low balance (${c.credit_balance} credits)`} · {c.processed_leads}/{c.total_leads} leads
                      </div>
                    </div>
                    {c.status === 'paused' && (
                      <button
                        onClick={() => handleResume(c.id, c.tenant_id)}
                        disabled={resumingId === c.id}
                        className="flex items-center gap-1 shrink-0 bg-ink-900 dark:bg-neon-green/15 text-white dark:text-neon-green text-xs font-medium px-3 py-1.5 rounded-md disabled:opacity-50"
                      >
                        <Play className="w-3 h-3" /> {resumingId === c.id ? 'Resuming…' : 'Resume'}
                      </button>
                    )}
                  </div>
                ))}
              </div>
            )}
          </CardShell>
        </div>

        <CardShell title="Recent Activity" sub="Latest safety & billing events" icon={ShieldAlert}>
          {!overview?.recentActivity?.length ? (
            <p className="text-sm text-slate-400 dark:text-abyss-100 py-6 text-center">No recent activity.</p>
          ) : (
            <div className="space-y-3">
              {overview.recentActivity.map((a, i) => {
                const Icon = ACTIVITY_ICON[a.type];
                return (
                  <div key={i} className="flex items-start gap-2.5">
                    <span className={`w-6 h-6 rounded-full flex items-center justify-center shrink-0 ${ACTIVITY_COLOR[a.type]}`}>
                      <Icon className="w-3 h-3" />
                    </span>
                    <div className="min-w-0">
                      <div className="text-xs text-ink-900 dark:text-slate-200 truncate">{activityText(a)}</div>
                      <div className="text-[11px] text-ink-400 dark:text-abyss-50">{timeAgo(a.at)}</div>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </CardShell>
      </div>

      <section className="space-y-3">
        <h2 className="font-medium text-ink-900 dark:text-white">Tenants</h2>
        <DataTable
          rows={tenants || []}
          emptyMessage={tenants ? 'No tenants onboarded yet.' : 'Loading...'}
          columns={[
            {
              key: 'name',
              label: 'Tenant',
              render: (t) => (
                <Link to={`/admin/tenants/${t.id}`} className="flex items-center gap-2 text-slate-900 dark:text-white font-medium hover:text-brand-600 dark:hover:text-neon-cyan">
                  <Users className="w-4 h-4 text-slate-400" />
                  {t.name}
                </Link>
              )
            },
            { key: 'subdomain', label: 'Subdomain' },
            { key: 'status', label: 'Status', render: (t) => <StatusBadge status={t.status || 'active'} /> },
            { key: 'admin_count', label: 'Admins' },
            {
              key: 'ports',
              label: 'Ports',
              render: (t) => {
                const p = portsByTenant(t.id);
                return p.length ? p.join(', ') : <span className="text-slate-400">none</span>;
              }
            },
            {
              key: 'created_at',
              label: 'Onboarded',
              render: (t) => new Date(t.created_at).toLocaleDateString()
            }
          ]}
        />
      </section>
    </div>
  );
}
