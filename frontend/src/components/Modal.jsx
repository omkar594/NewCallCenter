import { X } from 'lucide-react';

export default function Modal({ title, onClose, children, width = 'max-w-lg' }) {
  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center bg-deep/20 p-4 backdrop-blur-[2px] sm:items-center dark:bg-black/60">
      <div className={`w-full ${width} rounded-2xl border border-line bg-surface shadow-2xl dark:border-abyss-300/40 dark:bg-abyss-500`}>
        <div className="flex items-center justify-between border-b border-line px-5 py-4 dark:border-abyss-300/40">
          <h2 className="panel-title">{title}</h2>
          <button onClick={onClose} className="rounded-lg p-1 text-ink-400 hover:bg-ink-50 hover:text-ink-700 dark:hover:bg-abyss-400/50 dark:hover:text-white">
            <X className="h-4 w-4" />
          </button>
        </div>
        <div className="max-h-[75vh] overflow-y-auto p-5 text-[12px] text-ink-700 dark:text-slate-200">{children}</div>
      </div>
    </div>
  );
}
