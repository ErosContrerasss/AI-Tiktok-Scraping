"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import type { Blueprint, PlaybookStats } from "@/lib/playbook";

export type PlaybookView = {
  format: string;
  blueprint: Blueprint;
  created_at: string;
  examples: { id: string; url: string | null; author: string | null; reason: string | null }[];
};

const LABELS: Record<string, string> = {
  lyric_video: "Lyricvideo",
  fan_edit: "Fan edit",
  live_clip: "Live clip",
  behind_the_scenes: "Behind the scenes",
  interview_clip: "Interview",
  meme_or_skit: "Meme / sketch",
  dance_or_trend: "Dans / trend",
  slideshow: "Slideshow",
};

export function PlaybookPanel({ artistId, playbooks }: { artistId: string; playbooks: PlaybookView[] }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  async function build() {
    setBusy(true);
    setMessage("Uitschieters analyseren… (±10 s per video)");
    const res = await fetch(`/api/artists/${artistId}/playbook`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
    const json = await res.json();
    setBusy(false);
    if (!res.ok) return setMessage(json.error ?? `HTTP ${res.status}`);
    const s = json as PlaybookStats;
    setMessage(
      `${s.outliers} uitschieters, ${s.analysed} nieuw geanalyseerd${s.failed ? `, ${s.failed} mislukt` : ""}` +
        ` · blauwdrukken: ${s.blueprints.map((f) => LABELS[f] ?? f).join(", ") || "geen (te weinig voorbeelden per format)"}`,
    );
    router.refresh();
  }

  async function reject(videoId: string) {
    if (!confirm("Deze video toont de artiest niet? Hij gaat naar unrelated en telt niet meer mee in de blauwdruk.")) return;
    await fetch(`/api/videos/${videoId}/vote`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ up: false }) });
    router.refresh();
  }

  return (
    <section className="space-y-3 rounded-lg border border-zinc-200 bg-white p-4">
      <div className="flex flex-wrap items-center gap-3">
        <h2 className="font-medium">Playbook</h2>
        <span className="text-xs text-zinc-500">
          Uitschieters (top 10% op views per volger of engagement) per format ontleed tot een blauwdruk voor nieuwe video&apos;s
        </span>
        <button onClick={build} disabled={busy} className="ml-auto rounded-md border border-zinc-300 px-3 py-1.5 text-sm disabled:opacity-50">
          {playbooks.length ? "Bijwerken" : "Playbook bouwen"}
        </button>
      </div>
      {message && <p className="text-sm text-zinc-600">{message}</p>}
      {playbooks.map((p) => (
        <details key={p.format} className="rounded-md border border-zinc-200 p-3 text-sm">
          <summary className="cursor-pointer">
            <span className="font-medium">{LABELS[p.format] ?? p.format}</span>
            <span className="text-zinc-500"> · {p.blueprint.length} · {p.examples.length} voorbeelden</span>
            <p className="mt-1 text-zinc-600">{p.blueprint.summary}</p>
          </summary>
          <div className="mt-3 grid gap-3 md:grid-cols-2">
            <Rules title="Hooks" items={p.blueprint.hooks} />
            <Rules title="Opbouw" items={p.blueprint.structure} />
            <Rules title="Montage" items={p.blueprint.editing} />
            <Rules title="Tekst in beeld" items={p.blueprint.text} />
            <Rules title="Audio" items={p.blueprint.audio} />
            <Rules title="Footage" items={p.blueprint.footage} />
            <Rules title="Wel" items={p.blueprint.dos} />
            <Rules title="Niet" items={p.blueprint.donts} />
            <Rules title="Variëren (geen duplicate content)" items={p.blueprint.variations} />
          </div>
          <h4 className="mt-3 text-xs font-medium text-zinc-500">Voorbeelden</h4>
          <ul className="mt-1 space-y-0.5 text-xs">
            {p.examples.map((e) => (
              <li key={e.id} className="flex gap-2">
                <a href={e.url ?? "#"} target="_blank" rel="noreferrer" className="hover:underline">
                  @{e.author}
                </a>
                <span className="text-zinc-500">{e.reason}</span>
                <button onClick={() => reject(e.id)} className="text-zinc-400 hover:text-red-600" title="Niet de artiest">
                  👎
                </button>
              </li>
            ))}
          </ul>
        </details>
      ))}
    </section>
  );
}

function Rules({ title, items }: { title: string; items: string[] }) {
  if (!items.length) return null;
  return (
    <div>
      <h4 className="text-xs font-medium text-zinc-500">{title}</h4>
      <ul className="mt-1 list-disc space-y-0.5 pl-4">
        {items.map((item, i) => (
          <li key={i}>{item}</li>
        ))}
      </ul>
    </div>
  );
}
