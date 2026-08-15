const STYLES = {
  pending: 'bg-slate-100 text-slate-600 dark:bg-abyss-300/30 dark:text-abyss-50',
  preparing: 'bg-amber-100 text-amber-700 dark:bg-amber-400/10 dark:text-amber-300',
  running: 'bg-blue-100 text-blue-700 dark:bg-neon-cyan/10 dark:text-neon-cyan',
  paused: 'bg-yellow-100 text-yellow-700 dark:bg-amber-400/10 dark:text-amber-300',
  processing: 'bg-indigo-100 text-indigo-700 dark:bg-neon-purple/10 dark:text-neon-purple',
  answered: 'bg-emerald-100 text-emerald-700 dark:bg-neon-green/10 dark:text-neon-green',
  completed: 'bg-emerald-100 text-emerald-700 dark:bg-neon-green/10 dark:text-neon-green',
  active: 'bg-emerald-100 text-emerald-700 dark:bg-neon-green/10 dark:text-neon-green',
  idle: 'bg-emerald-100 text-emerald-700 dark:bg-neon-green/10 dark:text-neon-green',
  online: 'bg-emerald-100 text-emerald-700 dark:bg-neon-green/10 dark:text-neon-green',
  failed: 'bg-red-100 text-red-700 dark:bg-red-400/10 dark:text-red-300',
  busy: 'bg-red-100 text-red-700 dark:bg-red-400/10 dark:text-red-300',
  'no-answer': 'bg-orange-100 text-orange-700 dark:bg-orange-400/10 dark:text-orange-300',
  opted_out: 'bg-slate-200 text-slate-500 dark:bg-abyss-300/30 dark:text-abyss-50',
  offline: 'bg-slate-200 text-slate-500 dark:bg-abyss-300/30 dark:text-abyss-50',
  deactivated: 'bg-slate-200 text-slate-500 dark:bg-abyss-300/30 dark:text-abyss-50',
  cancelled: 'bg-slate-200 text-slate-500 dark:bg-abyss-300/30 dark:text-abyss-50'
};

export default function StatusBadge({ status }) {
  const style = STYLES[status] || 'bg-slate-100 text-slate-600 dark:bg-abyss-300/30 dark:text-abyss-50';
  return (
    <span className={`inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium ${style}`}>
      {status}
    </span>
  );
}
