// `columns`: [{ key, label, render?: (row) => node }]. `rowKey` defaults to row.id.
export default function DataTable({ columns, rows, rowKey = (r) => r.id, emptyMessage = 'Nothing here yet.' }) {
  if (!rows || rows.length === 0) {
    return <div className="text-sm text-slate-500 dark:text-abyss-50 py-8 text-center border border-dashed border-brand-200 dark:border-neon-cyan/20 rounded-xl bg-white/60 dark:bg-abyss-500/40">{emptyMessage}</div>;
  }
  return (
    <div className="overflow-x-auto border border-brand-100 dark:border-neon-cyan/15 rounded-xl bg-white dark:bg-abyss-500/60 dark:backdrop-blur">
      <table className="min-w-full text-sm">
        <thead className="bg-brand-50 dark:bg-abyss-400/60 text-brand-800 dark:text-neon-cyan text-xs uppercase tracking-wide">
          <tr>
            {columns.map((col) => (
              <th key={col.key} className="text-left px-4 py-2 font-medium">{col.label}</th>
            ))}
          </tr>
        </thead>
        <tbody className="divide-y divide-brand-50 dark:divide-abyss-300/30 dark:text-slate-200">
          {rows.map((row) => (
            <tr key={rowKey(row)} className="hover:bg-brand-50/60 dark:hover:bg-neon-cyan/5">
              {columns.map((col) => (
                <td key={col.key} className="px-4 py-2.5 align-middle">
                  {col.render ? col.render(row) : row[col.key]}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
