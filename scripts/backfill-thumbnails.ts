// Re-encode cached HEIC thumbnails to JPEG and retry thumbnails that were never cached.
// Usage: NODE_OPTIONS=--conditions=react-server npx tsx --env-file=.env.local scripts/backfill-thumbnails.ts
import { BUCKETS, media } from "../src/lib/media";
import { db } from "../src/lib/supabase";
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
      const original = await media().get(BUCKETS.thumbnails, v.thumbnail_cached_path);
      if (!original) return;
      const image = await toBrowserImage(original, ""); // format is sniffed from the bytes
      if (image.data === original) return; // already browser-friendly
      if (await media().put(BUCKETS.thumbnails, v.thumbnail_cached_path, image.data, image.contentType)) converted++;
      else failed++;
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
