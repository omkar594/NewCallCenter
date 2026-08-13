// `columns`: [{ key, label, render?: (row) => node }]. `rowKey` defaults to row.id.
export default function DataTable({ columns, rows, rowKey = (r) => r.id, emptyMessage = 'Nothing here yet.' }) {
  if (!rows || rows.length === 0) {
    return <div className="text-sm text-slate-500 py-8 text-center border border-dashed border-brand-200 rounded-xl bg-white/60">{emptyMessage}</div>;
  }
  return (
    <div className="overflow-x-auto border border-brand-100 rounded-xl bg-white">
      <table className="min-w-full text-sm">
        <thead className="bg-brand-50 text-brand-800 text-xs uppercase tracking-wide">
          <tr>
            {columns.map((col) => (
              <th key={col.key} className="text-left px-4 py-2 font-medium">{col.label}</th>
            ))}
          </tr>
        </thead>
        <tbody className="divide-y divide-brand-50">
          {rows.map((row) => (
            <tr key={rowKey(row)} className="hover:bg-brand-50/60">
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
