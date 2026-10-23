// Remove stored frames of videos that aren't relevant or review (classifyArtist does this
// automatically after a vision run; this is for runs that predate it).
// Usage: NODE_OPTIONS=--conditions=react-server npx tsx --env-file=.env.local scripts/prune-frames.ts <artistId>
import { selectAll } from "../src/lib/classify";
import { pruneFrames } from "../src/lib/frames";
import type { Status } from "../src/lib/types";

async function main() {
  const [artistId] = process.argv.slice(2);
  const statuses = await selectAll<{ id: string; status: Status }>("video_status", "id, status", artistId);
  const keep = new Set(statuses.filter((s) => s.status === "relevant" || s.status === "review").map((s) => s.id));
  console.log(`keeping frames of ${keep.size} videos; removed ${await pruneFrames(artistId, keep)} frames`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
