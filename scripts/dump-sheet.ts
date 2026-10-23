// Save an artist's sheet as one contact sheet image for review.
// Usage: NODE_OPTIONS=--conditions=react-server npx tsx --env-file=.env.local scripts/dump-sheet.ts <artistId> <outDir>
import { mkdirSync, writeFileSync } from "node:fs";
import { loadSheet } from "../src/lib/sheet";
import { db } from "../src/lib/supabase";
import type { Artist } from "../src/lib/types";

async function main() {
  const [id, out] = process.argv.slice(2);
  mkdirSync(out, { recursive: true });
  const { data: artist } = await db().from("artists").select("*").eq("id", id).single<Artist>();
  if (!artist) throw new Error("artist not found");
  (await loadSheet(artist)).forEach((s, i) => writeFileSync(`${out}/${i}_${s.label}.jpg`, s.image));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
