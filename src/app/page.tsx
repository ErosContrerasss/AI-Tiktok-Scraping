import Link from "next/link";
import { listArtists } from "@/lib/artists";

export const dynamic = "force-dynamic";

export default async function Home() {
  const artists = await listArtists();
  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h1 className="text-xl font-semibold">Artiesten</h1>
        <Link href="/artists/new" className="rounded-md bg-zinc-900 px-3 py-2 text-sm text-white hover:bg-zinc-700">
          + Nieuwe artiest
        </Link>
      </div>
      {artists.length === 0 ? (
        <p className="text-sm text-zinc-500">Nog geen artiesten. Maak er een aan met een artist card.</p>
      ) : (
        <ul className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {artists.map((a) => (
            <li key={a.id}>
              <Link href={`/artists/${a.id}`} className="block rounded-lg border border-zinc-200 bg-white p-4 hover:border-zinc-400">
                <div className="font-medium">{a.name}</div>
                <div className="mt-1 text-xs text-zinc-500">
                  {[...a.handles.map((h) => "@" + h), ...a.aliases].join(" · ") || "—"}
                </div>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
