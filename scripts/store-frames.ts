// Extract and store frames for an artist's usable videos that have none stored (e.g. checked
// before frames were kept). Expired TikTok links cost 1 credit each to refresh.
// Usage: NODE_OPTIONS=--conditions=react-server npx tsx --env-file=.env.local scripts/store-frames.ts <artistId>
import { selectAll } from "../src/lib/classify";
import { grabFrames, loadStoredFrames } from "../src/lib/frames";
import { db } from "../src/lib/supabase";
import type { Status } from "../src/lib/types";
import { chunks, mapLimit } from "../src/lib/util";

async function main() {
  const [artistId] = process.argv.slice(2);
  const usable = (await selectAll<{ id: string; status: Status }>("video_status", "id, status", artistId)).filter((s) => s.status === "relevant");
  const missing: string[] = [];
  await mapLimit(usable, 8, async (v) => {
    if (!(await loadStoredFrames(artistId, v.id)).length) missing.push(v.id);
  });
  let credits = 0, stored = 0, failed = 0;
  for (const chunk of chunks(missing, 100)) {
    const { data } = await db().from("videos").select("id, artist_id, url, duration_ms, raw, thumbnail_cached_path").in("id", chunk);
    await mapLimit(data ?? [], 6, async (v) => {
      try {
        const r = await grabFrames(v);
        credits += r.credits;
        if (r.frames.length > 1) stored++;
        else failed++;
      } catch {
        failed++;
      }
    });
  }
  console.log(JSON.stringify({ usable: usable.length, missing: missing.length, stored, failed, credits }));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
