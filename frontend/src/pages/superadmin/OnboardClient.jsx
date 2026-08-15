import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { AlertCircle, CheckCircle2 } from 'lucide-react';
import { apiGet, apiPost } from '../../api/client.js';

export default function OnboardClient() {
  const navigate = useNavigate();
  const [freePorts, setFreePorts] = useState([]);
  const [form, setForm] = useState({ tenantName: '', subdomain: '', adminUsername: '', adminPassword: '' });
  const [selectedPorts, setSelectedPorts] = useState([]);
  const [error, setError] = useState('');
  const [success, setSuccess] = useState(null);
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    apiGet('/api/gateways/ports')
      .then((rows) => setFreePorts(rows.filter((p) => !p.tenant_id).map((p) => p.port_number).sort((a, b) => a - b)))
      .catch((err) => setError(err.message));
  }, []);

  const togglePort = (port) => {
    setSelectedPorts((prev) => (prev.includes(port) ? prev.filter((p) => p !== port) : [...prev, port]));
  };

  const update = (field) => (e) => setForm((f) => ({ ...f, [field]: e.target.value }));

  const handleSubmit = async (e) => {
    e.preventDefault();
    setError('');
    setSuccess(null);
    if (selectedPorts.length === 0) {
      setError('Select at least one SIM port for this client - port assignment is mandatory at onboarding.');
      return;
    }
    setSubmitting(true);
    try {
      const data = await apiPost('/api/auth/clients', { ...form, portNumbers: selectedPorts });
      setSuccess(data);
      setForm({ tenantName: '', subdomain: '', adminUsername: '', adminPassword: '' });
      setSelectedPorts([]);
      setFreePorts((prev) => prev.filter((p) => !data.ports.includes(p)));
    } catch (err) {
      setError(err.message);
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="max-w-xl space-y-6">
      <div>
        <h1 className="text-xl font-semibold text-slate-900 dark:text-white">Onboard Client</h1>
        <p className="text-sm text-slate-500 dark:text-abyss-50">Creates a new isolated tenant, its first admin login, and grants SIM ports - all atomically.</p>
      </div>

      <form onSubmit={handleSubmit} className="space-y-4 bg-white dark:bg-abyss-500 border border-slate-200 dark:border-abyss-300/30 rounded-lg p-6">
        <Field label="Tenant name" value={form.tenantName} onChange={update('tenantName')} placeholder="Apex Bank" />
        <Field label="Subdomain" value={form.subdomain} onChange={update('subdomain')} placeholder="apexbank" />
        <Field label="Admin username" value={form.adminUsername} onChange={update('adminUsername')} placeholder="apexbank_admin" />
        <Field label="Admin password" type="password" value={form.adminPassword} onChange={update('adminPassword')} />

        <div>
          <label className="block text-sm font-medium text-slate-700 dark:text-slate-200 mb-2">SIM ports to assign</label>
          {freePorts.length === 0 ? (
            <p className="text-sm text-slate-400 dark:text-abyss-100">No free ports available - free one up first (Gateways & Ports) or expand the gateway.</p>
          ) : (
            <div className="flex flex-wrap gap-2">
              {freePorts.map((port) => (
                <button
                  type="button"
                  key={port}
                  onClick={() => togglePort(port)}
                  className={`px-3 py-1.5 rounded-md text-sm border ${
                    selectedPorts.includes(port)
                      ? 'bg-brand-600 border-brand-600 text-white'
                      : 'bg-white border-slate-300 text-slate-700 hover:border-brand-500'
                  }`}
                >
                  Port {port}
                </button>
              ))}
            </div>
          )}
        </div>

        {error && (
          <div className="flex items-start gap-2 text-sm text-red-600 dark:text-red-300 bg-red-50 dark:bg-red-400/10 rounded-md px-3 py-2">
            <AlertCircle className="w-4 h-4 mt-0.5 shrink-0" /> {error}
          </div>
        )}
        {success && (
          <div className="flex items-start gap-2 text-sm text-emerald-700 dark:text-neon-green bg-emerald-50 dark:bg-neon-green/10 rounded-md px-3 py-2">
            <CheckCircle2 className="w-4 h-4 mt-0.5 shrink-0" />
            <span>
              Onboarded <strong>{success.tenant.name}</strong> with ports [{success.ports.join(', ')}].{' '}
              <button type="button" className="underline" onClick={() => navigate(`/admin/tenants/${success.tenant.id}`)}>
                View tenant
              </button>
            </span>
          </div>
        )}

        <button
          type="submit"
          disabled={submitting}
          className="w-full bg-brand-600 hover:bg-brand-700 disabled:opacity-60 text-white rounded-md py-2 text-sm font-medium"
        >
          {submitting ? 'Onboarding...' : 'Onboard Client'}
        </button>
      </form>
    </div>
  );
}

function Field({ label, ...props }) {
  return (
    <div>
      <label className="block text-sm font-medium text-slate-700 dark:text-slate-200 mb-1">{label}</label>
      <input
        {...props}
        required
        className="w-full border border-slate-300 dark:border-abyss-200/50 rounded-md px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-brand-500 dark:focus:ring-neon-cyan/50"
      />
    </div>
  );
}
