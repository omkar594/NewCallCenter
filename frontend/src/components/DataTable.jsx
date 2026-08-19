// `columns`: [{ key, label, render?: (row) => node }]. `rowKey` defaults to row.id.
// Table chrome matches the mockup's: a tinted 10px uppercase header strip, hairline row rules and
// 11px row text inside a rounded-xl frame.
export default function DataTable({ columns, rows, rowKey = (r) => r.id, emptyMessage = 'Nothing here yet.' }) {
  if (!rows || rows.length === 0) {
    return (
      <div className="rounded-xl border border-dashed border-line-strong bg-surface py-8 text-center text-[11px] text-ink-400 dark:border-abyss-300/40 dark:bg-abyss-500/50 dark:text-abyss-100">
        {emptyMessage}
      </div>
    );
  }
  return (
    <div className="overflow-x-auto rounded-xl border border-line bg-surface dark:border-abyss-300/40 dark:bg-abyss-500">
      <table className="min-w-full">
        <thead className="bg-ink-50 text-ink-400 dark:bg-abyss-400/50 dark:text-abyss-100">
          <tr>
            {columns.map((col) => (
              <th
                key={col.key}
                className="px-3 py-2 text-left text-[10px] font-bold uppercase tracking-wider"
              >
                {col.label}
              </th>
            ))}
          </tr>
        </thead>
        <tbody className="text-[11px] text-ink-700 dark:text-slate-200">
          {rows.map((row) => (
            <tr
              key={rowKey(row)}
              className="border-t border-line/70 hover:bg-brand-50/60 dark:border-abyss-300/30 dark:hover:bg-brand-500/5"
            >
              {columns.map((col) => (
                <td key={col.key} className="px-3 py-3 align-middle">
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
