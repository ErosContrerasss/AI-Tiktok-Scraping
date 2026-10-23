import "server-only";
import { config } from "./env";
import { normalizeVideo, type NormalizedVideo } from "./normalize";
import { socialFetch, type SfListResponse } from "./socialfetch";
import { db } from "./supabase";
import { cacheThumbnail } from "./thumbnails";
import { chunks, containsTerm, mapLimit, uniq } from "./util";
import type { Artist, Source, SourceType } from "./types";

type Task = { type: SourceType; query: string; fetchPage: (cursor?: string) => Promise<SfListResponse> };

export type TaskStat = {
  type: SourceType;
  query: string;
  pages: number;
  found: number;
  credits: number;
  error?: string;
};

export type IngestStats = {
  runId: number;
  maxPages: number;
  tasks: TaskStat[];
  totalFound: number; // all rows returned, including duplicates
  unique: number; // after dedupe on video id
  newVideos: number;
  existingVideos: number;
  perSource: Record<SourceType, { found: number; unique: number }>;
  ownVsOther: { own: number; other: number }; // unique videos from the artist's accounts vs everyone else
  discoveredSounds: { id: string; title: string | null }[];
  thumbnails: { cached: number; failed: number };
  credits: number;
};

// Phase 1: search, hashtags and own profiles. Phase 2 (sounds) runs after we
// discovered the artist's sounds from their own posts.
export function buildTasks(artist: Artist): Task[] {
  const names = uniq([artist.name, ...artist.aliases]);
  // Song titles alone are too generic ("Ik Wil"), so pair them with the artist name.
  const searchQueries = uniq([...names, ...artist.song_titles.map((t) => `${t} ${artist.name}`)]);
  const hashtags = uniq(
    (artist.hashtags.length ? artist.hashtags : names).map((h) => h.replace(/^#/, "").replace(/\s+/g, "")),
  );

  return [
    ...searchQueries.map((q) => ({
      type: "search" as const,
      query: q,
      fetchPage: (c?: string) => socialFetch.searchVideos(q, c, artist.region ?? undefined),
    })),
    ...hashtags.map((h) => ({
      type: "hashtag" as const,
      query: h,
      fetchPage: (c?: string) => socialFetch.searchHashtag(h, c),
    })),
    ...uniq(artist.handles.map((h) => h.replace(/^@/, ""))).map((h) => ({
      type: "profile" as const,
      query: h,
      fetchPage: (c?: string) => socialFetch.profileVideos(h, c),
    })),
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
// Other people using these sounds is the richest source of third-party content.
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

export async function ingestArtist(artistId: string, opts: { maxPages?: number } = {}): Promise<IngestStats> {
  const maxPages = opts.maxPages ?? config.maxPages;
  const supabase = db();

  const { data: artist, error } = await supabase.from("artists").select("*").eq("id", artistId).single<Artist>();
  if (error || !artist) throw new Error(`Artist ${artistId} not found`);

  const { data: run } = await supabase
    .from("ingest_runs")
    .insert({ artist_id: artistId, stats: { maxPages } })
    .select("id")
    .single();
  const runId = run!.id as number;

  const found = new Map<string, { video: NormalizedVideo; sources: Source[] }>();
  const perSourceIds: Record<SourceType, Set<string>> = {
    search: new Set(),
    hashtag: new Set(),
    profile: new Set(),
    sound: new Set(),
  };
  const perSourceFound: Record<SourceType, number> = { search: 0, hashtag: 0, profile: 0, sound: 0 };

  const runTask = async (task: Task): Promise<TaskStat> => {
    const stat: TaskStat = { type: task.type, query: task.query, pages: 0, found: 0, credits: 0 };
    let cursor: string | undefined;
    try {
      while (stat.pages < maxPages) {
        const res = await task.fetchPage(cursor);
        stat.pages++;
        stat.credits += res.meta.creditsCharged ?? 0;
        for (const item of res.data.videos ?? []) {
          if (!item?.id) continue;
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
        cursor = res.data.page.nextCursor;
      }
    } catch (e) {
      stat.error = e instanceof Error ? e.message : String(e);
    }
    return stat;
  };

  const taskStats = await mapLimit(buildTasks(artist), 4, runTask);

  // Remember discovered sounds on the artist card: the sound rule then marks
  // every video using them as relevant, and the next run fetches them directly.
  const discoveredSounds = discoverSounds(artist, [...found.values()].map((f) => f.video));
  if (discoveredSounds.length) {
    artist.sound_ids = [...artist.sound_ids, ...discoveredSounds.map((s) => s.id)];
    await supabase.from("artists").update({ sound_ids: artist.sound_ids }).eq("id", artistId);
  }
  taskStats.push(...(await mapLimit(soundTasks(artist.sound_ids), 4, runTask)));

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

  // Cache thumbnails now: TikTok CDN links expire within hours/days.
  const needThumb = ids.filter((id) => !existing.get(id)?.thumbnail_cached_path && found.get(id)!.video.thumbnail_url);
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

  const ownHandles = artist.handles.map((h) => h.replace(/^@/, "").toLowerCase());
  const stats: IngestStats = {
    runId,
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
    discoveredSounds,
    thumbnails: { cached: cachedPaths.size, failed: thumbFailed },
    credits: taskStats.reduce((n, t) => n + t.credits, 0),
  };

  await supabase
    .from("ingest_runs")
    .update({ finished_at: new Date().toISOString(), credits_used: stats.credits, stats })
    .eq("id", runId);

  return stats;
}
