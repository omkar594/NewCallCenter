import { useEffect, useState, useCallback } from 'react';
import { useParams, Link } from 'react-router-dom';
import { ArrowLeft, AlertCircle, CheckCircle2 } from 'lucide-react';
import { apiGet, apiPut } from '../../api/client.js';
import DataTable from '../../components/DataTable.jsx';
import StatusBadge from '../../components/StatusBadge.jsx';

export default function TenantDetail() {
  const { tenantId } = useParams();
  const [tenant, setTenant] = useState(null);
  const [allPorts, setAllPorts] = useState([]);
  const [selectedPorts, setSelectedPorts] = useState([]);
  const [campaigns, setCampaigns] = useState([]);
  const [flows, setFlows] = useState([]);
  const [error, setError] = useState('');
  const [saveError, setSaveError] = useState('');
  const [saveOk, setSaveOk] = useState(false);
  const [saving, setSaving] = useState(false);

  const load = useCallback(async () => {
    try {
      const [tenants, ports, tenantCampaigns, tenantFlows] = await Promise.all([
        apiGet('/api/auth/clients'),
        apiGet('/api/gateways/ports'),
        apiGet(`/api/campaigns?tenantId=${tenantId}`),
        apiGet(`/api/ivr/flows?tenantId=${tenantId}`)
      ]);
      setTenant(tenants.find((t) => t.id === tenantId) || null);
      setAllPorts(ports);
      setSelectedPorts(ports.filter((p) => p.tenant_id === tenantId).map((p) => p.port_number));
      setCampaigns(tenantCampaigns);
      setFlows(tenantFlows);
    } catch (err) {
      setError(err.message);
    }
  }, [tenantId]);

  useEffect(() => {
    load();
  }, [load]);

  const togglePort = (port, ownedByOther) => {
    if (ownedByOther) return;
    setSelectedPorts((prev) => (prev.includes(port) ? prev.filter((p) => p !== port) : [...prev, port]));
  };

  const handleSavePorts = async () => {
    setSaveError('');
    setSaveOk(false);
    setSaving(true);
    try {
      await apiPut(`/api/gateways/tenants/${tenantId}/ports`, { portNumbers: selectedPorts });
      setSaveOk(true);
      await load();
    } catch (err) {
      setSaveError(err.message);
    } finally {
      setSaving(false);
    }
  };

  if (!tenant) {
    return error ? (
      <div className="flex items-center gap-2 text-sm text-red-600 bg-red-50 rounded-md px-3 py-2">
        <AlertCircle className="w-4 h-4" /> {error}
      </div>
    ) : (
      <p className="text-sm text-slate-500">Loading...</p>
    );
  }

  return (
    <div className="space-y-8">
      <div>
        <Link to="/admin" className="inline-flex items-center gap-1 text-sm text-slate-500 hover:text-slate-700 mb-2">
          <ArrowLeft className="w-4 h-4" /> All tenants
        </Link>
        <h1 className="text-xl font-semibold text-slate-900">{tenant.name}</h1>
        <p className="text-sm text-slate-500">{tenant.subdomain} - {tenant.admin_count} admin(s)</p>
      </div>

      <section className="bg-white border border-slate-200 rounded-lg p-6 space-y-4">
        <h2 className="font-medium text-slate-900">SIM Ports</h2>
        <p className="text-sm text-slate-500">
          Toggle any free port to add it, or untoggle one of this tenant's own to release it. Ports owned by another tenant are disabled.
        </p>
        <div className="flex flex-wrap gap-2">
          {allPorts.map((p) => {
            const isMine = p.tenant_id === tenantId;
            const ownedByOther = p.tenant_id && !isMine;
            const selected = selectedPorts.includes(p.port_number);
            return (
              <button
                key={p.port_number}
                type="button"
                disabled={ownedByOther}
                onClick={() => togglePort(p.port_number, ownedByOther)}
                title={ownedByOther ? `Owned by ${p.tenant_name}` : undefined}
                className={`px-3 py-1.5 rounded-md text-sm border ${
                  ownedByOther
                    ? 'bg-slate-100 border-slate-200 text-slate-300 cursor-not-allowed'
                    : selected
                    ? 'bg-brand-600 border-brand-600 text-white'
                    : 'bg-white border-slate-300 text-slate-700 hover:border-brand-500'
                }`}
              >
                Port {p.port_number}
              </button>
            );
          })}
        </div>
        {saveError && (
          <div className="flex items-center gap-2 text-sm text-red-600 bg-red-50 rounded-md px-3 py-2">
            <AlertCircle className="w-4 h-4" /> {saveError}
          </div>
        )}
        {saveOk && (
          <div className="flex items-center gap-2 text-sm text-emerald-700 bg-emerald-50 rounded-md px-3 py-2">
            <CheckCircle2 className="w-4 h-4" /> Ports updated.
          </div>
        )}
        <button
          onClick={handleSavePorts}
          disabled={saving}
          className="bg-brand-600 hover:bg-brand-700 disabled:opacity-60 text-white text-sm font-medium px-4 py-2 rounded-md"
        >
          {saving ? 'Saving...' : 'Save Port Allocation'}
        </button>
      </section>

      <section className="space-y-3">
        <h2 className="font-medium text-slate-900">Flows</h2>
        <DataTable
          rows={flows}
          emptyMessage="This tenant hasn't authored any flows yet."
          columns={[
            { key: 'name', label: 'Name' },
            { key: 'version', label: 'Version' },
            { key: 'is_active', label: 'Active', render: (f) => (f.is_active ? <StatusBadge status="active" /> : <StatusBadge status="offline" />) },
            { key: 'created_at', label: 'Created', render: (f) => new Date(f.created_at).toLocaleDateString() }
          ]}
        />
      </section>

      <section className="space-y-3">
        <h2 className="font-medium text-slate-900">Campaigns</h2>
        <DataTable
          rows={campaigns}
          emptyMessage="This tenant hasn't run any campaigns yet."
          columns={[
            { key: 'name', label: 'Name' },
            { key: 'status', label: 'Status', render: (c) => <StatusBadge status={c.status} /> },
            { key: 'total_leads', label: 'Leads' },
            { key: 'processed_leads', label: 'Processed' },
            { key: 'allowed_ports', label: 'Ports' }
          ]}
        />
      </section>
    </div>
  );
}
