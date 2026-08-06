import { useEffect, useState, useCallback } from 'react';
import { Plus, AlertCircle } from 'lucide-react';
import { apiGet, apiPost } from '../../api/client.js';
import DataTable from '../../components/DataTable.jsx';
import StatusBadge from '../../components/StatusBadge.jsx';
import Modal from '../../components/Modal.jsx';

export default function Agents() {
  const [agents, setAgents] = useState(null);
  const [error, setError] = useState('');
  const [showCreate, setShowCreate] = useState(false);

  const load = useCallback(() => {
    apiGet('/api/auth/agents').then(setAgents).catch((err) => setError(err.message));
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-xl font-semibold text-slate-900">Agents</h1>
          <p className="text-sm text-slate-500">Agents who can take calls transferred from your campaigns.</p>
        </div>
        <button
          onClick={() => setShowCreate(true)}
          className="flex items-center gap-2 bg-brand-600 hover:bg-brand-700 text-white text-sm font-medium px-4 py-2 rounded-md"
        >
          <Plus className="w-4 h-4" /> New Agent
        </button>
      </div>

      {error && (
        <div className="flex items-center gap-2 text-sm text-red-600 bg-red-50 rounded-md px-3 py-2">
          <AlertCircle className="w-4 h-4" /> {error}
        </div>
      )}

      <DataTable
        rows={agents || []}
        emptyMessage={agents ? 'No agents yet.' : 'Loading...'}
        columns={[
          { key: 'username', label: 'Username' },
          { key: 'current_status', label: 'Status', render: (a) => <StatusBadge status={a.current_status || 'offline'} /> },
          {
            key: 'last_status_change',
            label: 'Last change',
            render: (a) => (a.last_status_change ? new Date(a.last_status_change).toLocaleString() : '-')
          },
          { key: 'created_at', label: 'Created', render: (a) => new Date(a.created_at).toLocaleDateString() }
        ]}
      />

      {showCreate && <CreateAgentModal onClose={() => setShowCreate(false)} onCreated={load} />}
    </div>
  );
}

function CreateAgentModal({ onClose, onCreated }) {
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [submitting, setSubmitting] = useState(false);

  const handleSubmit = async (e) => {
    e.preventDefault();
    setError('');
    setSubmitting(true);
    try {
      await apiPost('/api/auth/agents', { username, password });
      onCreated();
      onClose();
    } catch (err) {
      setError(err.message);
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Modal title="New Agent" onClose={onClose}>
      <form onSubmit={handleSubmit} className="space-y-4">
        <div>
          <label className="block text-sm font-medium text-slate-700 mb-1">Username</label>
          <input
            required
            autoFocus
            value={username}
            onChange={(e) => setUsername(e.target.value)}
            className="w-full border border-slate-300 rounded-md px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-brand-500"
          />
        </div>
        <div>
          <label className="block text-sm font-medium text-slate-700 mb-1">Password</label>
          <input
            required
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            className="w-full border border-slate-300 rounded-md px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-brand-500"
          />
        </div>
        {error && (
          <div className="flex items-center gap-2 text-sm text-red-600 bg-red-50 rounded-md px-3 py-2">
            <AlertCircle className="w-4 h-4" /> {error}
          </div>
        )}
        <button
          type="submit"
          disabled={submitting}
          className="w-full bg-brand-600 hover:bg-brand-700 disabled:opacity-60 text-white rounded-md py-2 text-sm font-medium"
        >
          {submitting ? 'Creating...' : 'Create Agent'}
        </button>
      </form>
    </Modal>
  );
}
