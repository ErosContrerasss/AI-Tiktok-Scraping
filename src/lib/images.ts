import "server-only";
import { spawn } from "node:child_process";
import ffmpegStatic from "ffmpeg-static";

// Jev needs PNG/JPEG with both sides >= 280px: re-encode with ffmpeg (scale, optional crop).
export function ffmpegImage(data: Buffer, filter: string): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const p = spawn(ffmpegStatic ?? "ffmpeg", [
      "-loglevel", "error", "-i", "pipe:0", "-vf", filter, "-frames:v", "1", "-f", "image2", "-c:v", "mjpeg", "-q:v", "3", "pipe:1",
    ]);
    const out: Buffer[] = [];
    p.stdout.on("data", (d) => out.push(d));
    p.on("error", reject);
    p.on("close", (code) => (code === 0 ? resolve(Buffer.concat(out)) : reject(new Error(`ffmpeg exited ${code}`))));
    p.stdin.on("error", () => {}); // ffmpeg may close stdin early on bad input; the exit code reports it
    p.stdin.end(data);
  });
}

// Scale so the shorter side is `size` px (Jev rejects images with a side under 280px).
export const toJevImage = (data: Buffer, size = 360) =>
  ffmpegImage(data, `scale=w='if(lt(iw,ih),${size},-2)':h='if(lt(iw,ih),-2,${size})'`);

// Square crop around a box (fractions of width/height) with some margin, upscaled to 320px.
export function cropFace(data: Buffer, box: { top: number; bottom: number; left: number; right: number }): Promise<Buffer> {
  const margin = 0.35;
  const cx = (box.left + box.right) / 2;
  const cy = (box.top + box.bottom) / 2;
  const w = (box.right - box.left) * (1 + margin);
  const h = (box.bottom - box.top) * (1 + margin);
  const f = (n: number) => Math.min(1, Math.max(0, n)).toFixed(4);
  const x0 = f(cx - w / 2), y0 = f(cy - h / 2);
  return ffmpegImage(data, `crop=iw*${f(w)}:ih*${f(h)}:iw*${x0}:ih*${y0},scale=320:320:force_original_aspect_ratio=increase,crop=320:320`);
}
