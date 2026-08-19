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
        <h1 className="text-xl font-semibold text-ink-900 dark:text-white">Lookup Tables</h1>
        <p className="text-sm text-ink-500 dark:text-abyss-50">
          Upload CSV data a flow's <code className="bg-ink-100 dark:bg-abyss-400/60 px-1 rounded">lookup</code> node can read mid-call (account numbers, policy IDs,
          anything keyed on a column your customer enters via DTMF).
        </p>
      </div>

      <form onSubmit={handleSubmit} className="space-y-4 bg-surface dark:bg-abyss-500 border border-line dark:border-abyss-300/40 rounded-xl p-6 max-w-xl">
        <div>
          <label className="block text-sm font-medium text-ink-700 dark:text-slate-200 mb-1">Table name</label>
          <input
            required
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Account Lookup"
            className="w-full border border-line-strong dark:border-abyss-200/50 rounded-md px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-brand-500 dark:focus:ring-neon-cyan/50"
          />
        </div>
        <div>
          <label className="block text-sm font-medium text-ink-700 dark:text-slate-200 mb-1">Key column (CSV header to look up by)</label>
          <input
            required
            value={keyColumn}
            onChange={(e) => setKeyColumn(e.target.value)}
            placeholder="account_number"
            className="w-full border border-line-strong dark:border-abyss-200/50 rounded-md px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-brand-500 dark:focus:ring-neon-cyan/50"
          />
        </div>
        <FileDrop label="CSV file" accept=".csv,text/csv" file={file} onChange={setFile} />
        {error && (
          <div className="flex items-center gap-2 text-sm text-red-600 dark:text-red-300 bg-red-50 dark:bg-red-400/10 rounded-md px-3 py-2">
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
          <h2 className="font-medium text-ink-900 dark:text-white">Uploaded this session</h2>
          <p className="text-xs text-ink-500 dark:text-abyss-50">
            Copy a table's ID into a <code className="bg-ink-100 dark:bg-abyss-400/60 px-1 rounded">lookup</code> node's config when building a flow.
          </p>
          <ul className="space-y-2">
            {uploaded.map((t) => (
              <li key={t.id} className="flex items-center justify-between bg-surface dark:bg-abyss-500 border border-line dark:border-abyss-300/40 rounded-xl px-4 py-2.5 text-sm">
                <div>
                  <div className="font-medium text-ink-900 dark:text-white">{t.name}</div>
                  <div className="text-xs text-ink-500 dark:text-abyss-50">key: {t.keyColumn}</div>
                </div>
                <button
                  onClick={() => navigator.clipboard.writeText(t.id)}
                  className="flex items-center gap-1.5 text-xs text-ink-500 dark:text-abyss-50 hover:text-brand-600 dark:hover:text-neon-cyan"
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
