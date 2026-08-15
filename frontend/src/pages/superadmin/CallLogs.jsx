import { useEffect, useState } from 'react';
import { AlertCircle } from 'lucide-react';
import { apiGet } from '../../api/client.js';
import DataTable from '../../components/DataTable.jsx';
import StatusBadge from '../../components/StatusBadge.jsx';

export default function SuperAdminCallLogs() {
  const [logs, setLogs] = useState(null);
  const [error, setError] = useState('');

  useEffect(() => {
    apiGet('/api/analytics/logs')
      .then(setLogs)
      .catch((err) => setError(err.message));
  }, []);

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-xl font-semibold text-slate-900 dark:text-white">Call Logs</h1>
        <p className="text-sm text-slate-500 dark:text-abyss-50">Most recent 100 calls, across every tenant.</p>
      </div>

      {error && (
        <div className="flex items-center gap-2 text-sm text-red-600 dark:text-red-300 bg-red-50 dark:bg-red-400/10 rounded-md px-3 py-2">
          <AlertCircle className="w-4 h-4" /> {error}
        </div>
      )}

      <DataTable
        rows={logs || []}
        emptyMessage={logs ? 'No calls logged yet.' : 'Loading...'}
        columns={[
          { key: 'caller_number', label: 'Caller' },
          { key: 'callee_number', label: 'Callee' },
          { key: 'direction', label: 'Direction' },
          { key: 'status', label: 'Status', render: (c) => <StatusBadge status={c.status} /> },
          { key: 'agent_name', label: 'Agent', render: (c) => c.agent_name || '-' },
          { key: 'disposition_code', label: 'Disposition', render: (c) => c.disposition_code || '-' },
          { key: 'duration', label: 'Duration (s)' },
          { key: 'start_time', label: 'Started', render: (c) => (c.start_time ? new Date(c.start_time).toLocaleString() : '-') }
        ]}
      />
    </div>
  );
}
