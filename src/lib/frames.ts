import "server-only";
import { execFile } from "node:child_process";
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import ffmpegStatic from "ffmpeg-static";
import { socialFetch } from "./socialfetch";
import { BUCKETS, media } from "./media";
import { db } from "./supabase";

const run = promisify(execFile);
const FFMPEG = ffmpegStatic ?? "ffmpeg";
const FRAME_SIDE = 360;
export const FRAME_COUNT = Number(process.env.FRAME_COUNT ?? 12);

export type Frame = { image: Buffer; atSeconds: number | null };

type VideoForFrames = {
  id: string;
  artist_id?: string;
  url: string | null;
  duration_ms: number | null;
  thumbnail_cached_path?: string | null;
  raw: { media?: { play?: string | null } } | null;
};

export type FramesResult = { frames: Frame[]; credits: number; stored: boolean };

// Frames are extracted once and kept in Storage ({artist_id}/{video_id}/{nn}_{seconds}.jpg),
// so re-classifying never needs TikTok's expiring video links again. First extraction: the
// mp4 comes straight from TikTok's CDN (free); an expired link is refreshed via the
// single-video lookup (1 credit).
export async function grabFrames(video: VideoForFrames, count = FRAME_COUNT): Promise<FramesResult> {
  const stored = video.artist_id ? await loadStoredFrames(video.artist_id, video.id) : [];
  if (stored.length >= count) return { frames: pickEvenly(stored, count), credits: 0, stored: true };

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
  if (mp4) {
    const frames = await extractFrames(mp4, video.duration_ms, Math.max(count, FRAME_COUNT));
    if (video.artist_id) await storeFrames(video.artist_id, video.id, frames);
    return { frames: pickEvenly(frames, count), credits, stored: false };
  }
  // Photo slideshows (and videos we can't fetch) fall back to the cached cover image.
  const cover = await coverImage(video.thumbnail_cached_path);
  if (cover) return { frames: [{ image: cover, atSeconds: null }], credits, stored: false };
  throw new Error("Could not fetch video file or cover");
}

function pickEvenly<T>(items: T[], count: number): T[] {
  if (items.length <= count) return items;
  return Array.from({ length: count }, (_, i) => items[Math.floor((i * items.length) / count)]);
}

async function loadStoredFrames(artistId: string, videoId: string): Promise<Frame[]> {
  const folder = `${artistId}/${videoId}`;
  const names = await media().list(BUCKETS.frames, folder);
  if (!names.length) return [];
  const frames = await Promise.all(
    names.map(async (name): Promise<Frame | null> => {
      const image = await media().get(BUCKETS.frames, `${folder}/${name}`);
      const seconds = Number(name.replace(/\.jpg$/, "").split("_")[1]);
      return image ? { image, atSeconds: Number.isFinite(seconds) ? seconds : null } : null;
    }),
  );
  return frames.filter((f): f is Frame => !!f);
}

async function storeFrames(artistId: string, videoId: string, frames: Frame[]) {
  await Promise.all(
    frames.map((f, i) =>
      media().put(BUCKETS.frames, `${artistId}/${videoId}/${String(i).padStart(2, "0")}_${f.atSeconds ?? "na"}.jpg`, f.image, "image/jpeg"),
    ),
  );
}

async function coverImage(path: string | null | undefined): Promise<Buffer | null> {
  return path ? media().get(BUCKETS.thumbnails, path) : null;
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

// One ffmpeg pass: `count` frames evenly spread over the video, shortest side scaled to
// 360px (Jev needs at least 280px per side; landscape videos scaled by width fell below that).
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
      "-vf", `fps=1/${step.toFixed(3)}:start_time=${(step / 2).toFixed(3)},scale='if(gt(iw,ih),-2,${FRAME_SIDE})':'if(gt(iw,ih),${FRAME_SIDE},-2)'`,
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

// Frames only earn their storage for videos we keep (relevant + review). After vision has
// judged a video unrelated, its frames go; a human thumbs-up later simply re-extracts them.
export async function pruneFrames(artistId: string, keepIds: Set<string>): Promise<number> {
  const folders = await media().list(BUCKETS.frames, artistId);
  const drop = folders.filter((videoId) => !keepIds.has(videoId));
  let removed = 0;
  await Promise.all(
    drop.map(async (videoId) => {
      const names = await media().list(BUCKETS.frames, `${artistId}/${videoId}`);
      await media().remove(BUCKETS.frames, names.map((n) => `${artistId}/${videoId}/${n}`));
      removed += names.length;
    }),
  );
  return removed;
}
