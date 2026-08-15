import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { Plus, AlertCircle, CalendarRange, X } from 'lucide-react';
import { apiGet } from '../../api/client.js';
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

export default function Campaigns() {
  const [campaigns, setCampaigns] = useState(null);
  const [error, setError] = useState('');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');

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

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-xl font-semibold text-slate-900 dark:text-white">Campaigns</h1>
          <p className="text-sm text-slate-500 dark:text-abyss-50">Every broadcast you've run or are running now.</p>
        </div>
        <Link
          to="/app/campaigns/new"
          className="flex items-center gap-2 bg-brand-600 hover:bg-brand-700 text-white text-sm font-medium px-4 py-2 rounded-md"
        >
          <Plus className="w-4 h-4" /> New Campaign
        </Link>
      </div>

      <div className="flex flex-wrap items-center gap-2 bg-white dark:bg-abyss-500 border border-slate-200 dark:border-abyss-300/30 rounded-lg p-3">
        <CalendarRange className="w-4 h-4 text-slate-400 dark:text-abyss-100 shrink-0" />
        <input
          type="date"
          value={from}
          max={to || undefined}
          onChange={(e) => setFrom(e.target.value)}
          className="text-sm border border-slate-200 dark:border-abyss-300/30 rounded-md px-2 py-1 text-slate-700 dark:text-slate-200"
        />
        <span className="text-sm text-slate-400 dark:text-abyss-100">to</span>
        <input
          type="date"
          value={to}
          min={from || undefined}
          onChange={(e) => setTo(e.target.value)}
          className="text-sm border border-slate-200 dark:border-abyss-300/30 rounded-md px-2 py-1 text-slate-700 dark:text-slate-200"
        />
        <div className="flex flex-wrap items-center gap-1.5 ml-1">
          {PRESETS.map((p) => (
            <button
              key={p.label}
              type="button"
              onClick={() => applyPreset(p.days)}
              className="text-xs font-medium text-slate-600 dark:text-slate-300 bg-slate-50 dark:bg-abyss-400/40 hover:bg-slate-100 rounded-full px-3 py-1"
            >
              {p.label}
            </button>
          ))}
          {(from || to) && (
            <button
              type="button"
              onClick={clearFilter}
              className="flex items-center gap-1 text-xs font-medium text-slate-500 dark:text-abyss-50 hover:text-slate-700 px-2 py-1"
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
            render: (c) => <Link to={`/app/campaigns/${c.id}`} className="text-slate-900 dark:text-white font-medium hover:text-brand-600 dark:hover:text-neon-cyan">{c.name}</Link>
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
