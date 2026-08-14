const STYLES = {
  pending: 'bg-slate-100 text-slate-600',
  preparing: 'bg-amber-100 text-amber-700',
  running: 'bg-blue-100 text-blue-700',
  paused: 'bg-yellow-100 text-yellow-700',
  processing: 'bg-indigo-100 text-indigo-700',
  answered: 'bg-emerald-100 text-emerald-700',
  completed: 'bg-emerald-100 text-emerald-700',
  active: 'bg-emerald-100 text-emerald-700',
  idle: 'bg-emerald-100 text-emerald-700',
  online: 'bg-emerald-100 text-emerald-700',
  failed: 'bg-red-100 text-red-700',
  busy: 'bg-red-100 text-red-700',
  'no-answer': 'bg-orange-100 text-orange-700',
  opted_out: 'bg-slate-200 text-slate-500',
  offline: 'bg-slate-200 text-slate-500',
  deactivated: 'bg-slate-200 text-slate-500',
  cancelled: 'bg-slate-200 text-slate-500'
};

export default function StatusBadge({ status }) {
  const style = STYLES[status] || 'bg-slate-100 text-slate-600';
  return (
    <span className={`inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium ${style}`}>
      {status}
    </span>
  );
}
