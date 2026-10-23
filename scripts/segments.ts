// Find usable fragments (artist on screen, no overlaid text, no black frames) in an artist's
// usable videos. Usage: NODE_OPTIONS=--conditions=react-server npx tsx --env-file=.env.local scripts/segments.ts <artistId> [--force]
import { segmentArtist } from "../src/lib/segments";

async function main() {
  const [artistId, ...flags] = process.argv.slice(2);
  const t = Date.now();
  const stats = await segmentArtist(artistId, { force: flags.includes("--force") });
  console.log(JSON.stringify({ ...stats, minutes: ((Date.now() - t) / 60000).toFixed(1) }, null, 1));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
