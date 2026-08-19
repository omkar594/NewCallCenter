import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { Plus, AlertCircle, CalendarRange, X, PhoneCall, TrendingUp, ShieldAlert, Target } from 'lucide-react';
import { ResponsiveContainer, LineChart, Line, CartesianGrid, XAxis, YAxis, Tooltip } from 'recharts';
import { apiGet } from '../../api/client.js';
import { useTheme } from '../../context/ThemeContext.jsx';
import DataTable from '../../components/DataTable.jsx';
import StatusBadge from '../../components/StatusBadge.jsx';

// YYYY-MM-DD in the browser's local timezone (Date#toISOString gives UTC, which can land on the
// wrong day for the user) - matches what a native <input type="date"> expects/returns.
function toDateInputValue(date) {
  const offsetMs = date.getTimezoneOffset() * 60000;
  return new Date(date.getTime() - offsetMs).toISOString().slice(0, 10);
}

const PRESETS = [
  { label: 'Today', days: 0 },
  { label: 'Last 7 days', days: 6 },
  { label: 'Last 30 days', days: 29 }
];

const PALETTE = {
  light: { primary: '#168f84', secondary: '#df775f', grid: '#e9efec', text: '#a1afac' },
  dark: { primary: '#5fd4c4', secondary: '#df775f', grid: 'rgba(255,255,255,0.08)', text: '#9db5b2' }
};

function MetricCard({ icon: Icon, label, value, detail, accent = 'cyan' }) {
  const ACCENTS = {
    cyan: 'dark:text-neon-cyan dark:bg-neon-cyan/10 bg-brand-50 text-brand-600',
    green: 'dark:text-neon-green dark:bg-neon-green/10 bg-emerald-50 text-emerald-600',
    amber: 'dark:text-amber-300 dark:bg-amber-400/10 bg-amber-50 text-amber-600'
  };
  return (
    <div className="bg-surface dark:bg-abyss-500 border border-line dark:border-abyss-300/40 rounded-2xl p-4 shadow-card">
      <div className={`w-9 h-9 rounded-lg flex items-center justify-center ${ACCENTS[accent]}`}>
        <Icon className="w-4 h-4" />
      </div>
      <div className="text-2xl font-semibold font-display text-ink-900 dark:text-white mt-3 leading-none">{value}</div>
      <div className="text-xs text-ink-400 dark:text-abyss-50 mt-2">{label}</div>
      {detail && <div className="text-[11px] text-ink-300 dark:text-abyss-100 mt-0.5">{detail}</div>}
    </div>
  );
}

export default function Campaigns() {
  const { theme } = useTheme();
  const colors = PALETTE[theme] || PALETTE.light;
  const [campaigns, setCampaigns] = useState(null);
  const [overview, setOverview] = useState(null);
  const [error, setError] = useState('');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');

  useEffect(() => {
    apiGet('/api/analytics/tenant-overview').then(setOverview).catch(() => {});
  }, []);

  useEffect(() => {
    const params = new URLSearchParams();
    if (from) params.set('from', from);
    if (to) params.set('to', to);
    const query = params.toString();
    setCampaigns(null);
    apiGet(`/api/campaigns${query ? `?${query}` : ''}`).then(setCampaigns).catch((err) => setError(err.message));
  }, [from, to]);

  const applyPreset = (days) => {
    const end = new Date();
    const start = new Date();
    start.setDate(start.getDate() - days);
    setFrom(toDateInputValue(start));
    setTo(toDateInputValue(end));
  };

  const clearFilter = () => {
    setFrom('');
    setTo('');
  };

  const successRate = overview && overview.totalDialed > 0
    ? Math.round((overview.outcomeCounts.answered / overview.totalDialed) * 100)
    : 0;
  const rejected = overview ? overview.outcomeCounts.busy + overview.outcomeCounts.failed + overview.outcomeCounts['no-answer'] : 0;
  const trendData = (overview?.dailyTrend || []).map((d) => ({
    day: new Date(d.day).toLocaleDateString(undefined, { month: 'short', day: 'numeric' }),
    Answered: d.answered,
    Rejected: d.rejected
  }));

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <p className="text-[11px] font-bold uppercase tracking-wider text-brand-600 dark:text-neon-cyan">Reports workspace</p>
          <h1 className="mt-1 text-xl font-semibold font-display text-ink-900 dark:text-white">Campaigns & call activity</h1>
          <p className="text-sm text-ink-500 dark:text-abyss-50 mt-1">Every broadcast you've run, and what it's turned into.</p>
        </div>
        <Link
          to="/app/campaigns/new"
          className="flex items-center gap-2 bg-brand-600 hover:bg-brand-700 dark:bg-neon-cyan/10 dark:hover:bg-neon-cyan/20 dark:text-neon-cyan dark:border dark:border-neon-cyan/30 text-white text-sm font-medium px-4 py-2 rounded-md"
        >
          <Plus className="w-4 h-4" /> New Campaign
        </Link>
      </div>

      {overview && (
        <>
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-4">
            <MetricCard icon={PhoneCall} label="Total Attempts" value={overview.totalDialed.toLocaleString()} accent="cyan" />
            <MetricCard icon={TrendingUp} label="Answered" value={overview.outcomeCounts.answered.toLocaleString()} detail={`${successRate}% answer rate`} accent="green" />
            <MetricCard icon={ShieldAlert} label="Needs Attention" value={rejected.toLocaleString()} detail="Busy + failed + no answer" accent="amber" />
            <MetricCard icon={Target} label="Active Campaigns" value={campaigns ? campaigns.filter((c) => c.status === 'running' || c.status === 'preparing').length : '...'} accent="cyan" />
          </div>

          {trendData.length > 1 && (
            <div className="bg-surface dark:bg-abyss-500 border border-line dark:border-abyss-300/40 rounded-2xl p-5">
              <h2 className="font-medium text-ink-900 dark:text-white flex items-center gap-2 mb-1">
                <TrendingUp className="w-4 h-4 text-brand-500 dark:text-neon-cyan" /> Activity Trend
              </h2>
              <p className="text-xs text-ink-400 dark:text-abyss-50 mb-4">Answered vs rejected · last 14 days</p>
              <div className="chart-glow-cyan">
                <ResponsiveContainer width="100%" height={180}>
                  <LineChart data={trendData}>
                    <CartesianGrid strokeDasharray="3 3" stroke={colors.grid} />
                    <XAxis dataKey="day" stroke={colors.text} fontSize={11} tickLine={false} />
                    <YAxis stroke={colors.text} fontSize={11} tickLine={false} allowDecimals={false} />
                    <Tooltip contentStyle={{ background: theme === 'dark' ? '#183438' : '#fff', border: `1px solid ${theme === 'dark' ? 'rgba(95,212,196,0.2)' : '#e9efec'}`, borderRadius: 8, fontSize: 13 }} />
                    <Line type="monotone" dataKey="Answered" stroke={theme === 'dark' ? '#a8db4e' : '#168f84'} strokeWidth={2} dot={false} />
                    <Line type="monotone" dataKey="Rejected" stroke={colors.secondary} strokeWidth={2} dot={false} />
                  </LineChart>
                </ResponsiveContainer>
              </div>
            </div>
          )}
        </>
      )}

      <div className="flex flex-wrap items-center gap-2 bg-surface dark:bg-abyss-500 border border-line dark:border-abyss-300/40 rounded-xl p-3">
        <CalendarRange className="w-4 h-4 text-ink-400 dark:text-abyss-100 shrink-0" />
        <input
          type="date"
          value={from}
          max={to || undefined}
          onChange={(e) => setFrom(e.target.value)}
          className="text-sm border border-line dark:border-abyss-300/30 rounded-md px-2 py-1 text-ink-700 dark:text-slate-200"
        />
        <span className="text-sm text-ink-400 dark:text-abyss-100">to</span>
        <input
          type="date"
          value={to}
          min={from || undefined}
          onChange={(e) => setTo(e.target.value)}
          className="text-sm border border-line dark:border-abyss-300/30 rounded-md px-2 py-1 text-ink-700 dark:text-slate-200"
        />
        <div className="flex flex-wrap items-center gap-1.5 ml-1">
          {PRESETS.map((p) => (
            <button
              key={p.label}
              type="button"
              onClick={() => applyPreset(p.days)}
              className="text-xs font-medium text-ink-600 dark:text-slate-300 bg-ink-50 dark:bg-abyss-400/40 hover:bg-ink-100 rounded-full px-3 py-1"
            >
              {p.label}
            </button>
          ))}
          {(from || to) && (
            <button
              type="button"
              onClick={clearFilter}
              className="flex items-center gap-1 text-xs font-medium text-ink-500 dark:text-abyss-50 hover:text-ink-700 px-2 py-1"
            >
              <X className="w-3 h-3" /> Clear
            </button>
          )}
        </div>
      </div>

      {error && (
        <div className="flex items-center gap-2 text-sm text-red-600 dark:text-red-300 bg-red-50 dark:bg-red-400/10 rounded-md px-3 py-2">
          <AlertCircle className="w-4 h-4" /> {error}
        </div>
      )}

      <DataTable
        rows={campaigns || []}
        emptyMessage={campaigns ? 'No campaigns yet.' : 'Loading...'}
        columns={[
          {
            key: 'name',
            label: 'Name',
            render: (c) => <Link to={`/app/campaigns/${c.id}`} className="text-ink-900 dark:text-white font-medium hover:text-brand-600 dark:hover:text-neon-cyan">{c.name}</Link>
          },
          { key: 'status', label: 'Status', render: (c) => <StatusBadge status={c.status} /> },
          { key: 'total_leads', label: 'Leads' },
          { key: 'processed_leads', label: 'Processed' },
          { key: 'answered_count', label: 'Answered' },
          { key: 'failed_count', label: 'Failed' },
          { key: 'allowed_ports', label: 'Ports' },
          { key: 'created_at', label: 'Created', render: (c) => new Date(c.created_at).toLocaleString() }
        ]}
      />
    </div>
  );
}
