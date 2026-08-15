import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { Megaphone, Workflow, Server, AlertCircle, Coins, PhoneCall, User } from 'lucide-react';
import { apiGet } from '../../api/client.js';
import { useAuth } from '../../context/AuthContext.jsx';
import DataTable from '../../components/DataTable.jsx';
import StatusBadge from '../../components/StatusBadge.jsx';

// Below this, the balance is flagged red so a client admin notices before a campaign gets
// auto-blocked (see campaignController.js's 402 gate) or an active one gets auto-cancelled
// mid-run (see bulkCampaignWorker.js's finalizeLead).
const LOW_CREDIT_THRESHOLD = 20;

// How often we re-fetch the actual list of live calls from the backend.
const LIVE_CALLS_POLL_MS = 4000;

// Dark-mode glow color per card, matching the neon/glassmorphism reference brief - each metric
// gets its own accent so the row reads as a real "analytical dashboard" rather than one flat tone.
const ACCENTS = {
  cyan: { icon: 'dark:text-neon-cyan', ring: 'dark:shadow-[0_0_20px_-4px_rgba(0,240,255,0.35)] dark:hover:shadow-[0_0_24px_-2px_rgba(0,240,255,0.5)]', bg: 'dark:bg-neon-cyan/10' },
  purple: { icon: 'dark:text-neon-purple', ring: 'dark:shadow-[0_0_20px_-4px_rgba(176,38,255,0.35)] dark:hover:shadow-[0_0_24px_-2px_rgba(176,38,255,0.5)]', bg: 'dark:bg-neon-purple/10' },
  green: { icon: 'dark:text-neon-green', ring: 'dark:shadow-[0_0_20px_-4px_rgba(0,255,102,0.35)] dark:hover:shadow-[0_0_24px_-2px_rgba(0,255,102,0.5)]', bg: 'dark:bg-neon-green/10' }
};

function StatCard({ icon: Icon, label, value, warn, accent = 'cyan' }) {
  const a = ACCENTS[accent];
  return (
    <div
      className={`bg-white dark:bg-abyss-500/60 dark:backdrop-blur border border-brand-100 dark:border-white/10 rounded-xl p-5 flex items-center gap-4 shadow-sm transition-shadow ${warn ? '' : a.ring}`}
    >
      <div className={`w-10 h-10 rounded-lg flex items-center justify-center ${warn ? 'bg-coral-50 text-coral-600 dark:bg-coral-500/10 dark:text-coral-400' : `bg-brand-50 text-brand-600 ${a.bg} ${a.icon}`}`}>
        <Icon className="w-5 h-5" />
      </div>
      <div>
        <div className={`text-2xl font-semibold font-display ${warn ? 'text-coral-600 dark:text-coral-400' : `text-ink-900 dark:text-white ${warn ? '' : ''}`}`}>{value}</div>
        <div className="text-xs text-ink-400 dark:text-abyss-50">{label}</div>
      </div>
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
  const [campaigns, setCampaigns] = useState([]);
  const [flows, setFlows] = useState([]);
  const [ports, setPorts] = useState([]);
  const [credits, setCredits] = useState(null);
  const [liveCalls, setLiveCalls] = useState([]);
  const [now, setNow] = useState(Date.now());
  const [error, setError] = useState('');
  const liveCallsTimerRef = useRef(null);

  useEffect(() => {
    Promise.all([apiGet('/api/campaigns'), apiGet('/api/ivr/flows'), apiGet('/api/gateways/ports'), apiGet('/api/auth/credits')])
      .then(([c, f, p, cr]) => {
        setCampaigns(c);
        setFlows(f);
        setPorts(p);
        setCredits(cr.balance);
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
        />
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
