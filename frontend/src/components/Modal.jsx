import { X } from 'lucide-react';

export default function Modal({ title, onClose, children, width = 'max-w-lg' }) {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-ink-900/40 p-4">
      <div className={`w-full ${width} bg-white rounded-2xl shadow-xl`}>
        <div className="flex items-center justify-between px-5 py-4 border-b border-brand-100">
          <h2 className="font-semibold text-ink-900">{title}</h2>
          <button onClick={onClose} className="text-slate-400 hover:text-slate-600">
            <X className="w-5 h-5" />
          </button>
        </div>
        <div className="p-5 max-h-[75vh] overflow-y-auto">{children}</div>
      </div>
    </div>
  );
}
