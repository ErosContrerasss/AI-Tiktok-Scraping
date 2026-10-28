// Score the current verdicts against a hand-labelled set in eval/ (see eval/README.md).
// "Predicted yes" = status relevant in video_status; with --footage it also needs usable
// fragments (video_segments.usable_seconds > 0). Unsure labels (null) are left out.
// Usage: NODE_OPTIONS=--conditions=react-server npx tsx --env-file=.env.local scripts/eval-labels.ts eval/<set>.json [--footage] [--list]
import { readFileSync } from "node:fs";
import { db } from "../src/lib/supabase";
import { chunks } from "../src/lib/util";

type LabelSet = { set: string; artist: string; labels: Record<string, boolean | null> };

async function main() {
  const [file, ...flags] = process.argv.slice(2);
  const set = JSON.parse(readFileSync(file, "utf8")) as LabelSet;
  const ids = Object.keys(set.labels);
  const status = new Map<string, { status: string; relevance: number | null; reason: string | null }>();
  const usable = new Map<string, number>();
  for (const chunk of chunks(ids, 200)) {
    const { data: st } = await db().from("video_status").select("id, status, relevance, reason").in("id", chunk);
    for (const r of st ?? []) status.set(r.id, r);
    const { data: seg } = await db().from("video_segments").select("video_id, usable_seconds").in("video_id", chunk);
    for (const r of seg ?? []) usable.set(r.video_id, r.usable_seconds);
  }
  let tp = 0, fp = 0, fn = 0, tn = 0, missing = 0;
  const rows: string[] = [];
  for (const id of ids) {
    const truth = set.labels[id];
    if (truth === null) continue;
    const s = status.get(id);
    if (!s) {
      missing++;
      continue;
    }
    const predicted = s.status === "relevant" && (!flags.includes("--footage") || (usable.get(id) ?? 0) > 0);
    if (truth && predicted) tp++;
    else if (!truth && predicted) fp++;
    else if (truth && !predicted) fn++;
    else tn++;
    if (truth !== predicted) rows.push(`${truth ? "gemist " : "onterecht"} ${id} ${s.status} ${s.relevance?.toFixed(2) ?? "-"} | ${(s.reason ?? "").slice(0, 100)}`);
  }
  const precision = tp + fp ? tp / (tp + fp) : 0;
  const recall = tp + fn ? tp / (tp + fn) : 0;
  console.log(`${set.set} (${set.artist}): tp ${tp} fp ${fp} fn ${fn} tn ${tn}${missing ? `, ${missing} niet meer in de database` : ""}`);
  console.log(`precision ${precision.toFixed(2)} · recall ${recall.toFixed(2)} · F1 ${(precision + recall ? (2 * precision * recall) / (precision + recall) : 0).toFixed(2)}`);
  if (flags.includes("--list")) for (const r of rows) console.log("  " + r);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
