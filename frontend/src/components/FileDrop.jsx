import { UploadCloud, FileCheck2 } from 'lucide-react';
import { useRef } from 'react';

export default function FileDrop({ label, accept, file, onChange }) {
  const inputRef = useRef(null);

  return (
    <div
      onClick={() => inputRef.current?.click()}
      onDragOver={(e) => e.preventDefault()}
      onDrop={(e) => {
        e.preventDefault();
        const dropped = e.dataTransfer.files?.[0];
        if (dropped) onChange(dropped);
      }}
      className="flex items-center gap-3 border-2 border-dashed border-slate-300 rounded-lg px-4 py-3 cursor-pointer hover:border-brand-500 hover:bg-brand-50 transition-colors"
    >
      {file ? <FileCheck2 className="w-5 h-5 text-emerald-600 shrink-0" /> : <UploadCloud className="w-5 h-5 text-slate-400 shrink-0" />}
      <div className="text-sm min-w-0">
        <div className="text-slate-700 truncate">{file ? file.name : label}</div>
        {!file && <div className="text-xs text-slate-400">Click or drag a file here</div>}
      </div>
      <input
        ref={inputRef}
        type="file"
        accept={accept}
        className="hidden"
        onChange={(e) => e.target.files?.[0] && onChange(e.target.files[0])}
      />
    </div>
  );
}
