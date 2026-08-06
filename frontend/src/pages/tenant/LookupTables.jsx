import { useState } from 'react';
import { AlertCircle, Copy } from 'lucide-react';
import { apiPost } from '../../api/client.js';
import FileDrop from '../../components/FileDrop.jsx';

export default function LookupTables() {
  const [name, setName] = useState('');
  const [keyColumn, setKeyColumn] = useState('');
  const [file, setFile] = useState(null);
  const [error, setError] = useState('');
  const [uploaded, setUploaded] = useState([]);
  const [submitting, setSubmitting] = useState(false);

  const handleSubmit = async (e) => {
    e.preventDefault();
    setError('');
    if (!file) {
      setError('Choose a CSV file first.');
      return;
    }
    setSubmitting(true);
    try {
      const form = new FormData();
      form.append('name', name);
      form.append('keyColumn', keyColumn);
      form.append('csv', file);
      const data = await apiPost('/api/ivr/lookup-tables', form);
      setUploaded((prev) => [{ ...data, name, keyColumn }, ...prev]);
      setName('');
      setKeyColumn('');
      setFile(null);
    } catch (err) {
      setError(err.message);
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="space-y-8">
      <div>
        <h1 className="text-xl font-semibold text-slate-900">Lookup Tables</h1>
        <p className="text-sm text-slate-500">
          Upload CSV data a flow's <code className="bg-slate-100 px-1 rounded">lookup</code> node can read mid-call (account numbers, policy IDs,
          anything keyed on a column your customer enters via DTMF).
        </p>
      </div>

      <form onSubmit={handleSubmit} className="space-y-4 bg-white border border-slate-200 rounded-lg p-6 max-w-xl">
        <div>
          <label className="block text-sm font-medium text-slate-700 mb-1">Table name</label>
          <input
            required
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Account Lookup"
            className="w-full border border-slate-300 rounded-md px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-brand-500"
          />
        </div>
        <div>
          <label className="block text-sm font-medium text-slate-700 mb-1">Key column (CSV header to look up by)</label>
          <input
            required
            value={keyColumn}
            onChange={(e) => setKeyColumn(e.target.value)}
            placeholder="account_number"
            className="w-full border border-slate-300 rounded-md px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-brand-500"
          />
        </div>
        <FileDrop label="CSV file" accept=".csv,text/csv" file={file} onChange={setFile} />
        {error && (
          <div className="flex items-center gap-2 text-sm text-red-600 bg-red-50 rounded-md px-3 py-2">
            <AlertCircle className="w-4 h-4" /> {error}
          </div>
        )}
        <button
          type="submit"
          disabled={submitting}
          className="bg-brand-600 hover:bg-brand-700 disabled:opacity-60 text-white text-sm font-medium px-4 py-2 rounded-md"
        >
          {submitting ? 'Uploading...' : 'Upload Table'}
        </button>
      </form>

      {uploaded.length > 0 && (
        <section className="space-y-3 max-w-xl">
          <h2 className="font-medium text-slate-900">Uploaded this session</h2>
          <p className="text-xs text-slate-500">
            Copy a table's ID into a <code className="bg-slate-100 px-1 rounded">lookup</code> node's config when building a flow.
          </p>
          <ul className="space-y-2">
            {uploaded.map((t) => (
              <li key={t.id} className="flex items-center justify-between bg-white border border-slate-200 rounded-md px-4 py-2.5 text-sm">
                <div>
                  <div className="font-medium text-slate-900">{t.name}</div>
                  <div className="text-xs text-slate-500">key: {t.keyColumn}</div>
                </div>
                <button
                  onClick={() => navigator.clipboard.writeText(t.id)}
                  className="flex items-center gap-1.5 text-xs text-slate-500 hover:text-brand-600"
                  title={t.id}
                >
                  <Copy className="w-3.5 h-3.5" /> copy ID
                </button>
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}
