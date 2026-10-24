import "server-only";
import { execFile } from "node:child_process";
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import ffmpegStatic from "ffmpeg-static";
import { classifyFramesWithJev, faceCutWithJev } from "./classify/jev";
import { fetchVideoFile, type Frame } from "./frames";
import { findSegments, type Crop, type FrameResult, type Segment } from "./segments";
import { loadSheet } from "./sheet";
import { db } from "./supabase";
import type { Artist } from "./types";
import { chunks, mapLimit } from "./util";

// Fine pass over one video, run when its fragments are about to be used (downloaded for the
// clip library). The coarse fragments come from 12 frames over the whole video; here the real
// mp4 is looked at 2 times a second with the crop applied, so cut points land on the half
// second and a moment where the artist steps out of frame splits the fragment. The mp4 also
// gives the real resolution: after crop and zoom to a 1080x1920 vertical, is it still sharp?

const run = promisify(execFile);
const FFMPEG = ffmpegStatic ?? "ffmpeg";

const FPS = 2;
const MAX_FRAMES = 120; // longer videos get sampled more sparsely
const JEV_BATCH = 12;
const OUT_W = 1080;
const OUT_H = 1920;

type Quality = "hd" | "ok" | "low";

// Pixels the source offers for a 1080x1920 vertical after cropping: the picture is scaled to
// fill the frame, so the limiting side decides. TikTok serves most videos at 576x1024, also via
// the paid download, so that's the practical ceiling: hd = a real 1080p source, ok = about
// source quality (960+ left after cropping), low = cropped/zoomed hard or a small source.
export function effectiveHeight(width: number, height: number, crop: Crop | null): number {
  const w = width * (crop?.w ?? 1);
  const h = height * (crop?.h ?? 1);
  return Math.round(Math.min(h, (w * OUT_H) / OUT_W));
}

export const qualityOf = (effective: number): Quality => (effective >= 1600 ? "hd" : effective >= 960 ? "ok" : "low");

const ARTIST_MIN = 0.7;
const TEXT_MAX = 1.25;
const BRIDGE_S = 1; // the artist turning away for up to a second doesn't break a fragment

// Close short gaps where only the artist dipped (text stayed clean) between good frames.
function bridgeArtistDips(results: FrameResult[], fps: number): FrameResult[] {
  const out = results.map((r) => ({ ...r }));
  const good = (r: FrameResult) => r.artist_p >= ARTIST_MIN && (r.text_level < TEXT_MAX || !!r.inpaint);
  const maxGap = Math.max(1, Math.floor(BRIDGE_S * fps));
  for (let i = 1; i < out.length; i++) {
    if (good(out[i]) || !good(out[i - 1])) continue;
    let j = i;
    while (j < out.length && !good(out[j]) && (out[j].text_level < TEXT_MAX || !!out[j].inpaint)) j++;
    if (j < out.length && j - i <= maxGap && good(out[j])) for (let k = i; k < j; k++) out[k].artist_p = ARTIST_MIN;
    i = j;
  }
  return out;
}

async function sampleFrames(mp4: Buffer, durationS: number, crop: Crop | null) {
  const dir = await mkdtemp(join(tmpdir(), "refine-"));
  try {
    const input = join(dir, "video.mp4");
    await writeFile(input, mp4);
    const fps = Math.min(FPS, MAX_FRAMES / Math.max(durationS, 1));
    const cropFilter = crop ? `crop=iw*${crop.w.toFixed(4)}:ih*${crop.h.toFixed(4)}:iw*${crop.x.toFixed(4)}:ih*${crop.y.toFixed(4)},` : "";
    const { stderr } = await run(FFMPEG, [
      "-hide_banner", "-i", input,
      "-vf", `${cropFilter}fps=${fps.toFixed(4)},scale='if(gt(iw,ih),-2,360)':'if(gt(iw,ih),360,-2)'`,
      "-q:v", "5", join(dir, "f%04d.jpg"),
    ]);
    const size = stderr.match(/Stream #0:\d+.*?Video:.*?, (\d{3,5})x(\d{3,5})/);
    const files = (await readdir(dir)).filter((f) => f.endsWith(".jpg")).sort();
    const frames: Frame[] = await Promise.all(
      files.map(async (f, i) => ({ image: await readFile(join(dir, f)), atSeconds: Math.round((i / fps) * 10) / 10 })),
    );
    return { frames, fps, width: size ? Number(size[1]) : null, height: size ? Number(size[2]) : null };
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

export type RefineResult = {
  videoId: string;
  credits: number;
  frames: number;
  before: Segment[];
  after: Segment[];
  quality: Quality | null;
  effectiveHeight: number | null;
  width?: number | null;
  height?: number | null;
  error?: string;
};

type Row = {
  video_id: string;
  artist_id: string;
  duration_s: number | null;
  segments: Segment[];
  coarse_segments: Segment[] | null;
  crop: Crop | null;
  crop_kind: "bars" | "edge" | null;
  videos: { url: string | null; raw: { media?: { play?: string | null } } | null };
};

export async function refineVideo(row: Row, sheet: Awaited<ReturnType<typeof loadSheet>>): Promise<RefineResult> {
  const before = row.coarse_segments ?? row.segments;
  const base: RefineResult = { videoId: row.video_id, credits: 0, frames: 0, before, after: before, quality: null, effectiveHeight: null };
  const { mp4, credits } = await fetchVideoFile({ id: row.video_id, url: row.videos.url, raw: row.videos.raw });
  base.credits = credits;
  if (!mp4) return { ...base, error: "Could not fetch video file" };
  const durationS = row.duration_s ?? 0;
  const sampled = await sampleFrames(mp4, durationS, row.crop);
  base.frames = sampled.frames.length;
  if (!sampled.frames.length) return { ...base, error: "No frames" };

  // Artist and text per frame (batches of 12, like the frames check), plus a face cut off
  // by the edge when the picture was cropped.
  const judged: { p: number; text: number }[] = [];
  for (const batch of chunks(sampled.frames, JEV_BATCH)) {
    const v = await classifyFramesWithJev(sheet, batch);
    judged.push(...v.frames.map((f) => ({ p: f.p, text: f.text })));
  }
  const faceCut = row.crop_kind === "edge" ? (await Promise.all(chunks(sampled.frames, JEV_BATCH).map((b) => faceCutWithJev(b.map((f) => f.image))))).flat() : [];

  // Text inside a fragment that was planned for inpainting stays allowed there (the remover
  // finds it per frame); anywhere else text means the frame isn't clean.
  const inpaintAt = (t: number) => before.find((s) => s.inpaint && t >= s.start_s - 0.5 && t <= s.end_s + 0.5)?.text_box;
  const results: FrameResult[] = sampled.frames.map((f, i) => {
    const t = f.atSeconds ?? i / sampled.fps;
    const cut = (faceCut[i] ?? 0) >= 0.5;
    return {
      at_seconds: t + 0.5 / sampled.fps, // findSegments centres a window of 1/fps on each frame
      artist_p: cut ? Math.min(judged[i].p, 0.5) : judged[i].p,
      text_level: judged[i].text,
      inpaint: inpaintAt(t),
    };
  });
  const after = findSegments(bridgeArtistDips(results, sampled.fps), [], sampled.frames.length / sampled.fps);
  const effective = sampled.width && sampled.height ? effectiveHeight(sampled.width, sampled.height, row.crop) : null;
  return { ...base, after, width: sampled.width, height: sampled.height, effectiveHeight: effective, quality: effective ? qualityOf(effective) : null };
}

export async function refineVideos(artistId: string, opts: { videoIds?: string[]; limit?: number; force?: boolean } = {}) {
  const supabase = db();
  const { data: artist } = await supabase.from("artists").select("*").eq("id", artistId).single<Artist>();
  if (!artist) throw new Error(`Artist ${artistId} not found`);
  const sheet = await loadSheet(artist);

  let query = supabase
    .from("video_segments")
    .select("video_id, artist_id, duration_s, segments, coarse_segments, crop, crop_kind, videos(url, raw)")
    .eq("artist_id", artistId)
    .gt("usable_seconds", 0)
    .order("usable_seconds", { ascending: false });
  if (opts.videoIds?.length) query = query.in("video_id", opts.videoIds);
  if (!opts.force) query = query.is("refined_at", null);
  const { data } = await query.limit(opts.limit ?? 50);
  const rows = (data ?? []) as unknown as Row[];

  return mapLimit(rows, 3, async (row) => {
    const r = await refineVideo(row, sheet).catch((e) => ({ videoId: row.video_id, error: String(e).slice(0, 200) }) as RefineResult);
    if (r.error) return r;
    const seconds = (ss: Segment[]) => Math.round(ss.reduce((n, s) => n + s.end_s - s.start_s, 0) * 10) / 10;
    await supabase
      .from("video_segments")
      .update({
        coarse_segments: r.before,
        segments: r.after,
        usable_seconds: seconds(r.after),
        clean_seconds: seconds(r.after.filter((s) => !s.inpaint)),
        refined_at: new Date().toISOString(),
        source_width: r.width ?? null,
        source_height: r.height ?? null,
        effective_height: r.effectiveHeight,
        quality: r.quality,
      })
      .eq("video_id", row.video_id);
    return r;
  });
}
