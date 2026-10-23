"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import type { ClassifyStats } from "@/lib/classify";
import type { IngestStats } from "@/lib/ingest";

type Props = { artistId: string; lastIngest: IngestStats | null; defaultMaxPages: number; llmReady: boolean };

export function RunPanel({ artistId, lastIngest, defaultMaxPages, llmReady }: Props) {
  const router = useRouter();
  const [maxPages, setMaxPages] = useState(defaultMaxPages);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [ingest, setIngest] = useState<IngestStats | null>(lastIngest);
  const [classify, setClassify] = useState<ClassifyStats | null>(null);

  async function call<T>(path: string, body: object): Promise<T | null> {
    const res = await fetch(path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    const json = await res.json();
    if (!res.ok) {
      setError(json.error ?? `HTTP ${res.status}`);
      return null;
    }
    return json as T;
  }

  async function runIngest() {
    setError(null);
    setBusy("Ingest loopt… (kan een paar minuten duren)");
    const stats = await call<IngestStats>(`/api/artists/${artistId}/ingest`, { maxPages });
    if (stats) {
      setIngest(stats);
      await runClassify(false);
    }
    setBusy(null);
    router.refresh();
  }

  async function runClassify(force: boolean) {
    setError(null);
    setBusy("Classificeren…");
    const stats = await call<ClassifyStats>(`/api/artists/${artistId}/classify`, { force });
    if (stats) setClassify(stats);
    setBusy(null);
    router.refresh();
  }

  return (
    <section className="space-y-3 rounded-lg border border-zinc-200 bg-white p-4">
      <div className="flex flex-wrap items-center gap-3">
        <button onClick={runIngest} disabled={!!busy} className="rounded-md bg-zinc-900 px-3 py-2 text-sm text-white disabled:opacity-50">
          Ingest + classificeer
        </button>
        <label className="flex items-center gap-2 text-sm">
          max pagina&apos;s per query
          <input
            type="number"
            min={1}
            max={20}
            value={maxPages}
            onChange={(e) => setMaxPages(Number(e.target.value))}
            className="w-16 rounded-md border border-zinc-300 px-2 py-1"
          />
        </label>
        <button onClick={() => runClassify(false)} disabled={!!busy} className="rounded-md border border-zinc-300 px-3 py-2 text-sm disabled:opacity-50">
          Classificeer nieuwe
        </button>
        <button
          onClick={() => runClassify(true)}
          disabled={!!busy}
          title="Regels opnieuw toepassen en LLM opnieuw draaien (met de duimpjes als voorbeelden). Menselijke oordelen blijven staan."
          className="rounded-md border border-zinc-300 px-3 py-2 text-sm disabled:opacity-50"
        >
          Herclassificeer alles
        </button>
        {!llmReady && <span className="text-xs text-amber-700">Geen LLM-key: alleen regels draaien</span>}
        {busy && <span className="text-sm text-zinc-600">{busy}</span>}
      </div>
      {error && <p className="text-sm text-red-600">{error}</p>}
      {(ingest || classify) && (
        <div className="grid gap-4 text-sm md:grid-cols-2">
          {ingest && <IngestSummary s={ingest} />}
          {classify && <ClassifySummary s={classify} />}
        </div>
      )}
    </section>
  );
}

function IngestSummary({ s }: { s: IngestStats }) {
  const failed = s.tasks.filter((t) => t.error);
  return (
    <div>
      <h3 className="font-medium">Laatste ingest (run #{s.runId})</h3>
      <p className="text-zinc-600">
        {s.totalFound} gevonden → {s.unique} na ontdubbelen ({s.newVideos} nieuw) · {s.credits} credits · max {s.maxPages} pag.
      </p>
      <table className="mt-2 text-xs">
        <thead className="text-zinc-500">
          <tr>
            <th className="pr-4 text-left font-normal">bron</th>
            <th className="pr-4 text-right font-normal">gevonden</th>
            <th className="text-right font-normal">uniek</th>
          </tr>
        </thead>
        <tbody>
          {Object.entries(s.perSource).map(([type, v]) => (
            <tr key={type}>
              <td className="pr-4">{type}</td>
              <td className="pr-4 text-right">{v.found}</td>
              <td className="text-right">{v.unique}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <p className="mt-1 text-xs text-zinc-500">
        Thumbnails gecached: {s.thumbnails.cached}
        {s.thumbnails.failed ? `, mislukt: ${s.thumbnails.failed}` : ""}
      </p>
      {failed.length > 0 && (
        <ul className="mt-1 text-xs text-red-600">
          {failed.map((t) => (
            <li key={t.type + t.query}>
              {t.type} &quot;{t.query}&quot;: {t.error}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function ClassifySummary({ s }: { s: ClassifyStats }) {
  return (
    <div>
      <h3 className="font-medium">Classificatie</h3>
      <p className="text-zinc-600">
        Regels: {s.rules.relevant} relevant, {s.rules.unrelated} unrelated · LLM ({s.provider ?? "geen"}): {s.llm.classified} gedaan
        {s.llm.failed ? `, ${s.llm.failed} mislukt` : ""}
      </p>
      <p className="mt-1">
        <span className="text-green-700">{s.distribution.relevant} relevant</span> ·{" "}
        <span className="text-amber-700">{s.distribution.review} review</span> ·{" "}
        <span className="text-zinc-500">{s.distribution.unrelated} unrelated</span>
        {s.distribution.unclassified ? ` · ${s.distribution.unclassified} ongeclassificeerd` : ""}
      </p>
      <p className="mt-1 text-xs text-zinc-500">
        {Object.entries(s.byContentType)
          .sort((a, b) => b[1] - a[1])
          .map(([t, n]) => `${t} ${n}`)
          .join(" · ")}
      </p>
      {s.llm.errors.length > 0 && <p className="mt-1 text-xs text-red-600">{s.llm.errors[0]}</p>}
    </div>
  );
}
