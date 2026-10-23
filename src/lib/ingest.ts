import "server-only";
import { config } from "./env";
import { normalizeVideo, type NormalizedVideo } from "./normalize";
import { socialFetch, type DatePosted, type SfListResponse } from "./socialfetch";
import { db } from "./supabase";
import { cacheThumbnail } from "./thumbnails";
import { chunks, containsTerm, mapLimit, uniq } from "./util";
import { outOfRegion, type Artist, type Source, type SourceType } from "./types";

type Task = { type: SourceType; query: string; fetchPage: (cursor?: string) => Promise<SfListResponse> };

export type TaskStat = {
  type: SourceType;
  query: string;
  pages: number;
  found: number;
  credits: number;
  stoppedEarly?: boolean; // refresh: a page was (almost) all known videos
  error?: string;
};

export type IngestStats = {
  runId: number;
  mode: IngestMode;
  datePosted: DatePosted | null; // search date filter used in refresh mode
  maxPages: number;
  tasks: TaskStat[];
  totalFound: number; // all rows returned, including duplicates
  unique: number; // after dedupe on video id
  newVideos: number;
  existingVideos: number;
  perSource: Record<SourceType, { found: number; unique: number }>;
  ownVsOther: { own: number; other: number }; // unique videos from the artist's accounts vs everyone else
  outOfRegion: number; // posted from outside artist.countries: stored, but no thumbnail and no checks
  discoveredSounds: { id: string; title: string | null }[];
  thumbnails: { cached: number; failed: number };
  credits: number;
};

export type IngestMode = "full" | "refresh";

export type IngestOptions = {
  // "refresh": only look for what's new since the last ingest. Searches get a date filter
  // and every query stops paging once a page is mostly videos we already have.
  mode?: IngestMode;
  maxPages?: number;
  // Off by default: the goal is footage of the artist posted by OTHER accounts.
  includeOwnProfile?: boolean; // fetch the artist's own posts (also needed for sound discovery)
  includeSounds?: boolean; // videos using the artist's sounds (mostly people dancing to the song)
};

// Smallest date window Social Fetch offers that still covers everything since `since`.
export function datePostedSince(since: string | null): DatePosted | null {
  if (!since) return null;
  const days = (Date.now() - new Date(since).getTime()) / 86_400_000 + 1; // one day margin
  if (days <= 7) return "this-week";
  if (days <= 31) return "this-month";
  if (days <= 92) return "last-3-months";
  if (days <= 183) return "last-6-months";
  return null;
}

// Refresh: stop paging a query when less than this share of a page is new.
const REFRESH_MIN_NEW = 0.2;

// Search first: the artist name combined with context words that surface footage
// ("russo live", "russo optreden"), songs, collaborators and custom queries.
export function buildTasks(artist: Artist, opts: IngestOptions = {}, datePosted: DatePosted | null = null): Task[] {
  const names = uniq([artist.name, ...artist.aliases]);
  const region = artist.region ?? undefined;
  const searchQueries = uniq([
    ...names,
    ...config.searchModifiers.map((m) => `${artist.name} ${m}`),
    // Song titles and collaborators alone are too generic, so pair them with the name.
    ...artist.song_titles.map((t) => `${artist.name} ${t}`),
    ...artist.collaborators.map((c) => `${artist.name} ${c}`),
    ...artist.extra_queries,
  ]);
  const hashtags = uniq(
    (artist.hashtags.length ? artist.hashtags : names).map((h) => h.replace(/^#/, "").replace(/\s+/g, "")),
  );
  const search = (q: string, sortBy?: "date-posted") => ({
    type: "search" as const,
    query: sortBy ? `${q} [recent]` : q,
    fetchPage: (c?: string) => socialFetch.searchVideos(q, { cursor: c, region, sortBy, datePosted: datePosted ?? undefined }),
  });
  const profile = (type: "profile" | "fan_account", handle: string) => ({
    type,
    query: handle,
    fetchPage: (c?: string) => socialFetch.profileVideos(handle, c),
  });

  return [
    ...searchQueries.map((q) => search(q)),
    // Relevance ranking favours old viral videos; also pull the newest uploads.
    // (With a date filter the plain name search already covers that.)
    ...(datePosted ? [] : names.map((n) => search(n, "date-posted"))),
    ...hashtags.map((h) => ({
      type: "hashtag" as const,
      query: h,
      fetchPage: (c?: string) => socialFetch.searchHashtag(h, c),
    })),
    ...uniq(artist.fan_accounts).map((h) => profile("fan_account", h)),
    ...(opts.includeOwnProfile ? uniq(artist.handles).map((h) => profile("profile", h)) : []),
  ];
}

function soundTasks(soundIds: string[]): Task[] {
  return uniq(soundIds).map((id) => ({
    type: "sound" as const,
    query: id,
    fetchPage: (c?: string) => socialFetch.musicVideos(id, c),
  }));
}

const MAX_DISCOVERED_SOUNDS = 15;

// Sounds used on the artist's own posts that belong to the artist: their releases
// ("BOEM! — Samuel Welten & Russo") or their original sounds ("original sound - russo_nl").
export function discoverSounds(artist: Artist, videos: NormalizedVideo[]): { id: string; title: string | null }[] {
  const handles = artist.handles.map((h) => h.replace(/^@/, "").toLowerCase());
  const names = [artist.name, ...artist.aliases].map((n) => n.toLowerCase());
  const byViews = new Map<string, { id: string; title: string | null; views: number }>();
  for (const v of videos) {
    if (!v.sound_id || !v.author_handle || !handles.includes(v.author_handle)) continue;
    const author = (v.sound_author ?? "").toLowerCase();
    const title = (v.sound_title ?? "").toLowerCase();
    const isArtistSound =
      names.some((n) => containsTerm(author, n)) ||
      handles.some((h) => title.endsWith(`- ${h}`));
    if (!isArtistSound) continue;
    const prev = byViews.get(v.sound_id);
    byViews.set(v.sound_id, { id: v.sound_id, title: v.sound_title, views: (prev?.views ?? 0) + (v.views ?? 0) });
  }
  return [...byViews.values()]
    .filter((s) => !artist.sound_ids.includes(s.id))
    .sort((a, b) => b.views - a.views)
    .slice(0, MAX_DISCOVERED_SOUNDS)
    .map(({ id, title }) => ({ id, title }));
}

export async function ingestArtist(artistId: string, opts: IngestOptions = {}): Promise<IngestStats> {
  const maxPages = opts.maxPages ?? config.maxPages;
  const mode = opts.mode ?? "full";
  const startedAt = new Date().toISOString();
  const supabase = db();

  const { data: artist, error } = await supabase.from("artists").select("*").eq("id", artistId).single<Artist>();
  if (error || !artist) throw new Error(`Artist ${artistId} not found`);

  const refresh = mode === "refresh";
  const datePosted = refresh ? datePostedSince(artist.last_ingest_at) : null;
  // Refresh needs to know what we already have, to stop paging when a page has nothing new.
  const known = refresh ? new Set((await selectIds(artistId)).map((r) => r.id)) : new Set<string>();

  const { data: run } = await supabase
    .from("ingest_runs")
    .insert({ artist_id: artistId, stats: { maxPages, mode } })
    .select("id")
    .single();
  const runId = run!.id as number;

  const found = new Map<string, { video: NormalizedVideo; sources: Source[] }>();
  const sourceTypes: SourceType[] = ["search", "hashtag", "fan_account", "profile", "sound"];
  const perSourceIds = Object.fromEntries(sourceTypes.map((t) => [t, new Set<string>()])) as Record<SourceType, Set<string>>;
  const perSourceFound = Object.fromEntries(sourceTypes.map((t) => [t, 0])) as Record<SourceType, number>;

  const runTask = async (task: Task): Promise<TaskStat> => {
    const stat: TaskStat = { type: task.type, query: task.query, pages: 0, found: 0, credits: 0 };
    let cursor: string | undefined;
    try {
      while (stat.pages < maxPages) {
        const res = await task.fetchPage(cursor);
        stat.pages++;
        stat.credits += res.meta.creditsCharged ?? 0;
        const items = (res.data.videos ?? []).filter((item) => !!item?.id);
        for (const item of items) {
          stat.found++;
          perSourceFound[task.type]++;
          perSourceIds[task.type].add(item.id);
          const source: Source = { type: task.type, query: task.query };
          const existing = found.get(item.id);
          if (existing) {
            if (!existing.sources.some((s) => s.type === source.type && s.query === source.query))
              existing.sources.push(source);
          } else {
            found.set(item.id, { video: normalizeVideo(item), sources: [source] });
          }
        }
        if (!res.data.page?.hasMore || !res.data.page.nextCursor) break;
        if (refresh && items.filter((item) => !known.has(item.id)).length < items.length * REFRESH_MIN_NEW) {
          stat.stoppedEarly = true;
          break;
        }
        cursor = res.data.page.nextCursor;
      }
    } catch (e) {
      stat.error = e instanceof Error ? e.message : String(e);
    }
    return stat;
  };

  const taskStats = await mapLimit(buildTasks(artist, opts, datePosted), 4, runTask);

  let discoveredSounds: { id: string; title: string | null }[] = [];
  if (opts.includeSounds) {
    // Needs the own profile in this run to find new sounds; known sound_ids are fetched regardless.
    discoveredSounds = discoverSounds(artist, [...found.values()].map((f) => f.video));
    if (discoveredSounds.length) {
      artist.sound_ids = [...artist.sound_ids, ...discoveredSounds.map((s) => s.id)];
      await supabase.from("artists").update({ sound_ids: artist.sound_ids }).eq("id", artistId);
    }
    taskStats.push(...(await mapLimit(soundTasks(artist.sound_ids), 4, runTask)));
  }

  // Merge with what's already stored: keep the original artist, first_seen_at and sources.
  const ids = [...found.keys()];
  const existing = new Map<string, { artist_id: string; sources: Source[]; thumbnail_cached_path: string | null }>();
  for (const chunk of chunks(ids, 200)) {
    const { data } = await supabase
      .from("videos")
      .select("id, artist_id, sources, thumbnail_cached_path")
      .in("id", chunk);
    for (const row of data ?? []) existing.set(row.id, row);
  }

  // Cache thumbnails now: TikTok CDN links expire within hours/days. Not for videos from outside
  // the artist's countries (scripts/backfill-thumbnails.ts fetches them if the countries change).
  const regionOf = (id: string) => found.get(id)!.video.raw.region as string | null;
  const needThumb = ids.filter(
    (id) => !existing.get(id)?.thumbnail_cached_path && found.get(id)!.video.thumbnail_url && !outOfRegion(artist, regionOf(id)),
  );
  const cachedPaths = new Map<string, string>();
  let thumbFailed = 0;
  await mapLimit(needThumb, 8, async (id) => {
    const path = await cacheThumbnail(artistId, id, found.get(id)!.video.thumbnail_url!);
    if (path) cachedPaths.set(id, path);
    else thumbFailed++;
  });

  const now = new Date().toISOString();
  const rows = ids.map((id) => {
    const { video, sources } = found.get(id)!;
    const prev = existing.get(id);
    const mergedSources = [...(prev?.sources ?? [])];
    for (const s of sources)
      if (!mergedSources.some((m) => m.type === s.type && m.query === s.query)) mergedSources.push(s);
    return {
      ...video,
      artist_id: prev?.artist_id ?? artistId,
      sources: mergedSources,
      thumbnail_cached_path: cachedPaths.get(id) ?? prev?.thumbnail_cached_path ?? null,
      last_seen_at: now,
    };
  });
  for (const chunk of chunks(rows, 200)) {
    const { error: upsertError } = await supabase.from("videos").upsert(chunk, { onConflict: "id" });
    if (upsertError) throw new Error(`Upsert videos failed: ${upsertError.message}`);
  }
  // A snapshot of the numbers on every ingest: growth over time is what tells a real
  // outlier apart from an old video that slowly piled up views.
  for (const chunk of chunks(rows, 500)) {
    await supabase.from("video_stats").upsert(
      chunk.map((r) => ({
        video_id: r.id,
        captured_at: now,
        views: r.views,
        likes: r.likes,
        comments: r.comments,
        shares: r.shares,
        saves: r.saves,
        author_followers: r.author_followers,
      })),
      { onConflict: "video_id,captured_at", ignoreDuplicates: true },
    );
  }

  const ownHandles = artist.handles.map((h) => h.replace(/^@/, "").toLowerCase());
  const stats: IngestStats = {
    runId,
    mode,
    datePosted,
    maxPages,
    tasks: taskStats,
    totalFound: taskStats.reduce((n, t) => n + t.found, 0),
    unique: ids.length,
    newVideos: ids.filter((id) => !existing.has(id)).length,
    existingVideos: existing.size,
    perSource: Object.fromEntries(
      (Object.keys(perSourceIds) as SourceType[]).map((t) => [
        t,
        { found: perSourceFound[t], unique: perSourceIds[t].size },
      ]),
    ) as IngestStats["perSource"],
    ownVsOther: {
      own: rows.filter((r) => ownHandles.includes(r.author_handle ?? "")).length,
      other: rows.filter((r) => !ownHandles.includes(r.author_handle ?? "")).length,
    },
    outOfRegion: ids.filter((id) => outOfRegion(artist, regionOf(id))).length,
    discoveredSounds,
    thumbnails: { cached: cachedPaths.size, failed: thumbFailed },
    credits: taskStats.reduce((n, t) => n + t.credits, 0),
  };

  await supabase
    .from("ingest_runs")
    .update({ finished_at: new Date().toISOString(), credits_used: stats.credits, stats })
    .eq("id", runId);
  // The start time, not the end: videos posted during the run are picked up next time.
  await supabase.from("artists").update({ last_ingest_at: startedAt }).eq("id", artistId);

  return stats;
}

async function selectIds(artistId: string): Promise<{ id: string }[]> {
  const out: { id: string }[] = [];
  for (let from = 0; ; from += 1000) {
    const { data, error } = await db().from("videos").select("id").eq("artist_id", artistId).order("id").range(from, from + 999);
    if (error) throw new Error(error.message);
    out.push(...(data ?? []));
    if (!data || data.length < 1000) return out;
  }
}
