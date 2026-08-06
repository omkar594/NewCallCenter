import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { ArrowLeft, AlertCircle, CheckCircle2, Plus, Trash2 } from 'lucide-react';
import { apiGet, apiPost } from '../../api/client.js';
import FileDrop from '../../components/FileDrop.jsx';

const LANGUAGES = [
  { code: 'en-US', label: 'English (US)' },
  { code: 'hi-IN', label: 'Hindi' },
  { code: 'mr-IN', label: 'Marathi' }
];

export default function CampaignWizard() {
  const navigate = useNavigate();
  const [name, setName] = useState('');
  const [mode, setMode] = useState('flow'); // 'flow' | 'classic'
  const [flows, setFlows] = useState([]);
  const [flowId, setFlowId] = useState('');
  const [audioFile, setAudioFile] = useState(null);
  const [leadsSource, setLeadsSource] = useState('manual'); // 'manual' | 'csv'
  const [leads, setLeads] = useState([{ phoneNumber: '', customerName: '', languageCode: 'en-US' }]);
  const [csvFile, setCsvFile] = useState(null);
  const [ownedPorts, setOwnedPorts] = useState([]);
  const [selectedPorts, setSelectedPorts] = useState([]);
  const [error, setError] = useState('');
  const [success, setSuccess] = useState(null);
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    apiGet('/api/ivr/flows').then(setFlows).catch(() => {});
    apiGet('/api/gateways/ports').then((rows) => {
      const mine = rows.map((p) => p.port_number).sort((a, b) => a - b);
      setOwnedPorts(mine);
      setSelectedPorts(mine); // default: everything allocated to this tenant
    }).catch(() => {});
  }, []);

  const updateLead = (i, patch) => setLeads((prev) => prev.map((l, idx) => (idx === i ? { ...l, ...patch } : l)));
  const addLead = () => setLeads((prev) => [...prev, { phoneNumber: '', customerName: '', languageCode: 'en-US' }]);
  const removeLead = (i) => setLeads((prev) => prev.filter((_, idx) => idx !== i));

  const togglePort = (port) => {
    setSelectedPorts((prev) => (prev.includes(port) ? prev.filter((p) => p !== port) : [...prev, port]));
  };

  const handleSubmit = async (e) => {
    e.preventDefault();
    setError('');
    setSuccess(null);

    if (mode === 'flow' && !flowId) {
      setError('Choose a flow.');
      return;
    }
    if (mode === 'classic' && !audioFile) {
      setError('Upload a prompt audio file for a classic (non-flow) campaign.');
      return;
    }
    if (leadsSource === 'manual' && leads.every((l) => !l.phoneNumber.trim())) {
      setError('Add at least one phone number, or switch to CSV upload.');
      return;
    }
    if (leadsSource === 'csv' && !csvFile) {
      setError('Upload a leads CSV file.');
      return;
    }

    setSubmitting(true);
    try {
      const form = new FormData();
      form.append('name', name);
      if (mode === 'flow') {
        form.append('ivrFlowId', flowId);
      } else {
        form.append('audioFile', audioFile);
      }
      if (leadsSource === 'manual') {
        const cleanLeads = leads.filter((l) => l.phoneNumber.trim());
        form.append('phoneNumbers', JSON.stringify(cleanLeads));
      } else {
        form.append('leadsCsv', csvFile);
      }
      if (ownedPorts.length > 0) {
        form.append('allowedPorts', JSON.stringify(selectedPorts));
      }

      const data = await apiPost('/api/campaigns/broadcast', form);
      setSuccess(data);
    } catch (err) {
      setError(err.message);
    } finally {
      setSubmitting(false);
    }
  };

  if (success) {
    return (
      <div className="max-w-lg space-y-4">
        <div className="flex items-start gap-2 text-sm text-emerald-700 bg-emerald-50 rounded-md px-4 py-3">
          <CheckCircle2 className="w-5 h-5 mt-0.5 shrink-0" />
          <div>
            <p className="font-medium">Campaign created - {success.totalLeads} lead(s), status "{success.status}".</p>
            {success.status === 'preparing' && <p className="mt-1">Prompts are being pre-synthesized before dialing starts - watch the detail page for it to flip to "running".</p>}
          </div>
        </div>
        <div className="flex gap-3">
          <button
            onClick={() => navigate(`/app/campaigns/${success.campaignId}`)}
            className="bg-brand-600 hover:bg-brand-700 text-white text-sm font-medium px-4 py-2 rounded-md"
          >
            View Campaign
          </button>
          <button onClick={() => window.location.reload()} className="text-sm text-slate-500 hover:text-slate-700">
            Create another
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="max-w-2xl space-y-6 pb-16">
      <button onClick={() => navigate('/app/campaigns')} className="inline-flex items-center gap-1 text-sm text-slate-500 hover:text-slate-700">
        <ArrowLeft className="w-4 h-4" /> All campaigns
      </button>
      <div>
        <h1 className="text-xl font-semibold text-slate-900">New Campaign</h1>
        <p className="text-sm text-slate-500">Run an existing IVR flow, or a classic single-prompt broadcast.</p>
      </div>

      <form onSubmit={handleSubmit} className="space-y-6">
        <Section title="1. Basics">
          <div>
            <label className="block text-sm font-medium text-slate-700 mb-1">Campaign name</label>
            <input
              required
              value={name}
              onChange={(e) => setName(e.target.value)}
              className="w-full border border-slate-300 rounded-md px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-brand-500"
            />
          </div>
        </Section>

        <Section title="2. What should this campaign say?">
          <div className="flex gap-4 text-sm mb-3">
            <label className="flex items-center gap-1.5">
              <input type="radio" checked={mode === 'flow'} onChange={() => setMode('flow')} /> Run an IVR flow
            </label>
            <label className="flex items-center gap-1.5">
              <input type="radio" checked={mode === 'classic'} onChange={() => setMode('classic')} /> Single prompt (upload audio)
            </label>
          </div>
          {mode === 'flow' ? (
            <select
              value={flowId}
              onChange={(e) => setFlowId(e.target.value)}
              className="w-full border border-slate-300 rounded-md px-3 py-2 text-sm"
            >
              <option value="">Choose a flow</option>
              {flows.map((f) => (
                <option key={f.id} value={f.id}>{f.name} (v{f.version})</option>
              ))}
            </select>
          ) : (
            <FileDrop label="Prompt audio file" accept="audio/*" file={audioFile} onChange={setAudioFile} />
          )}
        </Section>

        <Section title="3. Who do we call?">
          <div className="flex gap-4 text-sm mb-3">
            <label className="flex items-center gap-1.5">
              <input type="radio" checked={leadsSource === 'manual'} onChange={() => setLeadsSource('manual')} /> Add numbers manually
            </label>
            <label className="flex items-center gap-1.5">
              <input type="radio" checked={leadsSource === 'csv'} onChange={() => setLeadsSource('csv')} /> Upload CSV (bulk)
            </label>
          </div>
          {leadsSource === 'manual' ? (
            <div className="space-y-2">
              {leads.map((lead, i) => (
                <div key={i} className="flex items-center gap-2">
                  <input
                    value={lead.phoneNumber}
                    onChange={(e) => updateLead(i, { phoneNumber: e.target.value })}
                    placeholder="+91XXXXXXXXXX"
                    className="border border-slate-300 rounded-md px-2 py-1.5 text-sm flex-1"
                  />
                  <input
                    value={lead.customerName}
                    onChange={(e) => updateLead(i, { customerName: e.target.value })}
                    placeholder="Customer name (optional)"
                    className="border border-slate-300 rounded-md px-2 py-1.5 text-sm flex-1"
                  />
                  <select
                    value={lead.languageCode}
                    onChange={(e) => updateLead(i, { languageCode: e.target.value })}
                    className="border border-slate-300 rounded-md px-2 py-1.5 text-sm"
                  >
                    {LANGUAGES.map((l) => (
                      <option key={l.code} value={l.code}>{l.label}</option>
                    ))}
                  </select>
                  {leads.length > 1 && (
                    <button type="button" onClick={() => removeLead(i)} className="text-slate-400 hover:text-red-600">
                      <Trash2 className="w-4 h-4" />
                    </button>
                  )}
                </div>
              ))}
              <button type="button" onClick={addLead} className="flex items-center gap-1.5 text-sm text-brand-600 hover:underline">
                <Plus className="w-4 h-4" /> Add another number
              </button>
            </div>
          ) : (
            <FileDrop label="Leads CSV (phone / name / language columns)" accept=".csv,text/csv" file={csvFile} onChange={setCsvFile} />
          )}
        </Section>

        <Section title="4. Which SIM ports?">
          {ownedPorts.length === 0 ? (
            <p className="text-sm text-slate-500">No ports specifically allocated to you - this campaign will use whatever's available.</p>
          ) : (
            <div className="flex flex-wrap gap-2">
              {ownedPorts.map((port) => (
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
        </Section>

        {error && (
          <div className="flex items-start gap-2 text-sm text-red-600 bg-red-50 rounded-md px-3 py-2">
            <AlertCircle className="w-4 h-4 mt-0.5 shrink-0" /> {error}
          </div>
        )}

        <button
          type="submit"
          disabled={submitting}
          className="bg-brand-600 hover:bg-brand-700 disabled:opacity-60 text-white text-sm font-medium px-6 py-2.5 rounded-md"
        >
          {submitting ? 'Creating...' : 'Create Campaign'}
        </button>
      </form>
    </div>
  );
}

function Section({ title, children }) {
  return (
    <div className="bg-white border border-slate-200 rounded-lg p-5 space-y-3">
      <h2 className="text-sm font-semibold text-slate-900">{title}</h2>
      {children}
    </div>
  );
}
