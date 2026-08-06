// `columns`: [{ key, label, render?: (row) => node }]. `rowKey` defaults to row.id.
export default function DataTable({ columns, rows, rowKey = (r) => r.id, emptyMessage = 'Nothing here yet.' }) {
  if (!rows || rows.length === 0) {
    return <div className="text-sm text-slate-500 py-8 text-center border border-dashed border-slate-300 rounded-lg">{emptyMessage}</div>;
  }
  return (
    <div className="overflow-x-auto border border-slate-200 rounded-lg">
      <table className="min-w-full text-sm">
        <thead className="bg-slate-50 text-slate-500 text-xs uppercase tracking-wide">
          <tr>
            {columns.map((col) => (
              <th key={col.key} className="text-left px-4 py-2 font-medium">{col.label}</th>
            ))}
          </tr>
        </thead>
        <tbody className="divide-y divide-slate-100">
          {rows.map((row) => (
            <tr key={rowKey(row)} className="hover:bg-slate-50">
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
