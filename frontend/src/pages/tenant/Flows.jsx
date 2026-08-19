import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { Plus, AlertCircle } from 'lucide-react';
import { apiGet } from '../../api/client.js';
import DataTable from '../../components/DataTable.jsx';
import StatusBadge from '../../components/StatusBadge.jsx';

export default function Flows() {
  const [flows, setFlows] = useState(null);
  const [error, setError] = useState('');

  useEffect(() => {
    apiGet('/api/ivr/flows').then(setFlows).catch((err) => setError(err.message));
  }, []);

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-xl font-semibold text-ink-900 dark:text-white">IVR Flows</h1>
          <p className="text-sm text-ink-500 dark:text-abyss-50">The call scenarios your campaigns run against.</p>
        </div>
        <Link
          to="/app/flows/new"
          className="flex items-center gap-2 bg-brand-600 hover:bg-brand-700 text-white text-sm font-medium px-4 py-2 rounded-md"
        >
          <Plus className="w-4 h-4" /> New Flow
        </Link>
      </div>

      {error && (
        <div className="flex items-center gap-2 text-sm text-red-600 dark:text-red-300 bg-red-50 dark:bg-red-400/10 rounded-md px-3 py-2">
          <AlertCircle className="w-4 h-4" /> {error}
        </div>
      )}

      <DataTable
        rows={flows || []}
        emptyMessage={flows ? 'No flows yet - build your first one.' : 'Loading...'}
        columns={[
          {
            key: 'name',
            label: 'Name',
            render: (f) => (
              <Link to={`/app/flows/${f.id}`} className="text-ink-900 dark:text-white font-medium hover:text-brand-600 dark:hover:text-neon-cyan">
                {f.name}
              </Link>
            )
          },
          { key: 'version', label: 'Version' },
          { key: 'is_active', label: 'Status', render: (f) => <StatusBadge status={f.is_active ? 'active' : 'offline'} /> },
          { key: 'updated_at', label: 'Updated', render: (f) => new Date(f.updated_at || f.created_at).toLocaleString() }
        ]}
      />
    </div>
  );
}
