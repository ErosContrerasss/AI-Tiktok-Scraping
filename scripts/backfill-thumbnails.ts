// Re-encode cached HEIC thumbnails to JPEG and retry thumbnails that were never cached.
// Usage: NODE_OPTIONS=--conditions=react-server npx tsx --env-file=.env.local scripts/backfill-thumbnails.ts
import { db, THUMB_BUCKET } from "../src/lib/supabase";
import { cacheThumbnail, toBrowserImage } from "../src/lib/thumbnails";
import { mapLimit } from "../src/lib/util";

async function main() {
  const supabase = db();
  const { data: videos, error } = await supabase
    .from("videos")
    .select("id, artist_id, thumbnail_url, thumbnail_cached_path")
    .limit(10000);
  if (error) throw error;

  let converted = 0;
  let recached = 0;
  let failed = 0;
  await mapLimit(videos ?? [], 6, async (v) => {
    if (v.thumbnail_cached_path) {
      const { data: blob } = await supabase.storage.from(THUMB_BUCKET).download(v.thumbnail_cached_path);
      if (!blob) return;
      const original = Buffer.from(await blob.arrayBuffer());
      const image = await toBrowserImage(original, blob.type);
      if (image.data === original) return; // already browser-friendly
      const { error: upErr } = await supabase.storage
        .from(THUMB_BUCKET)
        .upload(v.thumbnail_cached_path, image.data, { contentType: image.contentType, upsert: true });
      if (upErr) failed++;
      else converted++;
    } else if (v.thumbnail_url) {
      const path = await cacheThumbnail(v.artist_id, v.id, v.thumbnail_url);
      if (path) {
        await supabase.from("videos").update({ thumbnail_cached_path: path }).eq("id", v.id);
        recached++;
      } else failed++;
    }
  });
  console.log({ total: videos?.length, converted, recached, failed });
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
