"use client";

import { useState } from "react";
import type { CardDraft } from "@/lib/bootstrap";
import { ArtistForm } from "./ArtistForm";

export function NewArtist() {
  const [handle, setHandle] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [draft, setDraft] = useState<CardDraft | null>(null);

  async function propose(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    const res = await fetch("/api/artists/propose", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ handle }),
    });
    const body = await res.json();
    setBusy(false);
    if (!res.ok) return setError(body.error ?? "Voorstel mislukt");
    setDraft(body);
  }

  return (
    <div className="space-y-4">
      <form onSubmit={propose} className="space-y-2 rounded-lg border border-zinc-200 bg-white p-4">
        <label className="block text-sm font-medium">TikTok-account van de artiest</label>
        <div className="flex gap-2">
          <input
            value={handle}
            onChange={(e) => setHandle(e.target.value)}
            placeholder="@handle of https://www.tiktok.com/@handle"
            className="flex-1 rounded-md border border-zinc-300 px-3 py-2 text-sm"
          />
          <button disabled={busy || !handle} className="rounded-md bg-zinc-900 px-3 py-2 text-sm text-white disabled:opacity-50">
            {busy ? "Bezig… (±30s)" : "Card voorstellen"}
          </button>
        </div>
        <p className="text-xs text-zinc-500">
          Haalt profiel, eigen posts en één zoekpagina op (±5 credits) en laat de AI de artist card invullen. Controleer en pas aan
          voordat je opslaat.
        </p>
        {error && <p className="text-sm text-red-600">{error}</p>}
        {draft && <p className="text-sm text-green-700">Voorstel ingevuld ({draft.credits} credits). Controleer de velden hieronder.</p>}
      </form>
      <ArtistForm key={draft ? "draft" : "empty"} initial={draft ?? undefined} />
    </div>
  );
}
