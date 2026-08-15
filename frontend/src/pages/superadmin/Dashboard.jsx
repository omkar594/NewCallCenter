import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import {
  Users, Plus, AlertCircle, Megaphone, PhoneCall, TrendingUp, Building2
} from 'lucide-react';
import {
  ResponsiveContainer, LineChart, Line, CartesianGrid, XAxis, YAxis, Tooltip, Legend,
  BarChart, Bar
} from 'recharts';
import { apiGet } from '../../api/client.js';
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
  green: { icon: 'dark:text-neon-green', ring: 'dark:shadow-[0_0_20px_-4px_rgba(0,255,102,0.35)] dark:hover:shadow-[0_0_24px_-2px_rgba(0,255,102,0.5)]', bg: 'dark:bg-neon-green/10' },
  coral: { icon: 'dark:text-coral-400', ring: 'dark:shadow-[0_0_20px_-4px_rgba(255,99,99,0.35)] dark:hover:shadow-[0_0_24px_-2px_rgba(255,99,99,0.5)]', bg: 'dark:bg-coral-500/10' }
};

function StatCard({ icon: Icon, label, value, accent = 'cyan' }) {
  const a = ACCENTS[accent];
  return (
    <div className={`bg-white dark:bg-abyss-500/60 dark:backdrop-blur border border-brand-100 dark:border-white/10 rounded-xl p-5 flex items-center gap-4 shadow-sm transition-shadow ${a.ring}`}>
      <div className={`w-10 h-10 rounded-lg flex items-center justify-center bg-brand-50 text-brand-600 ${a.bg} ${a.icon}`}>
        <Icon className="w-5 h-5" />
      </div>
      <div>
        <div className="text-2xl font-semibold font-display text-ink-900 dark:text-white">{value}</div>
        <div className="text-xs text-ink-400 dark:text-abyss-50">{label}</div>
      </div>
    </div>
  );
}

const CardShell = ({ title, icon: Icon, children }) => (
  <div className="bg-white dark:bg-abyss-500/60 dark:backdrop-blur border border-brand-100 dark:border-white/10 rounded-xl p-5 dark:shadow-[0_0_20px_-8px_rgba(0,240,255,0.25)]">
    <h2 className="font-medium text-ink-900 dark:text-white flex items-center gap-2 mb-4">
      {Icon && <Icon className="w-4 h-4 text-brand-500 dark:text-neon-cyan" />}
      {title}
    </h2>
    {children}
  </div>
);

export default function SuperAdminDashboard() {
  const { theme } = useTheme();
  const colors = PALETTE[theme] || PALETTE.light;
  const [tenants, setTenants] = useState(null);
  const [ports, setPorts] = useState([]);
  const [overview, setOverview] = useState(null);
  const [error, setError] = useState('');

  useEffect(() => {
    Promise.all([apiGet('/api/auth/clients'), apiGet('/api/gateways/ports'), apiGet('/api/analytics/admin-overview')])
      .then(([tenantRows, portRows, overviewData]) => {
        setTenants(tenantRows);
        setPorts(portRows);
        setOverview(overviewData);
      })
      .catch((err) => setError(err.message));
  }, []);

  const portsByTenant = (tenantId) => ports.filter((p) => p.tenant_id === tenantId).map((p) => p.port_number).sort((a, b) => a - b);

  const successRate = overview && overview.totalDialed > 0
    ? Math.round((overview.outcomeCounts.answered / overview.totalDialed) * 100)
    : 0;

  const trendData = (overview?.dailyTrend || []).map((d) => ({
    day: new Date(d.day).toLocaleDateString(undefined, { month: 'short', day: 'numeric' }),
    Answered: d.answered,
    Rejected: d.rejected
  }));

  const outcomeBarData = overview ? [
    { name: 'Answered', value: overview.outcomeCounts.answered },
    { name: 'Busy', value: overview.outcomeCounts.busy },
    { name: 'Failed', value: overview.outcomeCounts.failed },
    { name: 'No Answer', value: overview.outcomeCounts['no-answer'] }
  ] : [];

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-xl font-semibold text-slate-900 dark:text-white dark:font-display flex items-center gap-2">
            Platform Overview
            <span className="relative flex h-2 w-2">
              <span className="absolute inline-flex h-full w-full rounded-full bg-emerald-400 dark:bg-neon-green opacity-75 animate-ping" />
              <span className="relative inline-flex h-2 w-2 rounded-full bg-emerald-500 dark:bg-neon-green" />
            </span>
          </h1>
          <p className="text-sm text-slate-500 dark:text-abyss-50">Live across every tenant on this platform.</p>
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

      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
        <StatCard icon={Building2} label="Active Clients" value={overview ? overview.totalTenants : '...'} accent="cyan" />
        <StatCard icon={Megaphone} label="Total Campaigns" value={overview ? overview.totalCampaigns : '...'} accent="purple" />
        <StatCard icon={PhoneCall} label="Calls Dialed" value={overview ? overview.totalDialed.toLocaleString() : '...'} accent="cyan" />
        <StatCard icon={TrendingUp} label="Success Rate" value={overview ? `${successRate}%` : '...'} accent="green" />
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
        <div className="lg:col-span-2">
          <CardShell title="Call Volume - Last 14 Days" icon={TrendingUp}>
            {trendData.length === 0 ? (
              <p className="text-sm text-slate-400 dark:text-abyss-100 py-12 text-center">No dialed calls in the last 14 days yet.</p>
            ) : (
              <ResponsiveContainer width="100%" height={260}>
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
                  <Legend wrapperStyle={{ fontSize: 12 }} />
                  <Line type="monotone" dataKey="Answered" stroke={theme === 'dark' ? '#00ff66' : '#4e948f'} strokeWidth={2} dot={false} />
                  <Line type="monotone" dataKey="Rejected" stroke={colors.secondary} strokeWidth={2} dot={false} />
                </LineChart>
              </ResponsiveContainer>
            )}
          </CardShell>
        </div>

        <CardShell title="Call Outcomes" icon={PhoneCall}>
          {overview && overview.totalDialed === 0 ? (
            <p className="text-sm text-slate-400 dark:text-abyss-100 py-12 text-center">No calls dialed yet.</p>
          ) : (
            <ResponsiveContainer width="100%" height={260}>
              <BarChart data={outcomeBarData} layout="vertical" margin={{ left: 10 }}>
                <CartesianGrid strokeDasharray="3 3" stroke={colors.grid} horizontal={false} />
                <XAxis type="number" stroke={colors.text} fontSize={12} allowDecimals={false} />
                <YAxis type="category" dataKey="name" stroke={colors.text} fontSize={12} width={80} tickLine={false} />
                <Tooltip
                  contentStyle={{
                    background: theme === 'dark' ? '#0d0f17' : '#fff',
                    border: `1px solid ${theme === 'dark' ? 'rgba(0,240,255,0.2)' : '#e2e8f0'}`,
                    borderRadius: 8,
                    fontSize: 13
                  }}
                />
                <Bar dataKey="value" fill={theme === 'dark' ? '#00f0ff' : '#4e948f'} radius={[0, 4, 4, 0]} />
              </BarChart>
            </ResponsiveContainer>
          )}
        </CardShell>
      </div>

      {overview?.topTenants?.length > 0 && (
        <CardShell title="Most Active Clients" icon={Building2}>
          <div className="space-y-2">
            {overview.topTenants.map((t, i) => {
              const max = overview.topTenants[0].dialed || 1;
              return (
                <div key={t.name} className="flex items-center gap-3">
                  <span className="text-xs text-slate-400 dark:text-abyss-100 w-4">{i + 1}</span>
                  <span className="text-sm text-ink-900 dark:text-slate-200 w-32 truncate">{t.name}</span>
                  <div className="flex-1 h-2 bg-brand-50 dark:bg-abyss-400/60 rounded-full overflow-hidden">
                    <div
                      className="h-full rounded-full bg-brand-500 dark:bg-neon-cyan dark:shadow-[0_0_8px_rgba(0,240,255,0.8)]"
                      style={{ width: `${Math.max(4, (t.dialed / max) * 100)}%` }}
                    />
                  </div>
                  <span className="text-xs text-slate-500 dark:text-abyss-50 w-14 text-right">{t.dialed} calls</span>
                </div>
              );
            })}
          </div>
        </CardShell>
      )}

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
