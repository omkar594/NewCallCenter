import { X } from 'lucide-react';

export default function Modal({ title, onClose, children, width = 'max-w-lg' }) {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-ink-900/40 dark:bg-black/70 p-4">
      <div className={`w-full ${width} bg-white dark:bg-abyss-500 dark:border dark:border-neon-cyan/15 rounded-2xl shadow-xl dark:shadow-neon-cyan/5`}>
        <div className="flex items-center justify-between px-5 py-4 border-b border-brand-100 dark:border-abyss-300/30">
          <h2 className="font-semibold text-ink-900 dark:text-slate-100">{title}</h2>
          <button onClick={onClose} className="text-slate-400 hover:text-slate-600 dark:hover:text-neon-cyan">
            <X className="w-5 h-5" />
          </button>
        </div>
        <div className="p-5 max-h-[75vh] overflow-y-auto dark:text-slate-200">{children}</div>
      </div>
    </div>
  );
}
