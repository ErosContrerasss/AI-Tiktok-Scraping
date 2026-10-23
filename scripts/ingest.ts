// Run an ingest from the command line (no HTTP timeouts on long runs).
// Usage: NODE_OPTIONS=--conditions=react-server npx tsx --env-file=.env.local scripts/ingest.ts <artistId> [--refresh] [--max-pages N]
import { ingestArtist } from "../src/lib/ingest";

async function main() {
  const [artistId, ...flags] = process.argv.slice(2);
  const maxIdx = flags.indexOf("--max-pages");
  const t = Date.now();
  const stats = await ingestArtist(artistId, {
    mode: flags.includes("--refresh") ? "refresh" : "full",
    maxPages: maxIdx >= 0 ? Number(flags[maxIdx + 1]) : undefined,
  });
  const { tasks, ...summary } = stats;
  console.log(JSON.stringify({ ...summary, failedTasks: tasks.filter((x) => x.error).length, minutes: ((Date.now() - t) / 60000).toFixed(1) }, null, 1));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
