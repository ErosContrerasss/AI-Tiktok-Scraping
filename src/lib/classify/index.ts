import "server-only";
import { config, env } from "../env";
import { db } from "../supabase";
import { FRAME_COUNT, grabFrames } from "../frames";
import { buildArtistSheet, loadSheet, type SheetImage } from "../sheet";
import { chunks, mapLimit } from "../util";
import type { Artist, ContentType, Status, VideoRow } from "../types";
import { classifyFramesWithJev, classifyWithJev, JEV_MODEL } from "./jev";
import { classifyWithLlm, llmProvider, type FewShot, type LlmInput } from "./llm";
import { applyRules } from "./rules";

// Goal: footage of the artist posted by OTHER accounts. Posts from the artist's own
// accounts get status "own" in the view and skip classification.
//
// The funnel: rules (layer 0) → LLM on text (layer 1) → vision on video frames
// (layer 2, optional) → human (thumbs in the UI).
// Each layer appends rows to `classifications`; the video_status view picks the
// effective verdict (human > rules > vision > llm). A new layer = a new step here plus a
// new value in the layer check constraint and the view's priority order.

export type ClassifyStats = {
  provider: string | null;
  rules: { unrelated: number };
  llm: { classified: number; failed: number; errors: string[] };
  vision: { mode?: string; checked: number; failed: number; credits: number; errors: string[] };
  distribution: Record<Status, number>;
  byContentType: Record<string, number>; // relevant videos only
};

type VideoForClassify = Pick<
  VideoRow,
  "id" | "author_handle" | "caption" | "hashtags" | "sound_id" | "sound_title" | "sound_author"
>;

export async function classifyArtist(
  artistId: string,
  opts: { force?: boolean; limit?: number; vision?: boolean; forceVision?: boolean; visionLimit?: number } = {},
): Promise<ClassifyStats> {
  const supabase = db();
  const { data: artist } = await supabase.from("artists").select("*").eq("id", artistId).single<Artist>();
  if (!artist) throw new Error(`Artist ${artistId} not found`);

  const videos = await selectAll<VideoForClassify>("videos", "id, author_handle, caption, hashtags, sound_id, sound_title, sound_author", artistId);
  const layers = new Map<string, Set<string>>();
  const rulesUnrelated = new Set<string>();
  for (const chunk of chunks(videos.map((v) => v.id), 300)) {
    // Paginate: a chunk can have more than the 1000-row response limit (one row per layer per run).
    const data: { video_id: string; layer: string; is_about_artist: boolean }[] = [];
    for (let from = 0; ; from += 1000) {
      const { data: page, error } = await supabase
        .from("classifications")
        .select("video_id, layer, is_about_artist")
        .in("video_id", chunk)
        .order("id")
        .range(from, from + 999);
      if (error) throw new Error(error.message);
      data.push(...(page ?? []));
      if (!page || page.length < 1000) break;
    }
    for (const c of data) {
      if (!layers.has(c.video_id)) layers.set(c.video_id, new Set());
      layers.get(c.video_id)!.add(c.layer);
      if (c.layer === "rules" && !c.is_about_artist) rulesUnrelated.add(c.video_id);
    }
  }

  // Rules are deterministic and cheap: on force, recompute them from the current artist card.
  if (opts.force) {
    for (const chunk of chunks(videos.map((v) => v.id), 300))
      await supabase.from("classifications").delete().eq("layer", "rules").in("video_id", chunk);
    rulesUnrelated.clear();
    for (const s of layers.values()) s.delete("rules");
  }

  const stats: ClassifyStats = {
    provider: classifierName(),
    rules: { unrelated: 0 },
    llm: { classified: 0, failed: 0, errors: [] },
    vision: { checked: 0, failed: 0, credits: 0, errors: [] },
    distribution: { relevant: 0, review: 0, unrelated: 0, own: 0, unclassified: 0 },
    byContentType: {},
  };

  const ruleRows: object[] = [];
  const llmQueue: { video: VideoForClassify; hints: string[] }[] = [];
  const own = new Set(artist.handles);
  for (const v of videos) {
    const done = layers.get(v.id) ?? new Set();
    if (done.has("human") || own.has(v.author_handle ?? "")) continue;
    const { verdict, hints } = applyRules(artist, v);
    if (verdict && !done.has("rules")) {
      ruleRows.push({ video_id: v.id, layer: "rules", ...verdict });
      stats.rules.unrelated++;
    }
    const ruledOut = !!verdict || rulesUnrelated.has(v.id);
    if (!ruledOut && (opts.force || !done.has("llm"))) llmQueue.push({ video: v, hints });
  }
  for (const chunk of chunks(ruleRows, 300)) await supabase.from("classifications").insert(chunk);

  const examples = stats.provider ? await fewShotExamples(artistId) : [];
  const queue = opts.limit ? llmQueue.slice(0, opts.limit) : llmQueue;
  if (queue.length && stats.provider) {
    await mapLimit(queue, config.llmConcurrency, async ({ video, hints }) => {
      try {
        // One retry: rare malformed structured output or transient API errors.
        const input = { ...video, hints };
        const { model, ...verdict } = await judge(artist, input, examples).catch(() => judge(artist, input, examples));
        await supabase.from("classifications").insert({ video_id: video.id, layer: "llm", model, ...verdict });
        stats.llm.classified++;
      } catch (e) {
        stats.llm.failed++;
        if (stats.llm.errors.length < 5) stats.llm.errors.push(e instanceof Error ? e.message : String(e));
      }
    });
  }

  if (opts.vision && stats.provider) await runVision(artist, layers, examples, stats, opts);

  const statuses = await selectAll<{ status: Status; content_type: ContentType | null }>(
    "video_status",
    "status, content_type",
    artistId,
  );
  for (const s of statuses) {
    stats.distribution[s.status]++;
    if (s.status === "relevant" && s.content_type)
      stats.byContentType[s.content_type] = (stats.byContentType[s.content_type] ?? 0) + 1;
  }
  return stats;
}

function classifierName(): string | null {
  if (config.classifier === "jev" && env.typesafeKey()) return JEV_MODEL;
  return llmProvider()?.model ?? null;
}

// Same verdict shape from either backend, so routing and the view don't care which one ran.
function judge(artist: Artist, video: LlmInput, examples: FewShot[], frames: Buffer[] = []) {
  return config.classifier === "jev" && env.typesafeKey()
    ? classifyWithJev(artist, video, examples, frames)
    : classifyWithLlm(artist, video, examples, frames);
}

// Layer 2 "vision": judge each video by its own frames.
// - With Jev and reference photos (default): frames-first, every video from other accounts
//   (except rule exclusions) gets ~12 frames checked against the reference photos.
// - Otherwise: only relevant + review candidates, 4 frames plus the post text.
// Frames come from TikTok's CDN (free); an expired link costs 1 credit to refresh, so run
// this right after ingest.
async function runVision(
  artist: Artist,
  layers: Map<string, Set<string>>,
  examples: FewShot[],
  stats: ClassifyStats,
  opts: { forceVision?: boolean; visionLimit?: number },
) {
  const supabase = db();
  const useJev = config.classifier === "jev" && !!env.typesafeKey();
  // Artist sheet (labelled photos from several sources); built on first use.
  let references: SheetImage[] = [];
  if (useJev) {
    references = await loadSheet(artist);
    if (!references.length && artist.handles.length) {
      const built = await buildArtistSheet(artist);
      stats.vision.credits += built.credits;
      const { data: fresh } = await supabase.from("artists").select("*").eq("id", artist.id).single<Artist>();
      if (fresh) {
        artist = fresh;
        references = await loadSheet(fresh);
      }
    }
  }
  const framesFirst = useJev && references.length > 0;
  stats.vision.mode = framesFirst ? `frames-first (artist sheet: ${references.length} foto's)` : "kandidaten + tekst";

  const candidates = (
    await selectAll<{ id: string; status: Status; layer: string | null; relevance: number | null }>(
      "video_status",
      "id, status, layer, relevance",
      artist.id,
    )
  )
    .filter((v) => v.layer !== "human" && v.status !== "own" && v.layer !== "rules")
    .filter((v) => {
      const checked = layers.get(v.id)?.has("vision") || v.layer === "vision";
      // forceVision re-checks everything vision saw before, including what it demoted.
      if (checked) return !!opts.forceVision;
      return framesFirst || v.status === "relevant" || v.status === "review";
    })
    .sort((a, b) => (b.relevance ?? 0) - (a.relevance ?? 0));
  const ids = candidates.slice(0, opts.visionLimit ?? candidates.length).map((v) => v.id);

  const rows: (VideoForClassify & {
    url: string | null;
    duration_ms: number | null;
    thumbnail_cached_path: string | null;
    raw: { media?: { play?: string | null } } | null;
  })[] = [];
  for (const chunk of chunks(ids, 200)) {
    const { data } = await supabase
      .from("videos")
      .select("id, url, duration_ms, raw, thumbnail_cached_path, author_handle, caption, hashtags, sound_id, sound_title, sound_author")
      .in("id", chunk);
    rows.push(...(data ?? []));
  }

  await mapLimit(rows, 6, async (video) => {
    try {
      const { frames, credits } = await grabFrames(video, framesFirst ? FRAME_COUNT : 4);
      stats.vision.credits += credits;
      const { hints } = applyRules(artist, video);
      const verdict = framesFirst
        ? await classifyFramesWithJev(references, frames, { artist, post: video })
        : await judge(artist, { ...video, hints }, examples, frames.map((f) => f.image));
      await supabase.from("classifications").insert({
        video_id: video.id,
        layer: "vision",
        model: verdict.model,
        is_about_artist: verdict.is_about_artist,
        confidence: verdict.confidence,
        content_type: verdict.content_type,
        usability: verdict.usability,
        reason: verdict.reason,
      });
      stats.vision.checked++;
    } catch (e) {
      stats.vision.failed++;
      if (stats.vision.errors.length < 5) stats.vision.errors.push(e instanceof Error ? e.message : String(e));
    }
  });
}

// Thumbs from the team become few-shot examples (most recent, balanced up/down).
async function fewShotExamples(artistId: string): Promise<FewShot[]> {
  const { data } = await db()
    .from("classifications")
    .select("is_about_artist, created_at, videos!inner(artist_id, author_handle, caption, hashtags, sound_title, sound_author)")
    .eq("layer", "human")
    .eq("videos.artist_id", artistId)
    .order("created_at", { ascending: false })
    .limit(100);
  type Row = { is_about_artist: boolean; videos: Omit<FewShot, "is_about_artist"> };
  const rows = (data ?? []) as unknown as Row[];
  const pick = (up: boolean) => rows.filter((r) => r.is_about_artist === up).slice(0, 6);
  return [...pick(true), ...pick(false)].map((r) => ({ ...r.videos, is_about_artist: r.is_about_artist }));
}

export async function selectAll<T>(table: string, columns: string, artistId: string): Promise<T[]> {
  const out: T[] = [];
  for (let from = 0; ; from += 1000) {
    // A stable order is required: range() over an unordered query can skip or repeat rows.
    const { data, error } = await db()
      .from(table)
      .select(columns)
      .eq("artist_id", artistId)
      .order("id")
      .range(from, from + 999);
    if (error) throw new Error(error.message);
    out.push(...((data ?? []) as T[]));
    if (!data || data.length < 1000) return out;
  }
}
