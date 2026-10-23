import "server-only";
import { config } from "../env";
import { db } from "../supabase";
import { chunks, mapLimit } from "../util";
import type { Artist, ContentType, Status, VideoRow } from "../types";
import { classifyWithLlm, llmProvider, type FewShot } from "./llm";
import { applyRules } from "./rules";

// The funnel: rules (layer 0) → LLM (layer 1) → human (thumbs in the UI).
// Each layer appends rows to `classifications`; the video_status view picks the
// effective verdict (human > rules > llm). A new layer = a new step here plus a
// new value in the layer check constraint and the view's priority order.

export type ClassifyStats = {
  provider: string | null;
  rules: { relevant: number; unrelated: number };
  llm: { classified: number; failed: number; errors: string[] };
  distribution: Record<Status, number>;
  distributionOther: Record<Status, number>; // excluding the artist's own accounts
  byContentType: Record<string, number>;
};

type VideoForClassify = Pick<
  VideoRow,
  "id" | "author_handle" | "caption" | "hashtags" | "sound_id" | "sound_title" | "sound_author"
>;

export async function classifyArtist(
  artistId: string,
  opts: { force?: boolean; limit?: number } = {},
): Promise<ClassifyStats> {
  const supabase = db();
  const { data: artist } = await supabase.from("artists").select("*").eq("id", artistId).single<Artist>();
  if (!artist) throw new Error(`Artist ${artistId} not found`);

  const videos = await selectAll<VideoForClassify>("videos", "id, author_handle, caption, hashtags, sound_id, sound_title, sound_author", artistId);
  const layers = new Map<string, Set<string>>();
  const rulesUnrelated = new Set<string>();
  for (const chunk of chunks(videos.map((v) => v.id), 300)) {
    const { data } = await supabase.from("classifications").select("video_id, layer, is_about_artist").in("video_id", chunk);
    for (const c of data ?? []) {
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
    provider: llmProvider()?.model ?? null,
    rules: { relevant: 0, unrelated: 0 },
    llm: { classified: 0, failed: 0, errors: [] },
    distribution: { relevant: 0, review: 0, unrelated: 0, unclassified: 0 },
    distributionOther: { relevant: 0, review: 0, unrelated: 0, unclassified: 0 },
    byContentType: {},
  };

  const ruleRows: object[] = [];
  const llmQueue: { video: VideoForClassify; hints: string[] }[] = [];
  for (const v of videos) {
    const done = layers.get(v.id) ?? new Set();
    if (done.has("human")) continue;
    const { verdict, hints } = applyRules(artist, v);
    if (verdict && !done.has("rules")) {
      ruleRows.push({ video_id: v.id, layer: "rules", ...verdict });
      if (verdict.is_about_artist) stats.rules.relevant++;
      else stats.rules.unrelated++;
    }
    const ruledOut = (verdict && !verdict.is_about_artist) || rulesUnrelated.has(v.id);
    // Rule-relevant videos still go to the LLM for content_type/usability.
    if (!ruledOut && (opts.force || !done.has("llm"))) llmQueue.push({ video: v, hints });
  }
  for (const chunk of chunks(ruleRows, 300)) await supabase.from("classifications").insert(chunk);

  const queue = opts.limit ? llmQueue.slice(0, opts.limit) : llmQueue;
  if (queue.length && stats.provider) {
    const examples = await fewShotExamples(artistId);
    await mapLimit(queue, config.llmConcurrency, async ({ video, hints }) => {
      try {
        const { model, ...verdict } = await classifyWithLlm(artist, { ...video, hints }, examples);
        await supabase.from("classifications").insert({ video_id: video.id, layer: "llm", model, ...verdict });
        stats.llm.classified++;
      } catch (e) {
        stats.llm.failed++;
        if (stats.llm.errors.length < 5) stats.llm.errors.push(e instanceof Error ? e.message : String(e));
      }
    });
  }

  const statuses = await selectAll<{ status: Status; content_type: ContentType | null; author_handle: string | null }>(
    "video_status",
    "status, content_type, author_handle",
    artistId,
  );
  for (const s of statuses) {
    stats.distribution[s.status]++;
    if (!artist.handles.includes(s.author_handle ?? "")) stats.distributionOther[s.status]++;
    if (s.status !== "unrelated" && s.content_type)
      stats.byContentType[s.content_type] = (stats.byContentType[s.content_type] ?? 0) + 1;
  }
  return stats;
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

async function selectAll<T>(table: string, columns: string, artistId: string): Promise<T[]> {
  const out: T[] = [];
  for (let from = 0; ; from += 1000) {
    const { data, error } = await db().from(table).select(columns).eq("artist_id", artistId).range(from, from + 999);
    if (error) throw new Error(error.message);
    out.push(...((data ?? []) as T[]));
    if (!data || data.length < 1000) return out;
  }
}
