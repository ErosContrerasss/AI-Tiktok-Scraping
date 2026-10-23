"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

type Ref = { path: string; url: string };

export function ReferencePhotos({ artistId, references }: { artistId: string; references: Ref[] }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function call(method: "POST" | "DELETE", body?: object) {
    setBusy(true);
    setError(null);
    const res = await fetch(`/api/artists/${artistId}/references`, {
      method,
      headers: { "content-type": "application/json" },
      body: body ? JSON.stringify(body) : undefined,
    });
    const json = await res.json();
    setBusy(false);
    if (!res.ok) setError(json.error ?? "Mislukt");
    router.refresh();
  }

  return (
    <section className="rounded-lg border border-zinc-200 bg-white p-4 text-sm">
      <div className="flex items-center gap-3">
        <h3 className="font-medium">Referentiefoto&apos;s</h3>
        <button
          onClick={() => call("POST")}
          disabled={busy}
          className="rounded-md border border-zinc-300 px-2 py-1 text-xs disabled:opacity-50"
        >
          {busy ? "Bezig…" : references.length ? "Opnieuw bepalen" : "Automatisch bepalen"}
        </button>
        {error && <span className="text-xs text-red-600">{error}</span>}
      </div>
      <p className="mt-1 text-xs text-zinc-500">
        De visuele check vergelijkt de frames van elke video met deze foto&apos;s. Profielfoto + covers van eigen posts
        waarop dezelfde persoon staat. Verwijder foto&apos;s waarop iemand anders staat.
      </p>
      <div className="mt-2 flex flex-wrap gap-2">
        {references.map((r) => (
          <div key={r.path} className="relative">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src={r.url} alt="" className="h-28 w-auto rounded border border-zinc-200 object-cover" />
            <button
              onClick={() => call("DELETE", { path: r.path })}
              disabled={busy}
              title="Verwijderen"
              className="absolute right-1 top-1 rounded bg-black/60 px-1.5 text-xs text-white"
            >
              ✕
            </button>
          </div>
        ))}
        {!references.length && <span className="text-xs text-zinc-500">Nog geen referenties.</span>}
      </div>
    </section>
  );
}
