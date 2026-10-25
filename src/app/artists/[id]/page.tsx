import Link from "next/link";
import { notFound } from "next/navigation";
import { ArtistForm } from "@/components/ArtistForm";
import { FanAccountSuggestions } from "@/components/FanAccountSuggestions";
import { QueryYieldTable } from "@/components/QueryYieldTable";
import { ArtistSheet } from "@/components/ArtistSheet";
import { LookalikePanel } from "@/components/LookalikePanel";
import { PlaybookPanel } from "@/components/PlaybookPanel";
import { RunPanel } from "@/components/RunPanel";
import { VideoGrid, type GridVideo } from "@/components/VideoGrid";
import { getArtist } from "@/lib/artists";
import { llmProvider } from "@/lib/classify/llm";
import { config } from "@/lib/env";
import type { IngestStats } from "@/lib/ingest";
import { listLookalikes } from "@/lib/lookalikes";
import { loadPlaybookView } from "@/lib/playbook";
import { queryYield, suggestFanAccounts } from "@/lib/suggestions";
import { BUCKETS, media, publicThumbUrl } from "@/lib/media";
import { db } from "@/lib/supabase";
import { CONTENT_TYPES, STATUSES, type Status, type VideoStatusRow } from "@/lib/types";

export const dynamic = "force-dynamic";

const PAGE_SIZE = 120;
const SORTS = {
  views: { column: "views", label: "Views" },
  likes: { column: "likes", label: "Likes" },
  posted_at: { column: "posted_at", label: "Nieuwste" },
  relevance: { column: "relevance", label: "Confidence" },
  usable_seconds: { column: "usable_seconds", label: "Meeste bruikbare seconden" },
} as const;

type Search = { status?: string; type?: string; from?: string; to?: string; sort?: string; page?: string; clean?: string };

export default async function ArtistPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<Search>;
}) {
  const { id } = await params;
  const sp = await searchParams;
  const artist = await getArtist(id);
  if (!artist) notFound();

  const status = (STATUSES as readonly string[]).includes(sp.status ?? "") ? (sp.status as Status) : "relevant";
  // "Schone fragmenten": usable videos with stretches of the artist on screen without overlaid text.
  const clean = status === "relevant" && sp.clean === "1";
  const sortKey = (sp.sort && sp.sort in SORTS && (clean || sp.sort !== "usable_seconds") ? sp.sort : "views") as keyof typeof SORTS;
  const page = Math.max(1, Number(sp.page ?? 1));
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- Supabase builder generics differ per select()
  const applyFilters = (q: any) => {
    if (sp.type) q = q.eq("content_type", sp.type);
    if (sp.from) q = q.gte("posted_at", sp.from);
    if (sp.to) q = q.lte("posted_at", `${sp.to}T23:59:59Z`);
    return q;
  };

  const supabase = db();
  const query = applyFilters(
    supabase
    .from(clean ? "video_library" : "video_status")
    .select("*", { count: "exact" })
    .eq("artist_id", id)
    .eq("status", status)
    .order(SORTS[sortKey].column, { ascending: false, nullsFirst: false })
    .range((page - 1) * PAGE_SIZE, page * PAGE_SIZE - 1),
  );

  const [{ data: rows, count }, counts, { data: lastRun }, suggestions, yields, sheet, playbooks, lookalikeRows] = await Promise.all([
    query,
    Promise.all(
      STATUSES.map(async (st) => {
        const { count: n } = await applyFilters(
          supabase.from("video_status").select("id", { count: "exact", head: true }).eq("artist_id", id).eq("status", st),
        );
        return [st, n ?? 0] as const;
      }),
    ).then((entries) => Object.fromEntries(entries) as Record<Status, number>),
    supabase.from("ingest_runs").select("stats").eq("artist_id", id).not("finished_at", "is", null)
      .order("started_at", { ascending: false }).limit(1).maybeSingle(),
    suggestFanAccounts(artist),
    queryYield(id),
    Promise.all(
      artist.artist_sheet.map(async (entry) => {
        const url = await media().signedUrl(BUCKETS.sheets, entry.path, 3600);
        return { ...entry, url: url ?? "" };
      }),
    ),
    loadPlaybookView(id),
    listLookalikes(id),
  ]);
  const lookalikes = await Promise.all(
    lookalikeRows.map(async (l) => ({
      id: l.id,
      name: l.name,
      tiktok_handle: l.tiktok_handle,
      status: l.status,
      reason: l.evidence.reason ?? null,
      stats: l.stats,
      blocked_accounts: l.blocked_accounts,
      photos: (await Promise.all(l.sheet.slice(0, 4).map((e) => media().signedUrl(BUCKETS.sheets, e.path, 3600)))).filter((u): u is string => !!u),
    })),
  );

  const { data: segmentRows } = rows?.length
    ? await supabase.from("video_segments").select("video_id, segments, clean_seconds, aspect, crop, crop_kind, refined_at, quality, effective_height").in("video_id", (rows as { id: string }[]).map((r) => r.id))
    : { data: [] };
  const segmentsOf = new Map((segmentRows ?? []).map((s) => [s.video_id, s]));
  const videos: GridVideo[] = ((rows ?? []) as VideoStatusRow[]).map((v) => ({
    ...v,
    thumb: publicThumbUrl(v.thumbnail_cached_path) ?? v.thumbnail_url,
    clean: segmentsOf.get(v.id) ?? null,
  }));
  const href = (patch: Partial<Search>) => {
    const next = new URLSearchParams(
      Object.entries({ ...sp, page: undefined, ...patch }).filter(([, v]) => v) as [string, string][],
    );
    return `/artists/${id}?${next}`;
  };
  const totalPages = Math.ceil((count ?? 0) / PAGE_SIZE);

  return (
    <div className="space-y-5">
      <div className="flex items-baseline gap-3">
        <Link href="/" className="text-sm text-zinc-500 hover:underline">
          ← artiesten
        </Link>
        <h1 className="text-xl font-semibold">{artist.name}</h1>
      </div>

      <details className="group">
        <summary className="cursor-pointer text-sm text-zinc-600">Artist card bewerken</summary>
        <div className="mt-3">
          <ArtistForm artist={artist} />
        </div>
      </details>

      <RunPanel
        artistId={id}
        lastIngest={(lastRun?.stats as IngestStats) ?? null}
        defaultMaxPages={config.maxPages}
        llmReady={!!llmProvider()}
      />

      <ArtistSheet artistId={id} entries={sheet} traits={artist.traits} />
      <LookalikePanel lookalikes={lookalikes} />
      <PlaybookPanel artistId={id} playbooks={playbooks} />
      <FanAccountSuggestions artistId={id} suggestions={suggestions} />
      <QueryYieldTable rows={yields} />

      <div className="flex flex-wrap items-center gap-2 text-sm">
        {STATUSES.map((s) => (
          <Link
            key={s}
            href={href({ status: s })}
            className={`rounded-full border px-3 py-1 ${s === status ? "border-zinc-900 bg-zinc-900 text-white" : "border-zinc-300 bg-white"}`}
          >
            {s} <span className="opacity-60">{counts[s]}</span>
          </Link>
        ))}
      </div>

      <form className="flex flex-wrap items-end gap-3 text-sm" action={`/artists/${id}`}>
        <input type="hidden" name="status" value={status} />
        <label className="flex flex-col">
          <span className="text-xs text-zinc-500">content type</span>
          <select name="type" defaultValue={sp.type ?? ""} className="rounded-md border border-zinc-300 bg-white px-2 py-1">
            <option value="">alle</option>
            {CONTENT_TYPES.map((t) => (
              <option key={t}>{t}</option>
            ))}
          </select>
        </label>
        <label className="flex flex-col">
          <span className="text-xs text-zinc-500">van</span>
          <input type="date" name="from" defaultValue={sp.from} className="rounded-md border border-zinc-300 bg-white px-2 py-1" />
        </label>
        <label className="flex flex-col">
          <span className="text-xs text-zinc-500">tot</span>
          <input type="date" name="to" defaultValue={sp.to} className="rounded-md border border-zinc-300 bg-white px-2 py-1" />
        </label>
        <label className="flex flex-col">
          <span className="text-xs text-zinc-500">sorteer op</span>
          <select name="sort" defaultValue={sortKey} className="rounded-md border border-zinc-300 bg-white px-2 py-1">
            {Object.entries(SORTS).map(([k, s]) => (
              <option key={k} value={k}>
                {s.label}
              </option>
            ))}
          </select>
        </label>
        {status === "relevant" && (
          <label className="flex items-center gap-1.5 self-center" title="Alleen video's met stukken waarin de artiest in beeld is zonder tekst of overlays (een klein watermerk in een hoek mag)">
            <input type="checkbox" name="clean" value="1" defaultChecked={clean} />
            alleen schone fragmenten
          </label>
        )}
        <button className="rounded-md border border-zinc-300 bg-white px-3 py-1">Filter</button>
        <span className="text-zinc-500">{count ?? 0} video&apos;s</span>
      </form>

      {videos.length ? <VideoGrid videos={videos} /> : <p className="text-sm text-zinc-500">Geen video&apos;s in deze selectie.</p>}

      {totalPages > 1 && (
        <div className="flex gap-3 text-sm">
          {page > 1 && <Link href={href({ page: String(page - 1) })}>← vorige</Link>}
          <span className="text-zinc-500">
            pagina {page} / {totalPages}
          </span>
          {page < totalPages && <Link href={href({ page: String(page + 1) })}>volgende →</Link>}
        </div>
      )}
    </div>
  );
}
