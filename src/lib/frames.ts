import "server-only";
import { execFile } from "node:child_process";
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import ffmpegStatic from "ffmpeg-static";
import { socialFetch } from "./socialfetch";
import { db, THUMB_BUCKET } from "./supabase";

const run = promisify(execFile);
const FFMPEG = ffmpegStatic ?? "ffmpeg";
const FRAME_WIDTH = 360;
export const FRAME_COUNT = Number(process.env.FRAME_COUNT ?? 12);

export type Frame = { image: Buffer; atSeconds: number | null };

type VideoForFrames = {
  id: string;
  url: string | null;
  duration_ms: number | null;
  thumbnail_cached_path?: string | null;
  raw: { media?: { play?: string | null } } | null;
};

export type FramesResult = { frames: Frame[]; credits: number };

// Grabs a few JPEG frames straight from TikTok's CDN (free). If the stored CDN link
// has expired, refresh it via the single-video lookup (1 credit).
export async function grabFrames(video: VideoForFrames, count = FRAME_COUNT): Promise<FramesResult> {
  let credits = 0;
  let mp4 = await fetchMp4(video.raw?.media?.play);
  if (!mp4 && video.url) {
    const res = await socialFetch.getVideo(video.url);
    credits += res.meta.creditsCharged ?? 0;
    const fresh = res.data.media?.downloadWithoutWatermarkUrl ?? res.data.media?.downloadUrl ?? null;
    mp4 = await fetchMp4(fresh);
    if (fresh) {
      await db()
        .from("videos")
        .update({ raw: { ...(video.raw ?? {}), media: { play: fresh, seenAt: new Date().toISOString() } } })
        .eq("id", video.id);
    }
  }
  if (mp4) return { frames: await extractFrames(mp4, video.duration_ms, count), credits };
  // Photo slideshows (and videos we can't fetch) fall back to the cached cover image.
  const cover = await coverImage(video.thumbnail_cached_path);
  if (cover) return { frames: [{ image: cover, atSeconds: null }], credits };
  throw new Error("Could not fetch video file or cover");
}

async function coverImage(path: string | null | undefined): Promise<Buffer | null> {
  if (!path) return null;
  const { data } = await db().storage.from(THUMB_BUCKET).download(path);
  return data ? Buffer.from(await data.arrayBuffer()) : null;
}

async function fetchMp4(url: string | null | undefined): Promise<Buffer | null> {
  if (!url) return null;
  try {
    const res = await fetch(url, { cache: "no-store" });
    if (!res.ok || !(res.headers.get("content-type") ?? "").includes("video")) return null;
    return Buffer.from(await res.arrayBuffer());
  } catch {
    return null;
  }
}

// One ffmpeg pass: `count` frames evenly spread over the video, scaled to 360px wide
// (Jev needs at least 280px per side).
async function extractFrames(mp4: Buffer, durationMs: number | null, count: number): Promise<Frame[]> {
  const dir = await mkdtemp(join(tmpdir(), "frames-"));
  try {
    const input = join(dir, "video.mp4");
    await writeFile(input, mp4);
    const seconds = Math.max(1, (durationMs ?? 10_000) / 1000);
    const step = seconds / count;
    await run(FFMPEG, [
      "-loglevel", "error",
      "-i", input,
      // Sample in the middle of each segment, so the first frame isn't a black/title card.
      "-vf", `fps=1/${step.toFixed(3)}:start_time=${(step / 2).toFixed(3)},scale=${FRAME_WIDTH}:-2`,
      "-frames:v", String(count),
      "-q:v", "5",
      join(dir, "f%03d.jpg"),
    ]);
    const files = (await readdir(dir)).filter((f) => f.endsWith(".jpg")).sort();
    if (!files.length) throw new Error("No frames could be extracted");
    return await Promise.all(
      files.map(async (f, i) => ({ image: await readFile(join(dir, f)), atSeconds: Math.round((step / 2 + i * step) * 10) / 10 })),
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
