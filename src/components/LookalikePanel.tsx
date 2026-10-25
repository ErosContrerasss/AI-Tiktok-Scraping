"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

export type LookalikeView = {
  id: number;
  name: string;
  tiktok_handle: string | null;
  status: "active" | "rejected";
  photos: string[];
  reason: string | null;
  stats: { checked?: number; rejected?: number; framesRemoved?: number };
  blocked_accounts: string[];
};

// Look-alikes are found and handled automatically; this only shows what happened and lets the
// team undo a wrong one.
export function LookalikePanel({ lookalikes }: { lookalikes: LookalikeView[] }) {
  const router = useRouter();
  const [busy, setBusy] = useState<number | null>(null);
  const active = lookalikes.filter((l) => l.status === "active");
  if (!active.length) return null;

  async function reject(id: number) {
    if (!confirm("Is dit geen look-alike? De extra controles en blokkades worden teruggedraaid.")) return;
    setBusy(id);
    await fetch(`/api/lookalikes/${id}/reject`, { method: "POST" });
    setBusy(null);
    router.refresh();
  }

  return (
    <section className="space-y-2 rounded-lg border border-zinc-200 bg-white p-4 text-sm">
      <h2 className="font-medium">Automatisch herkende look-alikes</h2>
      <p className="text-xs text-zinc-500">
        Mensen die de beeldcontrole voor de artiest aanzag. Video&apos;s die hen noemen worden opnieuw gecontroleerd met beide sets
        foto&apos;s naast elkaar; hun eigen account en fanpagina&apos;s staan op de blokkeerlijst.
      </p>
      <ul className="space-y-2">
        {active.map((l) => (
          <li key={l.id} className="flex flex-wrap items-center gap-3">
            <div className="flex -space-x-2">
              {l.photos.slice(0, 4).map((src) => (
                // eslint-disable-next-line @next/next/no-img-element
                <img key={src} src={src} alt="" className="h-9 w-9 rounded-full border-2 border-white object-cover" />
              ))}
            </div>
            <div className="min-w-0 flex-1">
              <div className="font-medium">
                {l.name} {l.tiktok_handle && <span className="font-normal text-zinc-500">@{l.tiktok_handle}</span>}
              </div>
              <div className="text-xs text-zinc-600">
                {l.stats.checked ?? 0} video&apos;s opnieuw gecontroleerd · {l.stats.rejected ?? 0} afgekeurd ·{" "}
                {l.stats.framesRemoved ?? 0} frames zonder de artiest
                {l.blocked_accounts.length ? ` · geblokkeerd: ${l.blocked_accounts.map((a) => `@${a}`).join(", ")}` : ""}
              </div>
              {l.reason && <div className="text-xs text-zinc-500">{l.reason}</div>}
            </div>
            <button
              onClick={() => reject(l.id)}
              disabled={busy === l.id}
              className="rounded-md border border-zinc-300 px-2 py-1 text-xs disabled:opacity-50"
            >
              Dit is geen look-alike
            </button>
          </li>
        ))}
      </ul>
    </section>
  );
}
