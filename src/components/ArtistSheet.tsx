"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

type Entry = { slot: string; path: string; source: string; url: string };

const SLOTS: { slot: string; label: string }[] = [
  { slot: "front", label: "Close-up frontaal" },
  { slot: "side", label: "Schuin / profiel" },
  { slot: "sunglasses", label: "Zonnebril" },
  { slot: "headwear", label: "Pet / capuchon" },
  { slot: "stage", label: "Podium" },
  { slot: "everyday", label: "Dagelijks" },
];

export function ArtistSheet({ artistId, entries, traits }: { artistId: string; entries: Entry[]; traits: string }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  async function call(method: "POST" | "DELETE", body?: object) {
    setBusy(true);
    setMessage(null);
    const res = await fetch(`/api/artists/${artistId}/sheet`, {
      method,
      headers: { "content-type": "application/json" },
      body: body ? JSON.stringify(body) : undefined,
    });
    const json = await res.json();
    setBusy(false);
    if (!res.ok) setMessage(json.error ?? "Mislukt");
    else if (method === "POST")
      setMessage(
        `${json.entries.length} foto's gekozen uit ${json.candidates} kandidaten (${Object.entries(json.sources)
          .map(([s, n]) => `${s} ${n}`)
          .join(", ")}) · ${json.credits} credits`,
      );
    router.refresh();
  }

  return (
    <section className="rounded-lg border border-zinc-200 bg-white p-4 text-sm">
      <div className="flex flex-wrap items-center gap-3">
        <h3 className="font-medium">Artist sheet</h3>
        <button onClick={() => call("POST")} disabled={busy} className="rounded-md border border-zinc-300 px-2 py-1 text-xs disabled:opacity-50">
          {busy ? "Bezig… (±1 min)" : entries.length ? "Opnieuw opbouwen" : "Opbouwen"}
        </button>
        {message && <span className="text-xs text-zinc-600">{message}</span>}
      </div>
      <p className="mt-1 text-xs text-zinc-500">
        Foto&apos;s van de artiest uit TikTok, Instagram, Apple Music en Spotify. De frames-check vergelijkt elke video hiermee.
        Verwijder foto&apos;s waarop iemand anders staat.
      </p>
      <div className="mt-3 grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
        {SLOTS.map(({ slot, label }) => {
          const items = entries.filter((e) => e.slot === slot);
          return (
            <div key={slot}>
              <div className="mb-1 text-xs font-medium text-zinc-600">{label}</div>
              <div className="flex flex-wrap gap-1">
                {items.map((e) => (
                  <div key={e.path} className="relative">
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img src={e.url} alt="" title={e.source} className="h-24 w-auto rounded border border-zinc-200 object-cover" />
                    <button
                      onClick={() => call("DELETE", { path: e.path })}
                      disabled={busy}
                      title="Verwijderen"
                      className="absolute right-1 top-1 rounded bg-black/60 px-1.5 text-xs text-white"
                    >
                      ✕
                    </button>
                  </div>
                ))}
                {!items.length && <div className="flex h-24 w-16 items-center justify-center rounded border border-dashed border-zinc-300 text-xs text-zinc-400">—</div>}
              </div>
            </div>
          );
        })}
      </div>
      {traits && <p className="mt-3 whitespace-pre-line text-xs text-zinc-600">{traits}</p>}
    </section>
  );
}
