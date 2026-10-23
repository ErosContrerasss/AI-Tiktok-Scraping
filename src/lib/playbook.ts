import "server-only";
import { z } from "zod";
import { selectAll } from "./classify";
import { fetchVideoFile } from "./frames";
import { generateStructured } from "./llm-client";
import { db } from "./supabase";
import type { Artist, Status } from "./types";
import { chunks, mapLimit, truncate } from "./util";

// Playbook: learn from what already works. Outliers among the usable clips (far more views
// than the uploader's audience, or unusually high engagement) get a structured breakdown of
// how they're built; per output format those breakdowns become a blueprint that the
// production step can follow later.

export const FORMATS = [
  "lyric_video",
  "fan_edit",
  "live_clip",
  "behind_the_scenes",
  "interview_clip",
  "meme_or_skit",
  "dance_or_trend",
  "slideshow",
  "other",
] as const;
export type Format = (typeof FORMATS)[number];

const MIN_VIEWS = 2000; // below this, engagement rates are noise
const TOP_SHARE = 0.1;

type PerfRow = {
  id: string;
  views: number | null;
  author_followers: number | null;
  engagement_rate: number | null;
  views_per_follower: number | null;
};

export type Outlier = { id: string; reason: string; score: number };

// Top 10% of the artist's usable clips on views per follower or on engagement (whichever
// ranks the video higher). Views per follower needs follower counts, which fill in as
// videos are seen again during ingests.
export async function pickOutliers(artistId: string, limit = 30): Promise<Outlier[]> {
  const statuses = await selectAll<{ id: string; status: Status }>("video_status", "id, status", artistId);
  const usable = new Set(statuses.filter((s) => s.status === "relevant").map((s) => s.id));
  const rows = (
    await selectAll<PerfRow>("video_performance", "id, views, author_followers, engagement_rate, views_per_follower", artistId)
  ).filter((r) => usable.has(r.id) && (r.views ?? 0) >= MIN_VIEWS);

  const percentile = (values: number[]) => {
    const sorted = [...values].sort((a, b) => a - b);
    return (v: number) => sorted.filter((x) => x <= v).length / sorted.length;
  };
  const reach = percentile(rows.filter((r) => r.views_per_follower != null).map((r) => r.views_per_follower!));
  const engagement = percentile(rows.filter((r) => r.engagement_rate != null).map((r) => r.engagement_rate!));

  const scored = rows.map((r) => {
    const pr = r.views_per_follower != null ? reach(r.views_per_follower) : 0;
    const pe = r.engagement_rate != null ? engagement(r.engagement_rate) : 0;
    const reason =
      pr >= pe
        ? `${Math.round(r.views_per_follower!)}× views per volger (top ${Math.max(1, Math.round((1 - pr) * 100))}%)`
        : `engagement ${(r.engagement_rate! * 100).toFixed(1)}% (top ${Math.max(1, Math.round((1 - pe) * 100))}%)`;
    return { id: r.id, reason, score: Math.max(pr, pe) };
  });
  return scored
    .filter((s) => s.score >= 1 - TOP_SHARE)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);
}

export const BreakdownSchema = z.object({
  format: z.enum(FORMATS).describe("The output format this video is an example of"),
  duration_s: z.number().describe("Length in seconds"),
  hook: z.string().describe("What happens in the first 2 seconds, and why it makes people keep watching"),
  structure: z
    .array(z.object({ start_s: z.number(), end_s: z.number(), what: z.string() }))
    .describe("The video in 2-6 segments, in order"),
  editing: z.object({
    pace: z.enum(["slow", "medium", "fast"]),
    cuts: z.number().int().describe("Estimated number of cuts"),
    beat_synced: z.boolean().describe("Do cuts or effects land on the beat?"),
    effects: z.array(z.string()).describe("Transitions, zooms, filters, speed ramps etc. Empty if none"),
  }),
  text_on_screen: z.object({
    type: z.enum(["none", "lyrics", "hook_caption", "commentary", "subtitles"]),
    style: z.string().describe("Font, size, position, colour, how it appears. Empty if none"),
  }),
  audio: z.object({
    source: z.enum(["studio_song", "live_audio", "speech", "other_sound"]),
    song_part: z.string().describe("Which part of the song: intro, verse, chorus, drop, a specific line. Empty if not music"),
  }),
  artist_presence: z.string().describe("How and how long the artist is on screen: close-up, on stage, in a crowd shot, etc."),
  footage: z.string().describe("What kind of source footage is used: phone footage from the crowd, pro video, own posts, etc."),
  why_it_works: z.string().describe("1-2 sentences: why this video outperforms"),
  recipe: z.string().describe("Step-by-step instructions to make a new, original video like this from other footage of the artist"),
});
export type Breakdown = z.infer<typeof BreakdownSchema>;

const BREAKDOWN_PROMPT = `You analyse short-form videos (TikTok) of a music artist that performed far above expectations. Describe precisely how the video is built, so an editor can make new, original videos in the same style from other footage. Be concrete (seconds, counts, positions), not generic. Watch and listen to the whole video.`;

type VideoForBreakdown = {
  id: string;
  url: string | null;
  raw: { media?: { play?: string | null } } | null;
  author_handle: string | null;
  caption: string | null;
  sound_title: string | null;
  sound_author: string | null;
  views: number | null;
  likes: number | null;
  saves: number | null;
  author_followers: number | null;
};

export async function breakdownVideo(artist: Artist, video: VideoForBreakdown) {
  const { mp4, credits } = await fetchVideoFile(video);
  if (!mp4) throw new Error("Could not fetch video file");
  const text = `Artist: ${artist.name}${artist.notes ? ` (${artist.notes})` : ""}
Posted by: @${video.author_handle} (${video.author_followers ?? "?"} followers)
Caption: ${truncate(video.caption ?? "", 300)}
Sound: ${video.sound_title ?? "?"} — ${video.sound_author ?? "?"}
Views ${video.views ?? "?"}, likes ${video.likes ?? "?"}, saves ${video.saves ?? "?"}`;
  const { data, model } = await generateStructured(BreakdownSchema, { system: BREAKDOWN_PROMPT, text, video: mp4 });
  return { breakdown: data, model, credits };
}

export const BlueprintSchema = z.object({
  summary: z.string().describe("2-3 sentences: what a winning video of this format looks like for this artist"),
  length: z.string().describe("Typical length range, e.g. '8-15 s'"),
  hooks: z.array(z.string()).describe("Hook patterns that work, most common first"),
  structure: z.array(z.string()).describe("Template structure, step by step with timings"),
  editing: z.array(z.string()).describe("Editing rules: pace, cuts, beat sync, effects"),
  text: z.array(z.string()).describe("Text-on-screen rules. Empty if text isn't used"),
  audio: z.array(z.string()).describe("Which audio and which part of the song"),
  footage: z.array(z.string()).describe("What footage to use and how the artist should appear"),
  dos: z.array(z.string()),
  donts: z.array(z.string()),
  variations: z
    .array(z.string())
    .describe("Ways to vary videos built from this blueprint so each one is unique (no duplicate content)"),
});
export type Blueprint = z.infer<typeof BlueprintSchema>;

const BLUEPRINT_PROMPT = `You turn breakdowns of outperforming short-form videos into one practical blueprint for producing new videos of that format. Keep what the examples have in common, note real variation, ignore one-offs. Write it as instructions for an editor or an automated editing pipeline.`;

export type PlaybookStats = {
  outliers: number;
  analysed: number;
  failed: number;
  credits: number;
  errors: string[];
  formats: Record<string, number>;
  blueprints: string[];
};

export async function buildPlaybook(artistId: string, opts: { limit?: number; minExamples?: number } = {}): Promise<PlaybookStats> {
  const supabase = db();
  const { data: artist } = await supabase.from("artists").select("*").eq("id", artistId).single<Artist>();
  if (!artist) throw new Error(`Artist ${artistId} not found`);
  const stats: PlaybookStats = { outliers: 0, analysed: 0, failed: 0, credits: 0, errors: [], formats: {}, blueprints: [] };

  // 1. Breakdowns for outliers that don't have one yet.
  const outliers = await pickOutliers(artistId, opts.limit);
  stats.outliers = outliers.length;
  const done = new Set<string>();
  for (const chunk of chunks(outliers.map((o) => o.id), 200)) {
    const { data } = await supabase.from("video_breakdowns").select("video_id").in("video_id", chunk);
    for (const r of data ?? []) done.add(r.video_id);
  }
  const todo = outliers.filter((o) => !done.has(o.id));
  const videos = new Map<string, VideoForBreakdown>();
  for (const chunk of chunks(todo.map((o) => o.id), 200)) {
    const { data } = await supabase
      .from("videos")
      .select("id, url, raw, author_handle, caption, sound_title, sound_author, views, likes, saves, author_followers")
      .in("id", chunk);
    for (const v of data ?? []) videos.set(v.id, v);
  }
  await mapLimit(todo, 4, async (o) => {
    try {
      const { breakdown, model, credits } = await breakdownVideo(artist, videos.get(o.id)!);
      stats.credits += credits;
      await supabase.from("video_breakdowns").upsert({
        video_id: o.id,
        artist_id: artistId,
        format: breakdown.format,
        outlier_reason: o.reason,
        breakdown,
        model,
      });
      stats.analysed++;
    } catch (e) {
      stats.failed++;
      if (stats.errors.length < 5) stats.errors.push(e instanceof Error ? e.message : String(e));
    }
  });

  // 2. One blueprint per format with enough examples.
  const { data: rows } = await supabase
    .from("video_breakdowns")
    .select("video_id, format, outlier_reason, breakdown")
    .eq("artist_id", artistId);
  const byFormat = new Map<string, { video_id: string; outlier_reason: string | null; breakdown: Breakdown }[]>();
  for (const r of rows ?? []) byFormat.set(r.format, [...(byFormat.get(r.format) ?? []), r]);
  for (const [format, examples] of byFormat) {
    stats.formats[format] = examples.length;
    if (format === "other" || examples.length < (opts.minExamples ?? 3)) continue;
    const text = `Artist: ${artist.name}\nFormat: ${format}\n\n${examples
      .map((e, i) => `Example ${i + 1} (${e.outlier_reason ?? "outlier"}):\n${JSON.stringify(e.breakdown)}`)
      .join("\n\n")}`;
    const { data: blueprint, model } = await generateStructured(BlueprintSchema, { system: BLUEPRINT_PROMPT, text, maxTokens: 4096 });
    await supabase.from("playbooks").insert({
      artist_id: artistId,
      format,
      blueprint,
      video_ids: examples.map((e) => e.video_id),
      model,
    });
    stats.blueprints.push(format);
  }
  return stats;
}

export type PlaybookEntry = { format: string; blueprint: Blueprint; video_ids: string[]; created_at: string };

// Latest blueprint per format.
export async function loadPlaybook(artistId: string): Promise<PlaybookEntry[]> {
  const { data } = await db()
    .from("playbooks")
    .select("format, blueprint, video_ids, created_at")
    .eq("artist_id", artistId)
    .order("created_at", { ascending: false });
  const latest = new Map<string, PlaybookEntry>();
  for (const p of (data ?? []) as PlaybookEntry[]) if (!latest.has(p.format)) latest.set(p.format, p);
  return [...latest.values()].sort((a, b) => b.video_ids.length - a.video_ids.length);
}

// For the dashboard: latest blueprint per format plus its examples that still count
// (a thumbs-down removes the breakdown).
export async function loadPlaybookView(artistId: string) {
  const playbook = await loadPlaybook(artistId);
  const ids = [...new Set(playbook.flatMap((p) => p.video_ids))];
  const { data } = ids.length
    ? await db().from("video_breakdowns").select("video_id, outlier_reason, videos(url, author_handle)").in("video_id", ids)
    : { data: [] };
  type Row = { video_id: string; outlier_reason: string | null; videos: { url: string | null; author_handle: string | null } };
  const examples = new Map(((data ?? []) as unknown as Row[]).map((r) => [r.video_id, r]));
  return playbook.map((p) => ({
    format: p.format,
    blueprint: p.blueprint,
    created_at: p.created_at,
    examples: p.video_ids
      .filter((id) => examples.has(id))
      .map((id) => {
        const r = examples.get(id)!;
        return { id, url: r.videos?.url ?? null, author: r.videos?.author_handle ?? null, reason: r.outlier_reason };
      }),
  }));
}
