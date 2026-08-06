import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { Plus, AlertCircle } from 'lucide-react';
import { apiGet } from '../../api/client.js';
import DataTable from '../../components/DataTable.jsx';
import StatusBadge from '../../components/StatusBadge.jsx';

export default function Campaigns() {
  const [campaigns, setCampaigns] = useState(null);
  const [error, setError] = useState('');

  useEffect(() => {
    apiGet('/api/campaigns').then(setCampaigns).catch((err) => setError(err.message));
  }, []);

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-xl font-semibold text-slate-900">Campaigns</h1>
          <p className="text-sm text-slate-500">Every broadcast you've run or are running now.</p>
        </div>
        <Link
          to="/app/campaigns/new"
          className="flex items-center gap-2 bg-brand-600 hover:bg-brand-700 text-white text-sm font-medium px-4 py-2 rounded-md"
        >
          <Plus className="w-4 h-4" /> New Campaign
        </Link>
      </div>

      {error && (
        <div className="flex items-center gap-2 text-sm text-red-600 bg-red-50 rounded-md px-3 py-2">
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
            render: (c) => <Link to={`/app/campaigns/${c.id}`} className="text-slate-900 font-medium hover:text-brand-600">{c.name}</Link>
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
