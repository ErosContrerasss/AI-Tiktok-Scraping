/* eslint-disable @typescript-eslint/no-explicit-any -- evaluation script over loosely typed rows */
// Measure vision variants against hand-labelled ground truth ("is the artist on screen?").
// Frames are read from disk (saved by compare-frames.ts), so every variant sees the same input.
//
// Variants:
//   A  caption + 4 frames, no reference photos (classifyWithJev)
//   B  old reference photos (profile picture + covers) + 12 frames + caption as secondary
//   C  artist sheet as built automatically + 12 frames + caption as secondary
//   C* artist sheet minus the photos listed in --exclude (simulates reviewing the sheet in the UI)
//   V  artist sheet, frames only (no caption)
//
// Usage: NODE_OPTIONS=--conditions=react-server npx tsx --env-file=.env.local scripts/eval-vision.ts \
//          <artistId> <framesDir> <groundTruth.json> [--exclude 2,5,6]
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { classifyFramesWithJev, classifyWithJev } from "../src/lib/classify/jev";
import { applyRules } from "../src/lib/classify/rules";
import { loadReferences } from "../src/lib/references";
import { loadSheet } from "../src/lib/sheet";
import { db } from "../src/lib/supabase";
import type { Artist } from "../src/lib/types";
import { mapLimit } from "../src/lib/util";

const prob = (v: { is_about_artist: boolean; confidence: number }) => (v.is_about_artist ? v.confidence : 1 - v.confidence);

function metrics(rows: { truth: boolean; p: number }[], threshold: number) {
  const tp = rows.filter((r) => r.truth && r.p >= threshold).length;
  const fp = rows.filter((r) => !r.truth && r.p >= threshold).length;
  const fn = rows.filter((r) => r.truth && r.p < threshold).length;
  const precision = tp + fp ? tp / (tp + fp) : 0;
  const recall = tp + fn ? tp / (tp + fn) : 0;
  const f1 = precision + recall ? (2 * precision * recall) / (precision + recall) : 0;
  // AUC: chance that a random positive scores above a random negative (threshold-free).
  const pos = rows.filter((r) => r.truth), neg = rows.filter((r) => !r.truth);
  let wins = 0;
  for (const a of pos) for (const b of neg) wins += a.p > b.p ? 1 : a.p === b.p ? 0.5 : 0;
  return { precision, recall, f1, auc: pos.length && neg.length ? wins / (pos.length * neg.length) : 0, tp, fp, fn };
}

async function main() {
  const [artistId, framesDir, truthFile, ...rest] = process.argv.slice(2);
  const exclude = (rest[rest.indexOf("--exclude") + 1] ?? "").split(",").filter(Boolean).map(Number);
  const truth: Record<string, boolean | null> = JSON.parse(readFileSync(truthFile, "utf8"));
  const ids = Object.entries(truth).filter(([, t]) => t !== null).map(([id]) => id);

  const supabase = db();
  const { data: artist } = await supabase.from("artists").select("*").eq("id", artistId).single<Artist>();
  if (!artist) throw new Error("artist not found");
  const { data: posts } = await supabase
    .from("videos")
    .select("id, author_handle, caption, hashtags, sound_id, sound_title, sound_author")
    .in("id", ids);
  const sheet = await loadSheet(artist);
  const curated = sheet.filter((_, i) => !exclude.includes(i));
  const oldRefs = (await loadReferences(artist)).map((image) => ({ label: "reference", image }));
  console.log(`sheet ${sheet.length} photos, curated ${curated.length}, old references ${oldRefs.length}, labelled videos ${ids.length}`);

  const files = readdirSync(framesDir);
  const framesOf = (id: string) =>
    files
      .filter((f) => f.startsWith(`${id}_`) && f.endsWith(".jpg"))
      .sort()
      .map((f) => ({ image: readFileSync(join(framesDir, f)), atSeconds: null }));

  const variants: Record<string, (post: any, frames: { image: Buffer; atSeconds: null }[]) => Promise<number>> = {
    A: async (post, frames) => prob(await classifyWithJev(artist, { ...post, hints: applyRules(artist, post).hints }, [], [1, 4, 7, 10].map((i) => frames[i]?.image).filter(Boolean))),
    B: async (post, frames) => prob(await classifyFramesWithJev(oldRefs, frames, { artist, post })),
    C: async (post, frames) => prob(await classifyFramesWithJev(sheet, frames, { artist, post })),
    "C*": async (post, frames) => prob(await classifyFramesWithJev(curated, frames, { artist, post })),
    V: async (_post, frames) => prob(await classifyFramesWithJev(sheet, frames)),
  };

  const results: Record<string, { id: string; truth: boolean; p: number }[]> = {};
  for (const [name, run] of Object.entries(variants)) {
    if (name === "B" && !oldRefs.length) continue;
    results[name] = (
      await mapLimit(posts ?? [], 6, async (post) => {
        const frames = framesOf(post.id);
        if (!frames.length) return null;
        try {
          return { id: post.id, truth: truth[post.id] as boolean, p: await run(post, frames) };
        } catch (e) {
          console.error(name, post.id, (e as Error).message);
          return null;
        }
      })
    ).filter((r): r is { id: string; truth: boolean; p: number } => !!r);
  }

  console.log("\nvariant  n   precision  recall  F1    AUC   (threshold 0.7)   | at 0.5: precision recall");
  for (const [name, rows] of Object.entries(results)) {
    const m = metrics(rows, 0.7), h = metrics(rows, 0.5);
    console.log(
      `${name.padEnd(7)} ${String(rows.length).padStart(3)}   ${m.precision.toFixed(2)}       ${m.recall.toFixed(2)}    ${m.f1.toFixed(2)}  ${m.auc.toFixed(2)}  tp ${m.tp} fp ${m.fp} fn ${m.fn}   |  ${h.precision.toFixed(2)}  ${h.recall.toFixed(2)}`,
    );
  }
  writeFileSync(join(framesDir, "eval_results.json"), JSON.stringify(results, null, 1));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
