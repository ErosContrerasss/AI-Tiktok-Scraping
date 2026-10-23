"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import type { Artist } from "@/lib/types";

const FIELDS: { key: keyof Artist; label: string; hint: string }[] = [
  { key: "aliases", label: "Aliassen", hint: "Andere schrijfwijzen of namen, één per regel" },
  { key: "handles", label: "Eigen TikTok-accounts", hint: "Zonder @, bv. russo" },
  { key: "hashtags", label: "Hashtags", hint: "Zonder #. Leeg = afgeleid van naam + aliassen" },
  { key: "song_titles", label: "Songtitels", hint: "Gezocht als \"titel + artiestnaam\"" },
  { key: "sound_ids", label: "Sound IDs", hint: "TikTok music clip id's (uit tiktok.com/music/…-ID)" },
  { key: "collaborators", label: "Collaborators", hint: "Artiesten/producers waarmee samengewerkt is" },
  { key: "negative_terms", label: "Negatieve termen", hint: "Bevat de video dit → unrelated" },
  { key: "blocked_accounts", label: "Geblokkeerde accounts", hint: "Zonder @, altijd unrelated" },
];

export function ArtistForm({ artist }: { artist?: Artist }) {
  const router = useRouter();
  const [name, setName] = useState(artist?.name ?? "");
  const [values, setValues] = useState<Record<string, string>>(
    Object.fromEntries(FIELDS.map((f) => [f.key, ((artist?.[f.key] as string[]) ?? []).join("\n")])),
  );
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setSaving(true);
    setMessage(null);
    const res = await fetch(artist ? `/api/artists/${artist.id}` : "/api/artists", {
      method: artist ? "PUT" : "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name, ...values }),
    });
    const body = await res.json();
    setSaving(false);
    if (!res.ok) return setMessage(body.error ?? "Opslaan mislukt");
    if (artist) {
      setMessage("Opgeslagen");
      router.refresh();
    } else router.push(`/artists/${body.id}`);
  }

  return (
    <form onSubmit={submit} className="space-y-4 rounded-lg border border-zinc-200 bg-white p-4">
      <label className="block">
        <span className="text-sm font-medium">Naam</span>
        <input
          required
          value={name}
          onChange={(e) => setName(e.target.value)}
          className="mt-1 w-full rounded-md border border-zinc-300 px-3 py-2 text-sm"
        />
      </label>
      <div className="grid gap-4 sm:grid-cols-2">
        {FIELDS.map((f) => (
          <label key={f.key} className="block">
            <span className="text-sm font-medium">{f.label}</span>
            <span className="block text-xs text-zinc-500">{f.hint}</span>
            <textarea
              rows={3}
              value={values[f.key]}
              onChange={(e) => setValues((v) => ({ ...v, [f.key]: e.target.value }))}
              className="mt-1 w-full rounded-md border border-zinc-300 px-3 py-2 font-mono text-xs"
            />
          </label>
        ))}
      </div>
      <div className="flex items-center gap-3">
        <button disabled={saving} className="rounded-md bg-zinc-900 px-3 py-2 text-sm text-white disabled:opacity-50">
          {saving ? "Opslaan…" : artist ? "Artist card opslaan" : "Artiest aanmaken"}
        </button>
        {message && <span className="text-sm text-zinc-600">{message}</span>}
      </div>
    </form>
  );
}
