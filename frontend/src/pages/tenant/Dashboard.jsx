import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { Megaphone, Workflow, Server, AlertCircle } from 'lucide-react';
import { apiGet } from '../../api/client.js';
import { useAuth } from '../../context/AuthContext.jsx';
import DataTable from '../../components/DataTable.jsx';
import StatusBadge from '../../components/StatusBadge.jsx';

function StatCard({ icon: Icon, label, value }) {
  return (
    <div className="bg-white border border-slate-200 rounded-lg p-5 flex items-center gap-4">
      <div className="w-10 h-10 rounded-lg bg-brand-50 text-brand-600 flex items-center justify-center">
        <Icon className="w-5 h-5" />
      </div>
      <div>
        <div className="text-2xl font-semibold text-slate-900">{value}</div>
        <div className="text-xs text-slate-500">{label}</div>
      </div>
    </div>
  );
}

export default function TenantDashboard() {
  const { user } = useAuth();
  const [campaigns, setCampaigns] = useState([]);
  const [flows, setFlows] = useState([]);
  const [ports, setPorts] = useState([]);
  const [error, setError] = useState('');

  useEffect(() => {
    Promise.all([apiGet('/api/campaigns'), apiGet('/api/ivr/flows'), apiGet('/api/gateways/ports')])
      .then(([c, f, p]) => {
        setCampaigns(c);
        setFlows(f);
        setPorts(p);
      })
      .catch((err) => setError(err.message));
  }, []);

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-xl font-semibold text-slate-900">Welcome, {user?.tenant_name}</h1>
        <p className="text-sm text-slate-500">Here's what's happening across your flows and campaigns.</p>
      </div>

      {error && (
        <div className="flex items-center gap-2 text-sm text-red-600 bg-red-50 rounded-md px-3 py-2">
          <AlertCircle className="w-4 h-4" /> {error}
        </div>
      )}

      <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
        <StatCard icon={Megaphone} label="Campaigns" value={campaigns.length} />
        <StatCard icon={Workflow} label="Flows" value={flows.length} />
        <StatCard icon={Server} label="SIM Ports" value={ports.map((p) => p.port_number).join(', ') || 'none'} />
      </div>

      <section className="space-y-3">
        <div className="flex items-center justify-between">
          <h2 className="font-medium text-slate-900">Recent Campaigns</h2>
          <Link to="/app/campaigns" className="text-sm text-brand-600 hover:underline">View all</Link>
        </div>
        <DataTable
          rows={campaigns.slice(0, 5)}
          emptyMessage="No campaigns yet."
          columns={[
            {
              key: 'name',
              label: 'Name',
              render: (c) => <Link to={`/app/campaigns/${c.id}`} className="text-slate-900 font-medium hover:text-brand-600">{c.name}</Link>
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
