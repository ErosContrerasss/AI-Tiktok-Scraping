import type { QueryYield } from "@/lib/suggestions";

export function QueryYieldTable({ rows }: { rows: QueryYield[] }) {
  if (!rows.length) return null;
  return (
    <details className="rounded-lg border border-zinc-200 bg-white p-4 text-sm">
      <summary className="cursor-pointer font-medium">Opbrengst per zoekopdracht</summary>
      <p className="mt-1 text-xs text-zinc-500">
        Footage = relevant. Zoektermen met veel resultaten maar weinig footage kun je schrappen (artist card → extra
        zoekopdrachten / songs / collaborators, of via SEARCH_MODIFIERS).
      </p>
      <table className="mt-2 w-full max-w-2xl text-xs">
        <thead className="text-zinc-500">
          <tr>
            <th className="text-left font-normal">bron</th>
            <th className="text-left font-normal">query</th>
            <th className="text-right font-normal">footage</th>
            <th className="text-right font-normal">review</th>
            <th className="text-right font-normal">totaal</th>
            <th className="text-right font-normal">footage %</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.type + r.query} className="border-t border-zinc-100">
              <td className="py-0.5 text-zinc-500">{r.type}</td>
              <td>{r.query}</td>
              <td className="text-right">{r.footage}</td>
              <td className="text-right">{r.review}</td>
              <td className="text-right">{r.total}</td>
              <td className="text-right">{Math.round((r.footage / r.total) * 100)}%</td>
            </tr>
          ))}
        </tbody>
      </table>
    </details>
  );
}
