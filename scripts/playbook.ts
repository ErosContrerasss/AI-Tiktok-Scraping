// Break down an artist's outlier videos and build a blueprint per format.
// Usage: NODE_OPTIONS=--conditions=react-server npx tsx --env-file=.env.local scripts/playbook.ts <artistId> [--limit N] [--min-examples N]
import { buildPlaybook } from "../src/lib/playbook";

async function main() {
  const [artistId, ...flags] = process.argv.slice(2);
  const arg = (name: string) => (flags.includes(name) ? Number(flags[flags.indexOf(name) + 1]) : undefined);
  const t = Date.now();
  const stats = await buildPlaybook(artistId, { limit: arg("--limit"), minExamples: arg("--min-examples") });
  console.log(JSON.stringify({ ...stats, minutes: ((Date.now() - t) / 60000).toFixed(1) }, null, 1));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
