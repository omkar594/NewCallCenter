import { useEffect, useRef, useState } from 'react';
import { useParams, Link } from 'react-router-dom';
import { ArrowLeft, AlertCircle, RefreshCw, Hash, Download, Pause, Play } from 'lucide-react';
import { apiGet, apiPost, apiDownload } from '../../api/client.js';
import DataTable from '../../components/DataTable.jsx';
import StatusBadge from '../../components/StatusBadge.jsx';

const POLL_MS = 4000;

export default function CampaignDetail() {
  // tenantId is only present when this page is reached via the super_admin route
  // (/admin/tenants/:tenantId/campaigns/:campaignId) - undefined for the tenant's own route,
  // where resolveTenantId(req) on the backend already scopes correctly without it.
  const { campaignId, tenantId } = useParams();
  const [report, setReport] = useState(null);
  const [error, setError] = useState('');
  const [downloading, setDownloading] = useState(false);
  const [actionLoading, setActionLoading] = useState(false);
  // Bumped after a pause/resume action to force an immediate re-fetch instead of waiting up to
  // POLL_MS for the next scheduled poll to pick up the status change.
  const [reloadTick, setReloadTick] = useState(0);
  const timerRef = useRef(null);

  useEffect(() => {
    let cancelled = false;

    const load = async () => {
      try {
        const query = tenantId ? `?tenantId=${tenantId}` : '';
        const data = await apiGet(`/api/campaigns/${campaignId}${query}`);
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

  if (error) {
    return (
      <div className="flex items-center gap-2 text-sm text-red-600 dark:text-red-300 bg-red-50 dark:bg-red-400/10 rounded-md px-3 py-2">
        <AlertCircle className="w-4 h-4" /> {error}
      </div>
    );
  }
  if (!report) return <p className="text-sm text-slate-500 dark:text-abyss-50">Loading...</p>;

  const { campaign, metrics, leads } = report;
  const isLive = campaign.status === 'preparing' || metrics.pending > 0 || metrics.processing > 0;

  const handleDownloadCsv = async () => {
    setDownloading(true);
    try {
      const query = tenantId ? `?tenantId=${tenantId}` : '';
      const safeName = campaign.name.replace(/[^a-z0-9_-]+/gi, '_').slice(0, 60);
      await apiDownload(`/api/campaigns/${campaignId}/export${query}`, `campaign_${safeName}.csv`);
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
      const query = tenantId ? `?tenantId=${tenantId}` : '';
      await apiPost(`/api/campaigns/${campaignId}/${action}${query}`);
      setReloadTick((t) => t + 1);
    } catch (err) {
      setError(err.message);
    } finally {
      setActionLoading(false);
    }
  };

  return (
    <div className="space-y-6">
      <Link
        to={tenantId ? `/admin/tenants/${tenantId}` : '/app/campaigns'}
        className="inline-flex items-center gap-1 text-sm text-slate-500 dark:text-abyss-50 hover:text-slate-700"
      >
        <ArrowLeft className="w-4 h-4" /> {tenantId ? 'Back to tenant' : 'All campaigns'}
      </Link>

      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-xl font-semibold text-slate-900 dark:text-white">{campaign.name}</h1>
          <div className="flex items-center gap-2 mt-1">
            <StatusBadge status={campaign.status} />
            {isLive && campaign.status !== 'paused' && (
              <span className="flex items-center gap-1 text-xs text-slate-400 dark:text-abyss-100">
                <RefreshCw className="w-3 h-3 animate-spin" /> updating live
              </span>
            )}
          </div>
        </div>
        <div className="flex items-center gap-2">
          {(campaign.status === 'running' || campaign.status === 'pending') && (
            <button
              type="button"
              onClick={() => handlePauseResume('pause')}
              disabled={actionLoading}
              className="inline-flex items-center gap-1.5 text-sm font-medium text-amber-700 bg-amber-50 border border-amber-200 rounded-md px-3 py-1.5 hover:bg-amber-100 disabled:opacity-50"
            >
              <Pause className="w-4 h-4" /> {actionLoading ? 'Pausing...' : 'Pause'}
            </button>
          )}
          {campaign.status === 'paused' && (
            <button
              type="button"
              onClick={() => handlePauseResume('resume')}
              disabled={actionLoading}
              className="inline-flex items-center gap-1.5 text-sm font-medium text-emerald-700 dark:text-neon-green bg-emerald-50 dark:bg-neon-green/10 border border-emerald-200 rounded-md px-3 py-1.5 hover:bg-emerald-100 disabled:opacity-50"
            >
              <Play className="w-4 h-4" /> {actionLoading ? 'Resuming...' : 'Resume'}
            </button>
          )}
          <button
            type="button"
            onClick={handleDownloadCsv}
            disabled={downloading}
            className="inline-flex items-center gap-1.5 text-sm font-medium text-slate-700 dark:text-slate-200 bg-white dark:bg-abyss-500 border border-slate-200 dark:border-abyss-300/30 rounded-md px-3 py-1.5 hover:bg-slate-50 dark:hover:bg-abyss-300/20 disabled:opacity-50"
          >
            <Download className="w-4 h-4" /> {downloading ? 'Downloading...' : 'Download CSV'}
          </button>
        </div>
      </div>

      <div className="grid grid-cols-3 sm:grid-cols-6 gap-3">
        {['total', 'pending', 'processing', 'answered', 'failed', 'busy'].map((key) => (
          <div key={key} className="bg-white dark:bg-abyss-500 border border-slate-200 dark:border-abyss-300/30 rounded-lg p-3 text-center">
            <div className="text-xl font-semibold text-slate-900 dark:text-white">{metrics[key]}</div>
            <div className="text-xs text-slate-500 dark:text-abyss-50 capitalize">{key}</div>
          </div>
        ))}
      </div>

      {campaign.status === 'preparing' && (
        <div className="text-sm text-amber-700 bg-amber-50 rounded-md px-3 py-2">
          Pre-synthesizing every prompt for every language this campaign's leads use before dialing starts - this usually takes just a few seconds.
        </div>
      )}

      {campaign.status === 'paused' && (
        <div className="text-sm text-amber-700 bg-amber-50 rounded-md px-3 py-2">
          Dialing is paused. Calls already in progress will finish normally; no new calls will start until you resume.
        </div>
      )}

      <section className="space-y-3">
        <h2 className="font-medium text-slate-900 dark:text-white">Leads</h2>
        <DataTable
          rows={leads}
          emptyMessage="No leads."
          columns={[
            { key: 'phone_number', label: 'Phone' },
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
              ) : <span className="text-slate-300 dark:text-abyss-200">—</span>
            },
            { key: 'updated_at', label: 'Updated', render: (l) => new Date(l.updated_at).toLocaleString() }
          ]}
        />
      </section>
    </div>
  );
}
