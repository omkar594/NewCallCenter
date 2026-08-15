import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import {
  Megaphone, Workflow, Server, AlertCircle, Coins, PhoneCall, User, TrendingUp, Target
} from 'lucide-react';
import {
  ResponsiveContainer, AreaChart, Area, LineChart, Line, CartesianGrid, XAxis, YAxis, Tooltip,
  RadialBarChart, RadialBar, PolarAngleAxis, Sankey
} from 'recharts';
import { apiGet } from '../../api/client.js';
import { useAuth } from '../../context/AuthContext.jsx';
import { useTheme } from '../../context/ThemeContext.jsx';
import DataTable from '../../components/DataTable.jsx';
import StatusBadge from '../../components/StatusBadge.jsx';

// Below this, the balance is flagged red so a client admin notices before a campaign gets
// auto-blocked (see campaignController.js's 402 gate) or an active one gets auto-cancelled
// mid-run (see bulkCampaignWorker.js's finalizeLead).
const LOW_CREDIT_THRESHOLD = 20;

// How often we re-fetch the actual list of live calls from the backend.
const LIVE_CALLS_POLL_MS = 4000;

// Chart colors can't be Tailwind classes (recharts renders raw SVG props) - kept in sync by hand
// with tailwind.config.js's neon/brand/coral scales.
const PALETTE = {
  light: { primary: '#4e948f', secondary: '#ff6363', grid: '#e2e8f0', text: '#64748b' },
  dark: { primary: '#00f0ff', secondary: '#ff6363', grid: 'rgba(255,255,255,0.08)', text: '#8892a6' }
};

// Dark-mode glow color per card, matching the neon/glassmorphism reference brief - each metric
// gets its own accent so the row reads as a real "analytical dashboard" rather than one flat tone.
const ACCENTS = {
  cyan: { icon: 'dark:text-neon-cyan', ring: 'dark:shadow-[0_0_20px_-4px_rgba(0,240,255,0.35)] dark:hover:shadow-[0_0_24px_-2px_rgba(0,240,255,0.5)]', bg: 'dark:bg-neon-cyan/10', stroke: '#00f0ff' },
  purple: { icon: 'dark:text-neon-purple', ring: 'dark:shadow-[0_0_20px_-4px_rgba(176,38,255,0.35)] dark:hover:shadow-[0_0_24px_-2px_rgba(176,38,255,0.5)]', bg: 'dark:bg-neon-purple/10', stroke: '#b026ff' },
  green: { icon: 'dark:text-neon-green', ring: 'dark:shadow-[0_0_20px_-4px_rgba(0,255,102,0.35)] dark:hover:shadow-[0_0_24px_-2px_rgba(0,255,102,0.5)]', bg: 'dark:bg-neon-green/10', stroke: '#00ff66' }
};

// `trend`: optional array of numbers rendered as a tiny inline sparkline (no axes/grid) behind
// the value - a fast "which way is this going" glance without opening a full chart.
function StatCard({ icon: Icon, label, value, warn, accent = 'cyan', trend }) {
  const a = ACCENTS[accent];
  const sparkData = trend?.map((v, i) => ({ i, v }));
  return (
    <div
      className={`bg-white dark:bg-abyss-500/60 dark:backdrop-blur border border-brand-100 dark:border-white/10 rounded-xl p-5 flex items-center gap-4 shadow-sm transition-shadow ${warn ? '' : a.ring}`}
    >
      <div className={`w-10 h-10 rounded-lg flex items-center justify-center shrink-0 ${warn ? 'bg-coral-50 text-coral-600 dark:bg-coral-500/10 dark:text-coral-400' : `bg-brand-50 text-brand-600 ${a.bg} ${a.icon}`}`}>
        <Icon className="w-5 h-5" />
      </div>
      <div className="flex-1 min-w-0">
        <div className={`text-2xl font-semibold font-display ${warn ? 'text-coral-600 dark:text-coral-400' : 'text-ink-900 dark:text-white'}`}>{value}</div>
        <div className="text-xs text-ink-400 dark:text-abyss-50">{label}</div>
      </div>
      {sparkData && sparkData.length > 1 && (
        <div className="w-16 h-8 shrink-0">
          <ResponsiveContainer width="100%" height="100%">
            <AreaChart data={sparkData}>
              <defs>
                <linearGradient id={`spark-${label}`} x1="0" y1="0" x2="0" y2="1">
                  <stop offset="0%" stopColor={warn ? '#ff6363' : a.stroke} stopOpacity={0.5} />
                  <stop offset="100%" stopColor={warn ? '#ff6363' : a.stroke} stopOpacity={0} />
                </linearGradient>
              </defs>
              <Area type="monotone" dataKey="v" stroke={warn ? '#ff6363' : a.stroke} strokeWidth={1.5} fill={`url(#spark-${label})`} />
            </AreaChart>
          </ResponsiveContainer>
        </div>
      )}
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

// Radial progress ring for a 0-100% metric - RadialBarChart with a single bar drawn as a full
// circle background track + the actual value arc on top, percentage label centered via absolute
// positioning (recharts has no built-in center-label primitive).
function RadialStat({ label, percent, color }) {
  const data = [{ value: percent, fill: color }];
  return (
    <div className="flex flex-col items-center">
      <div className="relative w-28 h-28">
        <ResponsiveContainer width="100%" height="100%">
          <RadialBarChart innerRadius="75%" outerRadius="100%" data={data} startAngle={90} endAngle={-270}>
            <PolarAngleAxis type="number" domain={[0, 100]} angleAxisId={0} tick={false} />
            <RadialBar dataKey="value" cornerRadius={8} background={{ fill: 'rgba(120,130,150,0.15)' }} />
          </RadialBarChart>
        </ResponsiveContainer>
        <div className="absolute inset-0 flex items-center justify-center">
          <span className="text-xl font-semibold font-display text-ink-900 dark:text-white">{percent}%</span>
        </div>
      </div>
      <span className="text-xs text-ink-400 dark:text-abyss-50 mt-1">{label}</span>
    </div>
  );
}

function formatDuration(seconds) {
  const s = Math.max(0, seconds);
  const mm = String(Math.floor(s / 60)).padStart(2, '0');
  const ss = String(s % 60).padStart(2, '0');
  return `${mm}:${ss}`;
}

function OngoingCallCard({ call, nowMs }) {
  const elapsedSec = Math.floor((nowMs - new Date(call.dispatched_at).getTime()) / 1000);
  return (
    <div className="bg-white dark:bg-abyss-500/60 dark:backdrop-blur border border-brand-100 dark:border-neon-green/20 rounded-xl p-4 shadow-sm dark:shadow-[0_0_16px_-4px_rgba(0,255,102,0.3)]">
      <div className="flex items-start justify-between gap-2">
        <div className="flex items-center gap-2 min-w-0">
          <span className="w-9 h-9 shrink-0 rounded-full bg-brand-50 text-brand-600 dark:bg-neon-green/10 dark:text-neon-green flex items-center justify-center">
            <User className="w-4 h-4" />
          </span>
          <div className="min-w-0">
            <div className="text-sm font-medium text-ink-900 dark:text-white truncate">{call.customer_name || 'Unknown'}</div>
            <div className="text-xs text-ink-400 dark:text-abyss-50 truncate">{call.phone_number}</div>
          </div>
        </div>
        <span className="shrink-0 inline-flex items-center gap-1.5 bg-coral-50 text-coral-600 dark:bg-neon-green/10 dark:text-neon-green text-xs font-medium px-2 py-1 rounded-full">
          <span className="relative flex h-1.5 w-1.5">
            <span className="absolute inline-flex h-full w-full rounded-full bg-coral-500 dark:bg-neon-green opacity-75 animate-ping" />
            <span className="relative inline-flex h-1.5 w-1.5 rounded-full bg-coral-500 dark:bg-neon-green" />
          </span>
          {formatDuration(elapsedSec)}
        </span>
      </div>
      <div className="mt-3 flex items-center gap-1.5 text-xs text-brand-700 bg-brand-50 dark:bg-white/5 dark:text-abyss-50 rounded-md px-2 py-1 truncate">
        <Megaphone className="w-3 h-3 shrink-0" />
        <span className="truncate">{call.campaign_name}</span>
      </div>
    </div>
  );
}

export default function TenantDashboard() {
  const { user } = useAuth();
  const { theme } = useTheme();
  const colors = PALETTE[theme] || PALETTE.light;
  const [campaigns, setCampaigns] = useState([]);
  const [flows, setFlows] = useState([]);
  const [ports, setPorts] = useState([]);
  const [credits, setCredits] = useState(null);
  const [overview, setOverview] = useState(null);
  const [liveCalls, setLiveCalls] = useState([]);
  const [now, setNow] = useState(Date.now());
  const [error, setError] = useState('');
  const liveCallsTimerRef = useRef(null);

  useEffect(() => {
    Promise.all([
      apiGet('/api/campaigns'),
      apiGet('/api/ivr/flows'),
      apiGet('/api/gateways/ports'),
      apiGet('/api/auth/credits'),
      apiGet('/api/analytics/tenant-overview')
    ])
      .then(([c, f, p, cr, ov]) => {
        setCampaigns(c);
        setFlows(f);
        setPorts(p);
        setCredits(cr.balance);
        setOverview(ov);
      })
      .catch((err) => setError(err.message));
  }, []);

  // Poll the real "who's on a call right now" list. Keeps running for as long as the Dashboard
  // is mounted - unlike CampaignDetail.jsx's polling, this never stops on its own since a new
  // call can start at any moment.
  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      try {
        const data = await apiGet('/api/campaigns/live-calls');
        if (!cancelled) setLiveCalls(data);
      } catch {
        // Transient poll failures shouldn't blank out the rest of the dashboard.
      }
      if (!cancelled) {
        liveCallsTimerRef.current = setTimeout(load, LIVE_CALLS_POLL_MS);
      }
    };
    load();
    return () => {
      cancelled = true;
      if (liveCallsTimerRef.current) clearTimeout(liveCallsTimerRef.current);
    };
  }, []);

  // Ticks every second purely locally (no network) so each ongoing call's duration badge
  // counts up smoothly between the 4s data polls above.
  useEffect(() => {
    const interval = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(interval);
  }, []);

  const successRate = overview && overview.totalDialed > 0
    ? Math.round((overview.outcomeCounts.answered / overview.totalDialed) * 100)
    : 0;

  const totalLeadsAcrossCampaigns = campaigns.reduce((sum, c) => sum + (c.total_leads || 0), 0);
  const processedAcrossCampaigns = campaigns.reduce((sum, c) => sum + (c.processed_leads || 0), 0);
  const completionRate = totalLeadsAcrossCampaigns > 0
    ? Math.round((processedAcrossCampaigns / totalLeadsAcrossCampaigns) * 100)
    : 0;

  const creditSparkline = (overview?.creditHistory || []).map((h) => h.balance);

  const creditChartData = (overview?.creditHistory || []).map((h) => ({
    day: new Date(h.day).toLocaleDateString(undefined, { month: 'short', day: 'numeric' }),
    Balance: h.balance
  }));

  // Sankey wants { nodes: [{name}], links: [{source, target, value}] } with indices into nodes -
  // zero-value links are dropped since a 0-width flow just renders as visual noise.
  const outcomeLabels = [
    { key: 'answered', name: 'Answered' },
    { key: 'busy', name: 'Busy' },
    { key: 'failed', name: 'Failed' },
    { key: 'no-answer', name: 'No Answer' },
    { key: 'pending', name: 'Pending' },
    { key: 'processing', name: 'In Progress' }
  ];
  const sankeyData = overview ? {
    nodes: [{ name: 'Total Leads' }, ...outcomeLabels.map((o) => ({ name: o.name }))],
    links: outcomeLabels
      .map((o, i) => ({ source: 0, target: i + 1, value: overview.outcomeCounts[o.key] }))
      .filter((l) => l.value > 0)
  } : null;
  const hasSankeyData = sankeyData && sankeyData.links.length > 0;

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-xl font-semibold text-ink-900 dark:text-white dark:font-display">Welcome, {user?.tenant_name}</h1>
        <p className="text-sm text-ink-400 dark:text-abyss-50">Here's what's happening across your flows and campaigns.</p>
      </div>

      {error && (
        <div className="flex items-center gap-2 text-sm text-coral-700 bg-coral-50 dark:bg-coral-500/10 dark:text-coral-300 rounded-md px-3 py-2">
          <AlertCircle className="w-4 h-4" /> {error}
        </div>
      )}

      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
        <StatCard icon={Megaphone} label="Campaigns" value={campaigns.length} accent="cyan" />
        <StatCard icon={Workflow} label="Flows" value={flows.length} accent="purple" />
        <StatCard icon={Server} label="SIM Ports" value={ports.map((p) => p.port_number).join(', ') || 'none'} accent="cyan" />
        <StatCard
          icon={Coins}
          label="Credits Remaining"
          value={credits === null ? '...' : credits}
          warn={credits !== null && credits <= LOW_CREDIT_THRESHOLD}
          accent="green"
          trend={creditSparkline}
        />
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
        <div className="lg:col-span-2 space-y-4">
          <CardShell title="Credit Balance - Last 14 Days" icon={Coins}>
            {creditChartData.length < 2 ? (
              <p className="text-sm text-slate-400 dark:text-abyss-100 py-16 text-center">Not enough credit activity yet to chart a trend.</p>
            ) : (
              <div className="chart-glow-green">
                <ResponsiveContainer width="100%" height={220}>
                  <LineChart data={creditChartData}>
                    <CartesianGrid strokeDasharray="3 3" stroke={colors.grid} />
                    <XAxis dataKey="day" stroke={colors.text} fontSize={12} tickLine={false} />
                    <YAxis stroke={colors.text} fontSize={12} tickLine={false} allowDecimals={false} />
                    <Tooltip
                      contentStyle={{
                        background: theme === 'dark' ? '#0d0f17' : '#fff',
                        border: `1px solid ${theme === 'dark' ? 'rgba(0,255,102,0.2)' : '#e2e8f0'}`,
                        borderRadius: 8,
                        fontSize: 13
                      }}
                    />
                    <Line type="monotone" dataKey="Balance" stroke={theme === 'dark' ? '#00ff66' : '#4e948f'} strokeWidth={2.5} dot={false} />
                  </LineChart>
                </ResponsiveContainer>
              </div>
            )}
          </CardShell>

          <CardShell title="Lead Outcome Flow" icon={Target}>
            {!hasSankeyData ? (
              <p className="text-sm text-slate-400 dark:text-abyss-100 py-16 text-center">No dialed leads yet to visualize.</p>
            ) : (
              <ResponsiveContainer width="100%" height={240}>
                <Sankey
                  data={sankeyData}
                  nodePadding={24}
                  margin={{ top: 10, bottom: 10, left: 10, right: 90 }}
                  link={{ stroke: theme === 'dark' ? '#00f0ff' : '#4e948f', strokeOpacity: theme === 'dark' ? 0.25 : 0.35 }}
                  node={{ fill: theme === 'dark' ? '#00f0ff' : '#4e948f', stroke: 'none' }}
                >
                  <Tooltip
                    contentStyle={{
                      background: theme === 'dark' ? '#0d0f17' : '#fff',
                      border: `1px solid ${theme === 'dark' ? 'rgba(0,240,255,0.2)' : '#e2e8f0'}`,
                      borderRadius: 8,
                      fontSize: 13
                    }}
                  />
                </Sankey>
              </ResponsiveContainer>
            )}
          </CardShell>
        </div>

        <div className="space-y-4">
          <CardShell title="Performance" icon={TrendingUp}>
            <div className="flex items-center justify-around">
              <RadialStat label="Success Rate" percent={successRate} color={theme === 'dark' ? '#00ff66' : '#4e948f'} />
              <RadialStat label="Completion" percent={completionRate} color={theme === 'dark' ? '#00f0ff' : '#b026ff'} />
            </div>
          </CardShell>

          <CardShell title="Campaign Tracker" icon={Megaphone}>
            {campaigns.length === 0 ? (
              <p className="text-sm text-slate-400 dark:text-abyss-100 py-8 text-center">No campaigns yet.</p>
            ) : (
              <div className="space-y-3">
                {campaigns.slice(0, 6).map((c) => {
                  const pct = c.total_leads > 0 ? Math.round((c.processed_leads / c.total_leads) * 100) : 0;
                  return (
                    <div key={c.id}>
                      <div className="flex items-center justify-between text-xs mb-1">
                        <span className="text-ink-900 dark:text-slate-200 truncate">{c.name}</span>
                        <span className="text-ink-400 dark:text-abyss-50 shrink-0 ml-2">{pct}%</span>
                      </div>
                      <div className="h-2 bg-brand-50 dark:bg-abyss-400/60 rounded-full overflow-hidden">
                        <div
                          className="h-full rounded-full bg-brand-500 dark:bg-neon-purple dark:shadow-[0_0_8px_rgba(176,38,255,0.8)] transition-all"
                          style={{ width: `${Math.max(2, pct)}%` }}
                        />
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </CardShell>
        </div>
      </div>

      <section className="space-y-3">
        <h2 className="font-medium text-ink-900 dark:text-white flex items-center gap-2">
          <PhoneCall className="w-4 h-4 text-coral-500 dark:text-neon-green" /> Ongoing Calls
          {liveCalls.length > 0 && (
            <span className="text-xs font-semibold bg-coral-500 dark:bg-neon-green/20 dark:text-neon-green text-white rounded-full px-2 py-0.5">{liveCalls.length}</span>
          )}
        </h2>
        {liveCalls.length === 0 ? (
          <div className="text-sm text-ink-400 dark:text-abyss-50 py-8 text-center border border-dashed border-brand-200 dark:border-white/10 rounded-xl bg-white/60 dark:bg-abyss-500/30">
            No calls in progress right now.
          </div>
        ) : (
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
            {liveCalls.map((call) => (
              <OngoingCallCard key={call.lead_id} call={call} nowMs={now} />
            ))}
          </div>
        )}
      </section>

      <section className="space-y-3">
        <div className="flex items-center justify-between">
          <h2 className="font-medium text-ink-900 dark:text-white">Recent Campaigns</h2>
          <Link to="/app/campaigns" className="text-sm text-brand-600 dark:text-neon-cyan hover:underline">View all</Link>
        </div>
        <DataTable
          rows={campaigns.slice(0, 5)}
          emptyMessage="No campaigns yet."
          columns={[
            {
              key: 'name',
              label: 'Name',
              render: (c) => <Link to={`/app/campaigns/${c.id}`} className="text-ink-900 dark:text-white font-medium hover:text-brand-600 dark:hover:text-neon-cyan">{c.name}</Link>
            },
            { key: 'status', label: 'Status', render: (c) => <StatusBadge status={c.status} /> },
            { key: 'total_leads', label: 'Leads' },
            { key: 'processed_leads', label: 'Processed' }
          ]}
        />
      </section>
    </div>
  );
}
