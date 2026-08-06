import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { Users, Plus, AlertCircle } from 'lucide-react';
import { apiGet } from '../../api/client.js';
import DataTable from '../../components/DataTable.jsx';

export default function SuperAdminDashboard() {
  const [tenants, setTenants] = useState(null);
  const [ports, setPorts] = useState([]);
  const [error, setError] = useState('');

  useEffect(() => {
    Promise.all([apiGet('/api/auth/clients'), apiGet('/api/gateways/ports')])
      .then(([tenantRows, portRows]) => {
        setTenants(tenantRows);
        setPorts(portRows);
      })
      .catch((err) => setError(err.message));
  }, []);

  const portsByTenant = (tenantId) => ports.filter((p) => p.tenant_id === tenantId).map((p) => p.port_number).sort((a, b) => a - b);

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-xl font-semibold text-slate-900">Tenants</h1>
          <p className="text-sm text-slate-500">Every client onboarded on this platform.</p>
        </div>
        <Link
          to="/admin/onboard"
          className="flex items-center gap-2 bg-brand-600 hover:bg-brand-700 text-white text-sm font-medium px-4 py-2 rounded-md"
        >
          <Plus className="w-4 h-4" />
          Onboard Client
        </Link>
      </div>

      {error && (
        <div className="flex items-center gap-2 text-sm text-red-600 bg-red-50 rounded-md px-3 py-2">
          <AlertCircle className="w-4 h-4" /> {error}
        </div>
      )}

      <DataTable
        rows={tenants || []}
        emptyMessage={tenants ? 'No tenants onboarded yet.' : 'Loading...'}
        columns={[
          {
            key: 'name',
            label: 'Tenant',
            render: (t) => (
              <Link to={`/admin/tenants/${t.id}`} className="flex items-center gap-2 text-slate-900 font-medium hover:text-brand-600">
                <Users className="w-4 h-4 text-slate-400" />
                {t.name}
              </Link>
            )
          },
          { key: 'subdomain', label: 'Subdomain' },
          { key: 'admin_count', label: 'Admins' },
          {
            key: 'ports',
            label: 'Ports',
            render: (t) => {
              const p = portsByTenant(t.id);
              return p.length ? p.join(', ') : <span className="text-slate-400">none</span>;
            }
          },
          {
            key: 'created_at',
            label: 'Onboarded',
            render: (t) => new Date(t.created_at).toLocaleDateString()
          }
        ]}
      />
    </div>
  );
}
