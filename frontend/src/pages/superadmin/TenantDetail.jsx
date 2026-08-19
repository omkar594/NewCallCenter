import { useEffect, useState, useCallback } from 'react';
import { useParams, Link } from 'react-router-dom';
import { ArrowLeft, AlertCircle, CheckCircle2, PowerOff, Power, Coins, Plus } from 'lucide-react';
import { apiGet, apiPut, apiPost, apiPatch } from '../../api/client.js';
import DataTable from '../../components/DataTable.jsx';
import StatusBadge from '../../components/StatusBadge.jsx';
import Modal from '../../components/Modal.jsx';

// key = what the PATCH endpoint accepts; column = what the tenants row returns.
const PLAN_FEATURES = [
  { key: 'ivrEnabled', column: 'ivr_enabled', label: 'IVR flows', hint: 'Visual multi-step call flows, menus, lookups and TTS prompts.' },
  { key: 'agentsEnabled', column: 'agents_enabled', label: 'Live agents', hint: 'Softphone agents taking press-1 transfers, in this client\u2019s own isolated queue.' },
  { key: 'inboundEnabled', column: 'inbound_enabled', label: 'Inbound calling', hint: 'Customers can call this client\u2019s SIM numbers back. Needs live agents to be any use.' }
];

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
  const [showLifecycleModal, setShowLifecycleModal] = useState(false);
  const [lifecycleError, setLifecycleError] = useState('');
  const [lifecycleSubmitting, setLifecycleSubmitting] = useState(false);
  const [transactions, setTransactions] = useState([]);
  const [showCreditModal, setShowCreditModal] = useState(false);
  const [creditAmount, setCreditAmount] = useState('');
  const [creditNote, setCreditNote] = useState('');
  const [creditError, setCreditError] = useState('');
  const [creditSubmitting, setCreditSubmitting] = useState(false);
  const [planSaving, setPlanSaving] = useState('');
  const [planError, setPlanError] = useState('');

  const load = useCallback(async () => {
    try {
      const [tenants, ports, tenantCampaigns, tenantFlows, creditTransactions] = await Promise.all([
        apiGet('/api/auth/clients'),
        apiGet('/api/gateways/ports'),
        apiGet(`/api/campaigns?tenantId=${tenantId}`),
        apiGet(`/api/ivr/flows?tenantId=${tenantId}`),
        apiGet(`/api/auth/clients/${tenantId}/credits/transactions`)
      ]);
      setTenant(tenants.find((t) => t.id === tenantId) || null);
      setAllPorts(ports);
      setSelectedPorts(ports.filter((p) => p.tenant_id === tenantId).map((p) => p.port_number));
      setCampaigns(tenantCampaigns);
      setFlows(tenantFlows);
      setTransactions(creditTransactions);
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

  const isActive = (tenant?.status || 'active') === 'active';

  const handleAddCredits = async () => {
    setCreditError('');
    const amount = Number(creditAmount);
    if (!Number.isInteger(amount) || amount <= 0) {
      setCreditError('Enter a positive whole number of credits.');
      return;
    }
    setCreditSubmitting(true);
    try {
      await apiPost(`/api/auth/clients/${tenantId}/credits`, { amount, note: creditNote || undefined });
      setShowCreditModal(false);
      setCreditAmount('');
      setCreditNote('');
      await load();
    } catch (err) {
      setCreditError(err.message);
    } finally {
      setCreditSubmitting(false);
    }
  };

  const handleLifecycleAction = async () => {
    setLifecycleError('');
    setLifecycleSubmitting(true);
    try {
      const action = isActive ? 'deactivate' : 'reactivate';
      await apiPost(`/api/auth/clients/${tenantId}/${action}`);
      setShowLifecycleModal(false);
      await load();
    } catch (err) {
      setLifecycleError(err.message);
    } finally {
      setLifecycleSubmitting(false);
    }
  };

  if (!tenant) {
    return error ? (
      <div className="flex items-center gap-2 text-sm text-red-600 dark:text-red-300 bg-red-50 dark:bg-red-400/10 rounded-md px-3 py-2">
        <AlertCircle className="w-4 h-4" /> {error}
      </div>
    ) : (
      <p className="text-sm text-ink-500 dark:text-abyss-50">Loading...</p>
    );
  }

  // Toggling a capability takes effect immediately: the backend clears its per-tenant cache, so
  // the next call dispatch and the next API request from that client already see the new plan.
  // Turning agents off does NOT delete the client's agents or their SIP endpoints - it stops the
  // capability being usable, so a billing change is reversible and destroys nothing.
  const togglePlanFeature = async (key, value) => {
    setPlanError('');
    setPlanSaving(key);
    try {
      const data = await apiPatch(`/api/auth/clients/${tenantId}/features`, { [key]: value });
      setTenant((t) => ({ ...t, ...data.tenant }));
    } catch (err) {
      setPlanError(err.message);
    } finally {
      setPlanSaving('');
    }
  };

  return (
    <div className="space-y-8">
      <div>
        <Link to="/admin" className="inline-flex items-center gap-1 text-sm text-ink-500 dark:text-abyss-50 hover:text-ink-700 mb-2">
          <ArrowLeft className="w-4 h-4" /> All tenants
        </Link>
        <div className="flex items-center justify-between">
          <div>
            <div className="flex items-center gap-2">
              <h1 className="text-xl font-semibold text-ink-900 dark:text-white">{tenant.name}</h1>
              <StatusBadge status={tenant.status || 'active'} />
            </div>
            <p className="text-sm text-ink-500 dark:text-abyss-50">
              {tenant.subdomain} - {tenant.admin_count} admin(s) -{' '}
              <span className={tenant.credit_balance > 0 ? 'text-ink-700' : 'text-red-600 font-medium'}>
                {tenant.credit_balance ?? 0} credits remaining
              </span>
            </p>
          </div>
          <div className="flex items-center gap-2">
            <button
              onClick={() => { setCreditError(''); setShowCreditModal(true); }}
              className="flex items-center gap-2 text-sm font-medium px-4 py-2 rounded-md bg-amber-500 hover:bg-amber-600 text-white"
            >
              <Plus className="w-4 h-4" /> Add Credits
            </button>
            <button
              onClick={() => { setLifecycleError(''); setShowLifecycleModal(true); }}
              className={`flex items-center gap-2 text-sm font-medium px-4 py-2 rounded-md ${
                isActive ? 'bg-red-600 hover:bg-red-700 text-white' : 'bg-emerald-600 hover:bg-emerald-700 text-white'
              }`}
            >
              {isActive ? <PowerOff className="w-4 h-4" /> : <Power className="w-4 h-4" />}
              {isActive ? 'Deactivate Client' : 'Reactivate Client'}
            </button>
          </div>
        </div>
      </div>

      {showCreditModal && (
        <Modal title="Add Credits" onClose={() => setShowCreditModal(false)}>
          <div className="space-y-4">
            <p className="text-sm text-ink-600 dark:text-slate-300">
              Current balance: <strong>{tenant.credit_balance ?? 0} credits</strong>. Every answered call deducts 1
              credit per 15 seconds of connected duration.
            </p>
            <div>
              <label className="block text-sm font-medium text-ink-700 dark:text-slate-200 mb-1">Credits to add</label>
              <input
                type="number"
                min="1"
                step="1"
                value={creditAmount}
                onChange={(e) => setCreditAmount(e.target.value)}
                className="w-full border border-line-strong dark:border-abyss-200/50 rounded-md px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-brand-500 dark:focus:ring-neon-cyan/50"
              />
            </div>
            <div>
              <label className="block text-sm font-medium text-ink-700 dark:text-slate-200 mb-1">Note (optional)</label>
              <input
                value={creditNote}
                onChange={(e) => setCreditNote(e.target.value)}
                placeholder="e.g. Monthly top-up"
                className="w-full border border-line-strong dark:border-abyss-200/50 rounded-md px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-brand-500 dark:focus:ring-neon-cyan/50"
              />
            </div>
            {creditError && (
              <div className="flex items-center gap-2 text-sm text-red-600 dark:text-red-300 bg-red-50 dark:bg-red-400/10 rounded-md px-3 py-2">
                <AlertCircle className="w-4 h-4" /> {creditError}
              </div>
            )}
            <div className="flex gap-3">
              <button
                onClick={handleAddCredits}
                disabled={creditSubmitting}
                className="text-sm font-medium px-4 py-2 rounded-md text-white bg-amber-500 hover:bg-amber-600 disabled:opacity-60"
              >
                {creditSubmitting ? 'Adding...' : 'Add Credits'}
              </button>
              <button onClick={() => setShowCreditModal(false)} className="text-sm text-ink-500 dark:text-abyss-50 hover:text-ink-700 px-4 py-2">
                Cancel
              </button>
            </div>
          </div>
        </Modal>
      )}

      {showLifecycleModal && (
        <Modal title={isActive ? 'Deactivate this client?' : 'Reactivate this client?'} onClose={() => setShowLifecycleModal(false)}>
          <div className="space-y-4">
            {isActive ? (
              <ul className="text-sm text-ink-600 dark:text-slate-300 space-y-1.5 list-disc pl-5">
                <li>Every login for <strong>{tenant.name}</strong> stops working immediately.</li>
                <li>Their SIM ports ({selectedPorts.length ? selectedPorts.join(', ') : 'none'}) are released back to the free pool.</li>
                <li>Any preparing/running campaigns are cancelled - the dialer stops touching their leads.</li>
                <li>Nothing is deleted - flows, campaigns, and call history stay fully intact and can be reviewed any time.</li>
              </ul>
            ) : (
              <ul className="text-sm text-ink-600 dark:text-slate-300 space-y-1.5 list-disc pl-5">
                <li>Logins for <strong>{tenant.name}</strong> work again immediately.</li>
                <li>Ports are <strong>not</strong> automatically restored - assign new ones below after reactivating.</li>
                <li>Cancelled campaigns stay cancelled - they won't resume dialing on their own.</li>
              </ul>
            )}
            {lifecycleError && (
              <div className="flex items-center gap-2 text-sm text-red-600 dark:text-red-300 bg-red-50 dark:bg-red-400/10 rounded-md px-3 py-2">
                <AlertCircle className="w-4 h-4" /> {lifecycleError}
              </div>
            )}
            <div className="flex gap-3">
              <button
                onClick={handleLifecycleAction}
                disabled={lifecycleSubmitting}
                className={`text-sm font-medium px-4 py-2 rounded-md text-white disabled:opacity-60 ${
                  isActive ? 'bg-red-600 hover:bg-red-700' : 'bg-emerald-600 hover:bg-emerald-700'
                }`}
              >
                {lifecycleSubmitting ? 'Working...' : isActive ? 'Yes, deactivate' : 'Yes, reactivate'}
              </button>
              <button onClick={() => setShowLifecycleModal(false)} className="text-sm text-ink-500 dark:text-abyss-50 hover:text-ink-700 px-4 py-2">
                Cancel
              </button>
            </div>
          </div>
        </Modal>
      )}

      <section className="bg-surface dark:bg-abyss-500 border border-line dark:border-abyss-300/40 rounded-xl p-6 space-y-4">
        <h2 className="font-medium text-ink-900 dark:text-white">Plan</h2>
        <p className="text-sm text-ink-500 dark:text-abyss-50">
          What this client can use. Outbound broadcast campaigns are always included. Each toggle is enforced
          in the API, not just hidden in their UI.
        </p>
        <div className="space-y-2">
          {PLAN_FEATURES.map(({ key, column, label, hint }) => (
            <label key={key} className="flex items-start gap-3 rounded-lg border border-line dark:border-abyss-200/40 px-3 py-2.5 cursor-pointer">
              <input
                type="checkbox"
                checked={Boolean(tenant[column])}
                disabled={planSaving === key}
                onChange={(e) => togglePlanFeature(key, e.target.checked)}
                className="mt-0.5 h-4 w-4 shrink-0 accent-brand-600"
              />
              <div className="min-w-0">
                <p className="text-sm font-medium text-ink-700 dark:text-slate-200">{label}</p>
                <p className="text-xs text-ink-400 dark:text-abyss-100">{hint}</p>
              </div>
            </label>
          ))}
        </div>
        {/* The queue is what actually keeps this client's calls away from every other client's
            agents - worth surfacing so it can be checked against `queue show` on the PBX. */}
        {tenant.agent_queue_name && (
          <p className="text-xs text-ink-400 dark:text-abyss-100">
            Isolated agent queue: <code className="font-mono">{tenant.agent_queue_name}</code>
            {tenant.agent_count ? ` - ${tenant.agent_count} agent(s)` : ' - no agents yet'}
          </p>
        )}
        {planError && <p className="text-sm text-red-600 dark:text-red-300">{planError}</p>}
      </section>

      <section className="bg-surface dark:bg-abyss-500 border border-line dark:border-abyss-300/40 rounded-xl p-6 space-y-4">
        <h2 className="font-medium text-ink-900 dark:text-white">SIM Ports</h2>
        <p className="text-sm text-ink-500 dark:text-abyss-50">
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
                    ? 'bg-ink-100 border-line text-ink-300 cursor-not-allowed'
                    : selected
                    ? 'bg-brand-600 border-brand-600 text-white'
                    : 'bg-white border-line-strong text-ink-700 hover:border-brand-500'
                }`}
              >
                Port {p.port_number}
              </button>
            );
          })}
        </div>
        {saveError && (
          <div className="flex items-center gap-2 text-sm text-red-600 dark:text-red-300 bg-red-50 dark:bg-red-400/10 rounded-md px-3 py-2">
            <AlertCircle className="w-4 h-4" /> {saveError}
          </div>
        )}
        {saveOk && (
          <div className="flex items-center gap-2 text-sm text-emerald-700 dark:text-neon-green bg-emerald-50 dark:bg-neon-green/10 rounded-md px-3 py-2">
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
        <h2 className="font-medium text-ink-900 dark:text-white">Flows</h2>
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
        <h2 className="font-medium text-ink-900 dark:text-white">Campaigns</h2>
        <DataTable
          rows={campaigns}
          emptyMessage="This tenant hasn't run any campaigns yet."
          columns={[
            {
              key: 'name',
              label: 'Name',
              render: (c) => (
                <Link to={`/admin/tenants/${tenantId}/campaigns/${c.id}`} className="text-ink-900 dark:text-white font-medium hover:text-brand-600 dark:hover:text-neon-cyan">
                  {c.name}
                </Link>
              )
            },
            { key: 'status', label: 'Status', render: (c) => <StatusBadge status={c.status} /> },
            { key: 'total_leads', label: 'Leads' },
            { key: 'processed_leads', label: 'Processed' },
            { key: 'allowed_ports', label: 'Ports' }
          ]}
        />
      </section>

      <section className="space-y-3">
        <h2 className="font-medium text-ink-900 dark:text-white flex items-center gap-2">
          <Coins className="w-4 h-4 text-amber-500" /> Credit History
        </h2>
        <DataTable
          rows={transactions}
          emptyMessage="No credit activity yet."
          columns={[
            {
              key: 'type',
              label: 'Type',
              render: (t) => (
                <span className={`inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium ${
                  t.type === 'topup' ? 'bg-emerald-100 text-emerald-700' : 'bg-ink-100 text-ink-600'
                }`}>
                  {t.type === 'topup' ? 'Top-up' : 'Deduction'}
                </span>
              )
            },
            { key: 'amount', label: 'Amount', render: (t) => (t.amount > 0 ? `+${t.amount}` : t.amount) },
            { key: 'balance_after', label: 'Balance After' },
            { key: 'note', label: 'Note', render: (t) => t.note || '-' },
            { key: 'created_at', label: 'When', render: (t) => new Date(t.created_at).toLocaleString() }
          ]}
        />
      </section>
    </div>
  );
}
