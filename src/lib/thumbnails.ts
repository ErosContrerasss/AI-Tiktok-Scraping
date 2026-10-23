import "server-only";
import convert from "heic-convert";
import { BUCKETS, media } from "./media";

// TikTok serves many covers as HEIC, which Chrome/Firefox can't render. Convert to JPEG.

function isHeic(data: Buffer, contentType: string): boolean {
  if (/heic|heif/i.test(contentType)) return true;
  const brand = data.subarray(4, 12).toString("ascii"); // ISO-BMFF "ftyp" + major brand
  return brand.startsWith("ftyp") && /heic|heix|mif1|msf1|hevc/.test(brand.slice(4));
}

export async function toBrowserImage(data: Buffer, contentType: string): Promise<{ data: Buffer; contentType: string; ext: string }> {
  if (isHeic(data, contentType)) {
    const jpeg = await convert({ buffer: data, format: "JPEG", quality: 0.85 });
    return { data: Buffer.from(jpeg), contentType: "image/jpeg", ext: "jpg" };
  }
  if (contentType.includes("webp")) return { data, contentType, ext: "webp" };
  if (contentType.includes("png")) return { data, contentType, ext: "png" };
  return { data, contentType: "image/jpeg", ext: "jpg" };
}

export async function cacheThumbnail(artistId: string, videoId: string, url: string): Promise<string | null> {
  try {
    const res = await fetch(url, { cache: "no-store" });
    if (!res.ok) return null;
    const image = await toBrowserImage(Buffer.from(await res.arrayBuffer()), res.headers.get("content-type") ?? "");
    const path = `${artistId}/${videoId}.${image.ext}`;
    for (let attempt = 0; attempt < 2; attempt++) {
      if (await media().put(BUCKETS.thumbnails, path, image.data, image.contentType)) return path;
    }
    return null;
  } catch {
    return null;
  }
}
