// Find look-alikes of an artist automatically and check the usable videos again with both
// photo sets side by side. Usage:
//   NODE_OPTIONS=--conditions=react-server npx tsx --env-file=.env.local scripts/lookalikes.ts <artistId>
import { runLookalikes } from "../src/lib/lookalikes";

async function main() {
  const [artistId] = process.argv.slice(2);
  const t = Date.now();
  const stats = await runLookalikes(artistId);
  console.log(JSON.stringify({ ...stats, minutes: ((Date.now() - t) / 60000).toFixed(1) }, null, 1));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
