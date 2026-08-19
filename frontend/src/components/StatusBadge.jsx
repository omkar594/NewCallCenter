// Pill tones follow the mockup's outcome palette exactly (see ReportsWorkspace's statusStyles):
// teal for good outcomes, amber for "needs attention", coral for hard failures, a warm grey for
// no-answer, slate for inert states and a muted blue for anything still in flight.
const TONES = {
  teal: 'bg-[#e2f3ee] text-[#14776d] dark:bg-brand-500/15 dark:text-neon-cyan',
  amber: 'bg-[#fff1d5] text-[#986514] dark:bg-gold-400/15 dark:text-gold-200',
  coral: 'bg-[#ffebe5] text-[#b34838] dark:bg-coral-400/15 dark:text-coral-200',
  sand: 'bg-[#f2eee5] text-[#786d58] dark:bg-abyss-300/40 dark:text-abyss-50',
  slate: 'bg-[#edf1f0] text-[#60726f] dark:bg-abyss-300/40 dark:text-abyss-50',
  blue: 'bg-[#e7effb] text-[#4c6e99] dark:bg-neon-purple/15 dark:text-neon-purple'
};

const STATUS_TONE = {
  answered: 'teal',
  completed: 'teal',
  active: 'teal',
  idle: 'teal',
  online: 'teal',
  running: 'teal',
  processing: 'blue',
  preparing: 'amber',
  paused: 'amber',
  busy: 'amber',
  failed: 'coral',
  'no-answer': 'sand',
  pending: 'slate',
  opted_out: 'slate',
  offline: 'slate',
  deactivated: 'slate',
  cancelled: 'slate'
};

export default function StatusBadge({ status }) {
  const tone = TONES[STATUS_TONE[status]] || TONES.slate;
  return (
    <span className={`inline-flex items-center rounded-full px-2 py-1 text-[10px] font-bold capitalize ${tone}`}>
      {status}
    </span>
  );
}
