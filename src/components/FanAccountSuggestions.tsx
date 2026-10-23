"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import type { FanAccountSuggestion } from "@/lib/suggestions";
import { formatCount } from "@/lib/util";

export function FanAccountSuggestions({ artistId, suggestions }: { artistId: string; suggestions: FanAccountSuggestion[] }) {
  const router = useRouter();
  const [added, setAdded] = useState<string[]>([]);
  if (!suggestions.length) return null;

  async function add(handle: string) {
    const res = await fetch(`/api/artists/${artistId}/fan-accounts`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ handle }),
    });
    if (res.ok) {
      setAdded((a) => [...a, handle]);
      router.refresh();
    }
  }

  return (
    <section className="rounded-lg border border-zinc-200 bg-white p-4 text-sm">
      <h3 className="font-medium">Accounts die vaak footage posten</h3>
      <p className="text-xs text-zinc-500">
        Toevoegen als fanaccount = bij de volgende ingest hun hele profiel ophalen (1 credit per pagina).
      </p>
      <ul className="mt-2 flex flex-wrap gap-2">
        {suggestions.map((s) => (
          <li key={s.handle} className="flex items-center gap-2 rounded-md border border-zinc-200 px-2 py-1">
            <a href={`https://www.tiktok.com/@${s.handle}`} target="_blank" rel="noreferrer" className="hover:underline">
              @{s.handle}
            </a>
            <span className="text-xs text-zinc-500">
              {s.footage} footage{s.review ? ` + ${s.review} review` : ""} · {formatCount(s.views)} views
            </span>
            <button
              onClick={() => add(s.handle)}
              disabled={added.includes(s.handle)}
              className="rounded bg-zinc-900 px-2 py-0.5 text-xs text-white disabled:bg-green-700"
            >
              {added.includes(s.handle) ? "toegevoegd" : "+ fanaccount"}
            </button>
          </li>
        ))}
      </ul>
    </section>
  );
}
