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
      className="flex cursor-pointer items-center gap-3 rounded-xl border-2 border-dashed border-line-strong px-4 py-3 transition-colors hover:border-brand-500 hover:bg-brand-50 dark:border-abyss-300/50 dark:hover:border-brand-400/60 dark:hover:bg-brand-500/5"
    >
      {file
        ? <FileCheck2 className="h-5 w-5 shrink-0 text-brand-500" />
        : <UploadCloud className="h-5 w-5 shrink-0 text-ink-400" />}
      <div className="min-w-0 text-[12px]">
        <div className="truncate text-ink-700 dark:text-slate-200">{file ? file.name : label}</div>
        {!file && <div className="text-[10px] text-ink-400 dark:text-abyss-100">Click or drag a file here</div>}
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
