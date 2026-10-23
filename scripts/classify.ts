// Run classification for one artist from the command line (no HTTP timeouts on long runs).
// Usage: NODE_OPTIONS=--conditions=react-server npx tsx --env-file=.env.local scripts/classify.ts <artistId> [--vision] [--force-vision] [--limit N]
import { classifyArtist } from "../src/lib/classify";

async function main() {
  const [artistId, ...flags] = process.argv.slice(2);
  const limitIdx = flags.indexOf("--limit");
  const t = Date.now();
  const stats = await classifyArtist(artistId, {
    vision: flags.includes("--vision"),
    forceVision: flags.includes("--force-vision"),
    visionLimit: limitIdx >= 0 ? Number(flags[limitIdx + 1]) : undefined,
  });
  console.log(JSON.stringify({ ...stats, minutes: ((Date.now() - t) / 60000).toFixed(1) }, null, 1));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
