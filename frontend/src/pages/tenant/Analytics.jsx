import { useEffect, useState } from 'react';
import { AlertCircle, TrendingUp, Clock, AlertTriangle, PhoneMissed } from 'lucide-react';
import { apiGet } from '../../api/client.js';
import DataTable from '../../components/DataTable.jsx';
import StatusBadge from '../../components/StatusBadge.jsx';

// Tailwind's content scanner only picks up complete class name strings, not template-literal
// interpolations like `bg-${tone}-50` - those would silently never render in a production
// build. This lookup keeps every class name whole and statically visible in the source.
const TONE_CLASSES = {
  brand: 'bg-brand-50 text-brand-600',
  emerald: 'bg-emerald-50 text-emerald-600',
  amber: 'bg-amber-50 text-amber-600',
  red: 'bg-red-50 text-red-600'
};

function StatCard({ icon: Icon, label, value, tone = 'brand' }) {
  return (
    <div className="bg-white dark:bg-abyss-500 border border-slate-200 dark:border-abyss-300/30 rounded-lg p-5 flex items-center gap-4">
      <div className={`w-10 h-10 rounded-lg flex items-center justify-center ${TONE_CLASSES[tone]}`}>
        <Icon className="w-5 h-5" />
      </div>
      <div>
        <div className="text-2xl font-semibold text-slate-900 dark:text-white">{value}</div>
        <div className="text-xs text-slate-500 dark:text-abyss-50">{label}</div>
      </div>
    </div>
  );
}

export default function Analytics() {
  const [metrics, setMetrics] = useState(null);
  const [logs, setLogs] = useState([]);
  const [error, setError] = useState('');

  useEffect(() => {
    Promise.all([apiGet('/api/analytics/live'), apiGet('/api/analytics/logs')])
      .then(([m, l]) => {
        setMetrics(m);
        setLogs(l);
      })
      .catch((err) => setError(err.message));
  }, []);

  return (
    <div className="space-y-8">
      <div>
        <h1 className="text-xl font-semibold text-slate-900 dark:text-white">Analytics</h1>
        <p className="text-sm text-slate-500 dark:text-abyss-50">Live agent and call performance for your tenant.</p>
      </div>

      {error && (
        <div className="flex items-center gap-2 text-sm text-red-600 dark:text-red-300 bg-red-50 dark:bg-red-400/10 rounded-md px-3 py-2">
          <AlertCircle className="w-4 h-4" /> {error}
        </div>
      )}

      {metrics && (
        <>
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-4">
            <StatCard icon={TrendingUp} label="Conversions today" value={metrics.todayConversions} tone="emerald" />
            <StatCard icon={Clock} label="Active queue" value={metrics.activeQueueVolume} />
            <StatCard icon={AlertTriangle} label="SLA breaches" value={metrics.slaBreaches} tone="amber" />
            <StatCard icon={PhoneMissed} label="Missed today" value={metrics.missedCallsToday} tone="red" />
          </div>

          <section className="space-y-3">
            <h2 className="font-medium text-slate-900 dark:text-white">Agent Status</h2>
            <div className="flex flex-wrap gap-3">
              {Object.entries(metrics.agentStatusCounts).map(([status, count]) => (
                <div key={status} className="bg-white dark:bg-abyss-500 border border-slate-200 dark:border-abyss-300/30 rounded-md px-4 py-2 flex items-center gap-2 text-sm">
                  <StatusBadge status={status} /> <span className="text-slate-600 dark:text-slate-300">{count}</span>
                </div>
              ))}
            </div>
            <DataTable
              rows={metrics.agentsList}
              rowKey={(a) => a.username}
              emptyMessage="No agents yet."
              columns={[
                { key: 'username', label: 'Agent' },
                { key: 'current_status', label: 'Status', render: (a) => <StatusBadge status={a.current_status} /> },
                { key: 'current_language', label: 'Language', render: (a) => a.current_language || '-' },
                { key: 'daily_transfer_count', label: 'Transfers today' }
              ]}
            />
          </section>
        </>
      )}

      <section className="space-y-3">
        <h2 className="font-medium text-slate-900 dark:text-white">Recent Calls</h2>
        <DataTable
          rows={logs}
          emptyMessage="No calls logged yet."
          columns={[
            { key: 'caller_number', label: 'Caller' },
            { key: 'callee_number', label: 'Callee' },
            { key: 'status', label: 'Status', render: (c) => <StatusBadge status={c.status} /> },
            { key: 'agent_name', label: 'Agent', render: (c) => c.agent_name || '-' },
            { key: 'duration', label: 'Duration (s)' },
            { key: 'start_time', label: 'Started', render: (c) => (c.start_time ? new Date(c.start_time).toLocaleString() : '-') }
          ]}
        />
      </section>
    </div>
  );
}
