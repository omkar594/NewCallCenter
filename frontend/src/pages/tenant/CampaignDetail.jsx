import { useEffect, useRef, useState } from 'react';
import { useParams, Link } from 'react-router-dom';
import { ArrowLeft, AlertCircle, RefreshCw } from 'lucide-react';
import { apiGet } from '../../api/client.js';
import DataTable from '../../components/DataTable.jsx';
import StatusBadge from '../../components/StatusBadge.jsx';

const POLL_MS = 4000;

export default function CampaignDetail() {
  const { campaignId } = useParams();
  const [report, setReport] = useState(null);
  const [error, setError] = useState('');
  const timerRef = useRef(null);

  useEffect(() => {
    let cancelled = false;

    const load = async () => {
      try {
        const data = await apiGet(`/api/campaigns/${campaignId}`);
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
  }, [campaignId]);

  if (error) {
    return (
      <div className="flex items-center gap-2 text-sm text-red-600 bg-red-50 rounded-md px-3 py-2">
        <AlertCircle className="w-4 h-4" /> {error}
      </div>
    );
  }
  if (!report) return <p className="text-sm text-slate-500">Loading...</p>;

  const { campaign, metrics, leads } = report;
  const isLive = campaign.status === 'preparing' || metrics.pending > 0 || metrics.processing > 0;

  return (
    <div className="space-y-6">
      <Link to="/app/campaigns" className="inline-flex items-center gap-1 text-sm text-slate-500 hover:text-slate-700">
        <ArrowLeft className="w-4 h-4" /> All campaigns
      </Link>

      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-xl font-semibold text-slate-900">{campaign.name}</h1>
          <div className="flex items-center gap-2 mt-1">
            <StatusBadge status={campaign.status} />
            {isLive && (
              <span className="flex items-center gap-1 text-xs text-slate-400">
                <RefreshCw className="w-3 h-3 animate-spin" /> updating live
              </span>
            )}
          </div>
        </div>
      </div>

      <div className="grid grid-cols-3 sm:grid-cols-6 gap-3">
        {['total', 'pending', 'processing', 'answered', 'failed', 'busy'].map((key) => (
          <div key={key} className="bg-white border border-slate-200 rounded-lg p-3 text-center">
            <div className="text-xl font-semibold text-slate-900">{metrics[key]}</div>
            <div className="text-xs text-slate-500 capitalize">{key}</div>
          </div>
        ))}
      </div>

      {campaign.status === 'preparing' && (
        <div className="text-sm text-amber-700 bg-amber-50 rounded-md px-3 py-2">
          Pre-synthesizing every prompt for every language this campaign's leads use before dialing starts - this usually takes just a few seconds.
        </div>
      )}

      <section className="space-y-3">
        <h2 className="font-medium text-slate-900">Leads</h2>
        <DataTable
          rows={leads}
          emptyMessage="No leads."
          columns={[
            { key: 'phone_number', label: 'Phone' },
            { key: 'customer_name', label: 'Name' },
            { key: 'dial_status', label: 'Status', render: (l) => <StatusBadge status={l.dial_status} /> },
            { key: 'attempts', label: 'Attempts' },
            { key: 'call_duration', label: 'Duration (s)' },
            { key: 'updated_at', label: 'Updated', render: (l) => new Date(l.updated_at).toLocaleString() }
          ]}
        />
      </section>
    </div>
  );
}
