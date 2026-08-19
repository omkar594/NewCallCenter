import { useEffect, useMemo, useRef, useState } from 'react';
import { useParams, Link } from 'react-router-dom';
import {
  ArrowLeft, AlertCircle, RefreshCw, Hash, Download, Pause, Play, ChevronRight, Search,
  PhoneCall, ShieldCheck, Signal, X, Repeat, Radio, Megaphone
} from 'lucide-react';
import { apiGet, apiPost, apiDownload } from '../../api/client.js';
import DataTable from '../../components/DataTable.jsx';
import StatusBadge from '../../components/StatusBadge.jsx';

const POLL_MS = 4000;

function MetricCard({ icon: Icon, label, value, detail, accent = 'cyan' }) {
  const ACCENTS = {
    cyan: 'dark:text-neon-cyan dark:bg-neon-cyan/10 bg-brand-50 text-brand-600',
    green: 'dark:text-neon-green dark:bg-neon-green/10 bg-emerald-50 text-emerald-600',
    amber: 'dark:text-amber-300 dark:bg-amber-400/10 bg-amber-50 text-amber-600',
    coral: 'dark:text-coral-400 dark:bg-coral-500/10 bg-coral-50 text-coral-600'
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

const CardShell = ({ title, sub, icon: Icon, action, children }) => (
  <div className="bg-surface dark:bg-abyss-500 border border-line dark:border-abyss-300/40 rounded-2xl p-5">
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

const OUTCOMES = ['answered', 'busy', 'failed', 'no-answer', 'processing', 'pending'];

export default function CampaignDetail() {
  // tenantId is only present when this page is reached via the super_admin route
  // (/admin/tenants/:tenantId/campaigns/:campaignId) - undefined for the tenant's own route,
  // where resolveTenantId(req) on the backend already scopes correctly without it.
  const { campaignId, tenantId } = useParams();
  const [report, setReport] = useState(null);
  const [error, setError] = useState('');
  const [downloading, setDownloading] = useState(false);
  const [actionLoading, setActionLoading] = useState(false);
  const [query, setQuery] = useState('');
  const [outcomeFilter, setOutcomeFilter] = useState('all');
  const [selectedLead, setSelectedLead] = useState(null);
  // Bumped after a pause/resume action to force an immediate re-fetch instead of waiting up to
  // POLL_MS for the next scheduled poll to pick up the status change.
  const [reloadTick, setReloadTick] = useState(0);
  const timerRef = useRef(null);

  useEffect(() => {
    let cancelled = false;

    const load = async () => {
      try {
        const q = tenantId ? `?tenantId=${tenantId}` : '';
        const data = await apiGet(`/api/campaigns/${campaignId}${q}`);
        if (cancelled) return;
        setReport(data);
        const stillWorking = data.campaign.status === 'preparing' || data.metrics.pending > 0 || data.metrics.processing > 0;
        if (stillWorking) {
          timerRef.current = setTimeout(load, POLL_MS);
        }
      } catch (err) {
        if (!cancelled) setError(err.message);
      }
    };
    load();

    return () => {
      cancelled = true;
      if (timerRef.current) clearTimeout(timerRef.current);
    };
  }, [campaignId, tenantId, reloadTick]);

  const filteredLeads = useMemo(() => {
    if (!report) return [];
    return report.leads.filter((l) => {
      const matchesQuery = !query || `${l.customer_name || ''} ${l.phone_number}`.toLowerCase().includes(query.toLowerCase());
      const matchesOutcome = outcomeFilter === 'all' || l.dial_status === outcomeFilter;
      return matchesQuery && matchesOutcome;
    });
  }, [report, query, outcomeFilter]);

  if (error) {
    return (
      <div className="flex items-center gap-2 text-sm text-red-600 dark:text-red-300 bg-red-50 dark:bg-red-400/10 rounded-md px-3 py-2">
        <AlertCircle className="w-4 h-4" /> {error}
      </div>
    );
  }
  if (!report) return <p className="text-sm text-ink-500 dark:text-abyss-50">Loading...</p>;

  const { campaign, metrics } = report;
  const isLive = campaign.status === 'preparing' || metrics.pending > 0 || metrics.processing > 0;
  const rejected = metrics.busy + metrics.failed + (metrics.noAnswer || 0);
  const dialed = metrics.answered + rejected;
  const answerRate = dialed > 0 ? Math.round((metrics.answered / dialed) * 100) : 0;
  const completionPct = metrics.total > 0 ? Math.round(((metrics.total - metrics.pending - metrics.processing) / metrics.total) * 100) : 0;

  const handleDownloadCsv = async () => {
    setDownloading(true);
    try {
      const q = tenantId ? `?tenantId=${tenantId}` : '';
      const safeName = campaign.name.replace(/[^a-z0-9_-]+/gi, '_').slice(0, 60);
      await apiDownload(`/api/campaigns/${campaignId}/export${q}`, `campaign_${safeName}.csv`);
    } catch (err) {
      setError(err.message);
    } finally {
      setDownloading(false);
    }
  };

  const handlePauseResume = async (action) => {
    setActionLoading(true);
    setError('');
    try {
      const q = tenantId ? `?tenantId=${tenantId}` : '';
      await apiPost(`/api/campaigns/${campaignId}/${action}${q}`);
      setReloadTick((t) => t + 1);
    } catch (err) {
      setError(err.message);
    } finally {
      setActionLoading(false);
    }
  };

  return (
    <div className="space-y-6">
      <div className="flex items-center gap-1.5 text-xs text-ink-400 dark:text-abyss-50">
        <Link to={tenantId ? `/admin/tenants/${tenantId}` : '/app/campaigns'} className="flex items-center gap-1 hover:text-ink-700 dark:hover:text-white">
          <ArrowLeft className="w-3.5 h-3.5" /> {tenantId ? 'Tenant' : 'Campaigns'}
        </Link>
        <ChevronRight className="w-3 h-3" />
        <span className="text-ink-700 dark:text-slate-200">{campaign.name}</span>
      </div>

      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <p className="text-[11px] font-bold uppercase tracking-wider text-brand-600 dark:text-neon-cyan">Outbound voice campaign</p>
          <h1 className="mt-1 text-2xl font-semibold font-display text-ink-900 dark:text-white">{campaign.name}</h1>
          <p className="mt-1 text-xs text-ink-400 dark:text-abyss-50 font-mono">
            {campaign.id.slice(0, 8)} · created {new Date(campaign.created_at).toLocaleString()}
          </p>
        </div>
        <div className="flex items-center gap-2">
          <StatusBadge status={campaign.status} />
          {isLive && campaign.status !== 'paused' && (
            <span className="flex items-center gap-1 text-xs text-ink-400 dark:text-abyss-100">
              <RefreshCw className="w-3 h-3 animate-spin" /> live
            </span>
          )}
          {(campaign.status === 'running' || campaign.status === 'pending') && (
            <button
              type="button"
              onClick={() => handlePauseResume('pause')}
              disabled={actionLoading}
              className="flex items-center gap-1.5 text-xs font-bold text-white bg-ink-900 dark:bg-amber-400/15 dark:text-amber-300 rounded-lg px-3.5 py-2.5 disabled:opacity-50"
            >
              <Pause className="w-3.5 h-3.5" /> {actionLoading ? 'Pausing…' : 'Pause campaign'}
            </button>
          )}
          {campaign.status === 'paused' && (
            <button
              type="button"
              onClick={() => handlePauseResume('resume')}
              disabled={actionLoading}
              className="flex items-center gap-1.5 text-xs font-bold text-white bg-brand-600 dark:bg-neon-green/15 dark:text-neon-green rounded-lg px-3.5 py-2.5 disabled:opacity-50"
            >
              <Play className="w-3.5 h-3.5" /> {actionLoading ? 'Resuming…' : 'Resume campaign'}
            </button>
          )}
          <button
            type="button"
            onClick={handleDownloadCsv}
            disabled={downloading}
            className="flex items-center gap-1.5 text-xs font-bold text-ink-700 dark:text-slate-200 bg-surface dark:bg-abyss-500 border border-line dark:border-abyss-300/40 rounded-xl px-3.5 py-2.5 hover:bg-ink-50 dark:hover:bg-abyss-300/20 disabled:opacity-50"
          >
            <Download className="w-3.5 h-3.5" /> {downloading ? 'Exporting…' : 'Export CSV'}
          </button>
        </div>
      </div>

      {error && (
        <div className="flex items-center gap-2 text-sm text-red-600 dark:text-red-300 bg-red-50 dark:bg-red-400/10 rounded-md px-3 py-2">
          <AlertCircle className="w-4 h-4" /> {error}
        </div>
      )}

      {campaign.status === 'preparing' && (
        <div className="flex items-center gap-2 text-sm text-amber-700 dark:text-amber-300 bg-amber-50 dark:bg-amber-400/10 rounded-md px-3 py-2">
          Pre-synthesizing every prompt for every language this campaign's leads use before dialing starts.
        </div>
      )}
      {campaign.status === 'paused' && (
        <div className="flex items-center gap-2 text-sm text-amber-700 dark:text-amber-300 bg-amber-50 dark:bg-amber-400/10 rounded-md px-3 py-2">
          Dialing is paused. Calls already in progress will finish normally; no new calls will start until you resume.
        </div>
      )}

      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
        <MetricCard icon={Megaphone} label="Total Leads" value={metrics.total} detail={`${completionPct}% processed`} accent="cyan" />
        <MetricCard icon={PhoneCall} label="Answer Rate" value={`${answerRate}%`} detail={`${metrics.answered} answered`} accent="green" />
        <MetricCard icon={Signal} label="In Progress" value={metrics.processing} detail={`${metrics.pending} still queued`} accent="cyan" />
        <MetricCard icon={AlertCircle} label="Needs Attention" value={rejected} detail="Busy + failed + no answer" accent="amber" />
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-[1.4fr_1fr] gap-4">
        <CardShell title="Progress" sub="Leads processed out of the full list" icon={Signal}>
          <div className="flex items-center justify-between text-xs mb-1.5">
            <span className="text-ink-700 dark:text-slate-300">Overall completion</span>
            <span className="text-ink-900 dark:text-white font-semibold">{completionPct}%</span>
          </div>
          <div className="h-2.5 bg-brand-50 dark:bg-abyss-400/60 rounded-full overflow-hidden">
            <div className="h-full rounded-full bg-brand-500 dark:bg-neon-cyan" style={{ width: `${Math.max(2, completionPct)}%` }} />
          </div>
          <div className="grid grid-cols-3 gap-3 mt-5 pt-4 border-t border-brand-50 dark:border-white/10 text-xs">
            <div><p className="text-ink-400 dark:text-abyss-50">Answered</p><p className="font-semibold text-ink-900 dark:text-white mt-0.5">{metrics.answered}</p></div>
            <div><p className="text-ink-400 dark:text-abyss-50">Busy</p><p className="font-semibold text-ink-900 dark:text-white mt-0.5">{metrics.busy}</p></div>
            <div><p className="text-ink-400 dark:text-abyss-50">Failed</p><p className="font-semibold text-coral-600 dark:text-coral-400 mt-0.5">{metrics.failed}</p></div>
          </div>
        </CardShell>

        <CardShell title="Campaign Setup" icon={ShieldCheck}>
          <div className="space-y-3 text-xs">
            <div className="flex justify-between"><span className="text-ink-400 dark:text-abyss-50 flex items-center gap-1.5"><Repeat className="w-3.5 h-3.5" /> Retry attempts</span><span className="font-semibold text-ink-900 dark:text-white">{campaign.max_retry_attempts ?? 0}</span></div>
            <div className="flex justify-between"><span className="text-ink-400 dark:text-abyss-50 flex items-center gap-1.5"><Radio className="w-3.5 h-3.5" /> Allowed ports</span><span className="font-semibold text-ink-900 dark:text-white">{campaign.allowed_ports || 'all'}</span></div>
            <div className="flex justify-between"><span className="text-ink-400 dark:text-abyss-50">Prompt source</span><span className="font-semibold text-ink-900 dark:text-white">{campaign.ivr_flow_id ? 'IVR flow' : 'Single audio'}</span></div>
            <div className="flex justify-between"><span className="text-ink-400 dark:text-abyss-50">Last updated</span><span className="font-semibold text-ink-900 dark:text-white">{new Date(campaign.updated_at).toLocaleTimeString()}</span></div>
          </div>
        </CardShell>
      </div>

      <CardShell
        title="Lead-Level Record"
        sub={`${filteredLeads.length} of ${metrics.total} leads shown`}
        icon={Hash}
        action={
          <div className="flex items-center gap-2">
            <div className="flex items-center gap-1.5 rounded-lg border border-line dark:border-abyss-300/30 bg-white dark:bg-abyss-400/40 px-2.5 py-1.5">
              <Search className="w-3.5 h-3.5 text-ink-400 dark:text-abyss-100" />
              <input
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="Search name or phone"
                className="w-32 sm:w-40 bg-transparent text-xs outline-none placeholder:text-ink-300 dark:placeholder:text-abyss-200"
              />
            </div>
            <select
              value={outcomeFilter}
              onChange={(e) => setOutcomeFilter(e.target.value)}
              className="rounded-lg border border-line dark:border-abyss-300/30 bg-white dark:bg-abyss-400/40 px-2.5 py-1.5 text-xs font-medium text-ink-700 dark:text-slate-200"
            >
              <option value="all">All outcomes</option>
              {OUTCOMES.map((o) => <option key={o} value={o}>{o}</option>)}
            </select>
          </div>
        }
      >
        <DataTable
          rows={filteredLeads}
          rowKey={(l) => l.id}
          emptyMessage="No leads match this filter."
          columns={[
            { key: 'phone_number', label: 'Phone', render: (l) => <span className="font-mono">{l.phone_number}</span> },
            { key: 'customer_name', label: 'Name' },
            { key: 'dial_status', label: 'Status', render: (l) => <StatusBadge status={l.dial_status} /> },
            { key: 'attempts', label: 'Attempts' },
            { key: 'call_duration', label: 'Duration (s)' },
            {
              key: 'dtmf_selected',
              label: 'DTMF Pressed',
              render: (l) => l.dtmf_selected ? (
                <span className="inline-flex items-center gap-1 bg-brand-50 dark:bg-neon-cyan/10 text-brand-700 dark:text-neon-cyan text-xs font-medium px-2 py-1 rounded-full">
                  <Hash className="w-3 h-3" />
                  {l.dtmf_selected}{l.dtmf_label ? ` · ${l.dtmf_label}` : ''}
                </span>
              ) : <span className="text-ink-300 dark:text-abyss-200">—</span>
            },
            { key: 'updated_at', label: 'Updated', render: (l) => new Date(l.updated_at).toLocaleString() },
            {
              key: 'inspect',
              label: '',
              render: (l) => (
                <button onClick={() => setSelectedLead(l)} className="text-ink-300 dark:text-abyss-100 hover:text-brand-600 dark:hover:text-neon-cyan">
                  <ChevronRight className="w-4 h-4" />
                </button>
              )
            }
          ]}
        />
      </CardShell>

      {selectedLead && (
        <div className="fixed inset-0 z-40 flex items-end sm:items-center justify-center bg-ink-900/30 dark:bg-black/60 backdrop-blur-[2px] p-4" onClick={() => setSelectedLead(null)}>
          <div className="w-full max-w-md bg-white dark:bg-abyss-500 border border-line dark:border-abyss-300/40 rounded-2xl p-5 shadow-2xl" onClick={(e) => e.stopPropagation()}>
            <div className="flex items-start justify-between">
              <div>
                <p className="text-[10px] font-bold uppercase tracking-wider text-brand-600 dark:text-neon-cyan">Lead investigation</p>
                <h3 className="mt-1 text-xl font-semibold font-display text-ink-900 dark:text-white">{selectedLead.customer_name || 'Unknown'}</h3>
                <p className="mt-1 text-xs font-mono text-ink-400 dark:text-abyss-50">{selectedLead.phone_number}</p>
              </div>
              <button onClick={() => setSelectedLead(null)} className="text-ink-300 dark:text-abyss-100 hover:text-ink-700 dark:hover:text-white">
                <X className="w-4 h-4" />
              </button>
            </div>
            <div className="mt-4 grid grid-cols-2 gap-2">
              {[
                ['Status', selectedLead.dial_status],
                ['Attempts', selectedLead.attempts],
                ['Duration', `${selectedLead.call_duration || 0}s`],
                ['DTMF', selectedLead.dtmf_selected ? `${selectedLead.dtmf_selected}${selectedLead.dtmf_label ? ` · ${selectedLead.dtmf_label}` : ''}` : 'None'],
                ['Updated', new Date(selectedLead.updated_at).toLocaleString()]
              ].map(([label, value]) => (
                <div key={label} className="rounded-lg bg-brand-50 dark:bg-abyss-400/40 p-3">
                  <p className="text-[10px] text-ink-400 dark:text-abyss-50">{label}</p>
                  <p className="mt-1 text-xs font-semibold text-ink-900 dark:text-white truncate">{value}</p>
                </div>
              ))}
            </div>
            <button onClick={() => setSelectedLead(null)} className="mt-5 w-full rounded-xl bg-ink-900 dark:bg-neon-cyan/15 dark:text-neon-cyan text-white text-xs font-bold py-2.5">
              Close
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
