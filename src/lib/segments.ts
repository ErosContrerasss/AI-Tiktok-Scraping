import "server-only";
import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import ffmpegStatic from "ffmpeg-static";
import { selectAll } from "./classify";
import { textLevelsWithJev } from "./classify/jev";
import { ffmpegImage, toJevImage } from "./images";
import { loadStoredFrames, type Frame } from "./frames";
import { db } from "./supabase";
import type { Status } from "./types";
import { chunks, mapLimit } from "./util";

// Usable fragments for redistribution: stretches of a usable video where the artist is on
// screen (artist_p >= 0.7), nothing is overlaid (text level < 1.25: at most a small corner
// watermark) and the picture isn't black. Built from the per-frame results of the frames
// check plus a pixel check of the stored frames, which also measures black bars so they can
// be cropped away. Reposts of landscape video often carry their caption only in the black bar:
// for videos with bars, the text is measured again on the cropped frames. Resolution is one frame per 1/12 of the video: fine for selecting, and
// cut points get refined when the clip is downloaded.

const run = promisify(execFile);
const FFMPEG = ffmpegStatic ?? "ffmpeg";

const ARTIST_MIN = 0.7;
const TEXT_MAX = 1.25; // TEXT_LEVELS 0-3 as expected value: < 1.25 = clean or a corner watermark
const BLACK_YAVG = 16; // mean luma below this = black frame
const MIN_SEGMENT_S = 2;
const BARS_MAX_CONTENT = 0.9; // content area under 90% of the height or width = black bars

export type Segment = { start_s: number; end_s: number; artist_p: number };
type Crop = { x: number; y: number; w: number; h: number };
type FrameResult = { at_seconds: number | null; artist_p: number; text_level: number };
type Pixels = { yavg: number; crop: Crop | null };

// One ffmpeg pass over the stored frames: mean luma and the non-black content box per frame.
async function pixelCheck(frames: Frame[]): Promise<{ pixels: Pixels[]; aspect: number | null }> {
  const dir = await mkdtemp(join(tmpdir(), "seg-"));
  try {
    await Promise.all(frames.map((f, i) => writeFile(join(dir, `${String(i).padStart(2, "0")}.jpg`), f.image)));
    const { stderr } = await run(FFMPEG, [
      "-hide_banner", "-i", join(dir, "%02d.jpg"),
      "-vf", "cropdetect=limit=24:round=2:reset=1:skip=0,signalstats,metadata=print",
      "-f", "null", "-",
    ], { maxBuffer: 16 * 1024 * 1024 });
    const out: Pixels[] = [];
    const size = parseSize(stderr);
    for (const block of stderr.split(/frame:\d+\s/).slice(1)) {
      const num = (key: string) => Number(block.match(new RegExp(`${key}=([0-9.]+)`))?.[1]);
      const [cw, ch, cx, cy] = ["lavfi.cropdetect.w", "lavfi.cropdetect.h", "lavfi.cropdetect.x", "lavfi.cropdetect.y"].map(num);
      out.push({
        yavg: num("lavfi.signalstats.YAVG"),
        crop: size && Number.isFinite(cw) ? { x: cx / size.w, y: cy / size.h, w: cw / size.w, h: ch / size.h } : null,
      });
    }
    return { pixels: out, aspect: size ? Math.round((size.w / size.h) * 100) / 100 : null };
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

// The part of the picture that changes between frames: the real video. Bars, and captions or
// emojis printed on them, stay still. Returns a box as fractions, or null when everything moves.
export async function motionBox(frames: Frame[]): Promise<Crop | null> {
  if (frames.length < 4) return null;
  const W = 72;
  const H = 128;
  const dir = await mkdtemp(join(tmpdir(), "mot-"));
  try {
    await Promise.all(frames.map((f, i) => writeFile(join(dir, `${String(i).padStart(2, "0")}.jpg`), f.image)));
    const { stdout } = await run(
      FFMPEG,
      ["-loglevel", "error", "-i", join(dir, "%02d.jpg"), "-vf", `scale=${W}:${H},format=gray`, "-f", "rawvideo", "-"],
      { encoding: "buffer", maxBuffer: 64 * 1024 * 1024 },
    );
    const raw = stdout as unknown as Buffer;
    const n = Math.floor(raw.length / (W * H));
    if (n < 4) return null;
    // Mean absolute deviation over time, per pixel, then averaged per row and per column.
    const rows = new Array(H).fill(0);
    const cols = new Array(W).fill(0);
    for (let y = 0; y < H; y++)
      for (let x = 0; x < W; x++) {
        let mean = 0;
        for (let k = 0; k < n; k++) mean += raw[k * W * H + y * W + x];
        mean /= n;
        let dev = 0;
        for (let k = 0; k < n; k++) dev += Math.abs(raw[k * W * H + y * W + x] - mean);
        dev /= n;
        rows[y] += dev / W;
        cols[x] += dev / H;
      }
    const span = (xs: number[]) => {
      const t = Math.max(4, 0.25 * Math.max(...xs));
      const first = xs.findIndex((v) => v > t);
      const last = xs.length - 1 - [...xs].reverse().findIndex((v) => v > t);
      return first < 0 ? null : { start: first / xs.length, size: (last + 1 - first) / xs.length };
    };
    const r = span(rows);
    const c = span(cols);
    if (!r || !c || (r.size >= BARS_MAX_CONTENT && c.size >= BARS_MAX_CONTENT)) return null;
    return { x: c.start, y: r.start, w: c.size, h: r.size };
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

function parseSize(stderr: string): { w: number; h: number } | null {
  const m = stderr.match(/Stream #0:0.*?, (\d{2,5})x(\d{2,5})/);
  return m ? { w: Number(m[1]), h: Number(m[2]) } : null;
}

// Real bars sit at exactly the same place in every frame; a dark stage moves with the
// lights. So bars count only when at least 75% of the frames show the same content box.
function commonCrop(pixels: Pixels[]): Crop | null {
  const crops = pixels.map((p) => p.crop).filter((c): c is Crop => !!c);
  if (!crops.length) return null;
  const median = (xs: number[]) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)];
  const m = { x: median(crops.map((c) => c.x)), y: median(crops.map((c) => c.y)), w: median(crops.map((c) => c.w)), h: median(crops.map((c) => c.h)) };
  if (m.h >= BARS_MAX_CONTENT && m.w >= BARS_MAX_CONTENT) return null;
  const same = crops.filter((c) => Math.abs(c.x - m.x) < 0.02 && Math.abs(c.y - m.y) < 0.02 && Math.abs(c.w - m.w) < 0.02 && Math.abs(c.h - m.h) < 0.02);
  return same.length >= 0.75 * pixels.length ? m : null;
}

export function findSegments(results: FrameResult[], pixels: (Pixels | undefined)[], durationS: number): Segment[] {
  const step = durationS / Math.max(results.length, 1);
  const segments: Segment[] = [];
  let current: { start: number; end: number; ps: number[] } | null = null;
  results.forEach((f, i) => {
    const at = f.at_seconds ?? step * (i + 0.5);
    const ok = f.artist_p >= ARTIST_MIN && f.text_level < TEXT_MAX && (pixels[i]?.yavg ?? 255) >= BLACK_YAVG;
    if (ok) {
      const start = Math.max(0, at - step / 2);
      const end = Math.min(durationS, at + step / 2);
      if (current) {
        current.end = end;
        current.ps.push(f.artist_p);
      } else current = { start, end, ps: [f.artist_p] };
    } else if (current) {
      segments.push(toSegment(current));
      current = null;
    }
  });
  if (current) segments.push(toSegment(current));
  return segments.filter((s) => s.end_s - s.start_s >= MIN_SEGMENT_S);
}

const toSegment = (c: { start: number; end: number; ps: number[] }): Segment => ({
  start_s: Math.round(c.start * 10) / 10,
  end_s: Math.round(c.end * 10) / 10,
  artist_p: Math.round((c.ps.reduce((a, b) => a + b, 0) / c.ps.length) * 100) / 100,
});

// Text level of each stored frame after cropping to the content area (one Jev request).
async function textAfterCrop(stored: Frame[], crop: Crop): Promise<number[]> {
  const filter = `crop=iw*${crop.w.toFixed(4)}:ih*${crop.h.toFixed(4)}:iw*${crop.x.toFixed(4)}:ih*${crop.y.toFixed(4)}`;
  const cropped = await Promise.all(stored.map(async (f) => toJevImage(await ffmpegImage(f.image, filter))));
  return textLevelsWithJev(cropped);
}

export type SegmentStats = {
  videos: number;
  withSegments: number;
  segments: number;
  cleanMinutes: number;
  withBars: number;
  recropped: number; // videos whose text was re-measured after cropping the bars
  skipped: number;
};

export async function segmentArtist(artistId: string, opts: { force?: boolean } = {}): Promise<SegmentStats> {
  const supabase = db();
  const statuses = await selectAll<{ id: string; status: Status; content_type: string | null; duration_ms: number | null }>(
    "video_status",
    "id, status, content_type, duration_ms",
    artistId,
  );
  const usable = statuses.filter((s) => s.status === "relevant");

  const done = new Set<string>();
  if (!opts.force) {
    for (const chunk of chunks(usable.map((v) => v.id), 300)) {
      const { data } = await supabase.from("video_segments").select("video_id").in("video_id", chunk);
      for (const r of data ?? []) done.add(r.video_id);
    }
  }
  const todo = usable.filter((v) => !done.has(v.id));

  const details = new Map<string, FrameResult[]>();
  for (const chunk of chunks(todo.map((v) => v.id), 200)) {
    const { data } = await supabase
      .from("classifications")
      .select("video_id, details, created_at")
      .eq("layer", "vision")
      .not("details", "is", null)
      .in("video_id", chunk)
      .order("created_at", { ascending: false });
    for (const c of data ?? []) if (!details.has(c.video_id)) details.set(c.video_id, c.details.frames);
  }

  const stats: SegmentStats = { videos: 0, withSegments: 0, segments: 0, cleanMinutes: 0, withBars: 0, recropped: 0, skipped: 0 };
  await mapLimit(todo, 6, async (v) => {
    const results = details.get(v.id);
    if (!results?.length || !v.duration_ms) {
      stats.skipped++;
      return;
    }
    const stored = await loadStoredFrames(artistId, v.id);
    const checked = stored.length ? await pixelCheck(stored).catch(() => null) : null;
    const durationS = v.duration_ms / 1000;
    // Line the stored frames up with the per-frame results by timestamp (counts can differ).
    const storedIndex = results.map((r, i) =>
      r.at_seconds != null && stored.length && stored.every((s) => s.atSeconds != null)
        ? stored.reduce((best, s, k) => (Math.abs(s.atSeconds! - r.at_seconds!) < Math.abs(stored[best].atSeconds! - r.at_seconds!) ? k : best), 0)
        : Math.min(stored.length - 1, Math.round((i * stored.length) / results.length)),
    );
    // Fixed bars (cropdetect) narrowed to the moving picture, which leaves captions on the bars out.
    const bars = checked?.pixels.length ? commonCrop(checked.pixels) : null;
    const crop = bars ? ((await motionBox(stored).catch(() => null)) ?? bars) : null;
    // With bars, mean luma covers the black bars too: judge the content area only.
    const area = crop ? crop.w * crop.h : 1;
    const pixels = storedIndex.map((j) => {
      const p = checked?.pixels[j];
      return p ? { ...p, yavg: p.yavg / area } : undefined;
    });
    // Bars that held the caption: what's left after cropping may well be clean.
    let measured = results;
    if (crop && results.some((r) => r.text_level >= TEXT_MAX)) {
      const after = await textAfterCrop(stored, crop).catch(() => null);
      if (after) {
        measured = results.map((r, i) => ({ ...r, text_level: Math.min(r.text_level, after[storedIndex[i]] ?? r.text_level) }));
        stats.recropped++;
      }
    }
    const segments = findSegments(measured, pixels, durationS);
    const cleanSeconds = Math.round(segments.reduce((n, s) => n + s.end_s - s.start_s, 0) * 10) / 10;
    await supabase.from("video_segments").upsert({
      video_id: v.id,
      artist_id: artistId,
      duration_s: durationS,
      clean_seconds: cleanSeconds,
      segments,
      crop,
      aspect: checked?.aspect ?? null,
      is_edit: v.content_type === "fan_edit",
      analysed_at: new Date().toISOString(),
    });
    stats.videos++;
    if (segments.length) stats.withSegments++;
    if (crop) stats.withBars++;
    stats.segments += segments.length;
    stats.cleanMinutes += cleanSeconds / 60;
  });
  stats.cleanMinutes = Math.round(stats.cleanMinutes);
  return stats;
}
