// Pick reference photos for an artist from the covers of their own posts.
// Usage: NODE_OPTIONS=--conditions=react-server npx tsx --env-file=.env.local scripts/build-references.ts <artistId> [outDir]
import { mkdirSync, writeFileSync } from "node:fs";
import { buildReferences, loadReferences } from "../src/lib/references";
import { db } from "../src/lib/supabase";
import type { Artist } from "../src/lib/types";

async function main() {
  const [artistId, outDir] = process.argv.slice(2);
  const { data: artist } = await db().from("artists").select("*").eq("id", artistId).single<Artist>();
  if (!artist) throw new Error("artist not found");
  const t = Date.now();
  const result = await buildReferences(artist);
  console.log({ ...result, ms: Date.now() - t });
  if (outDir) {
    mkdirSync(outDir, { recursive: true });
    const refs = await loadReferences({ ...artist, reference_images: result.paths });
    refs.forEach((r, i) => writeFileSync(`${outDir}/ref_${i}.jpg`, r));
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
