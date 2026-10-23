/* eslint-disable @typescript-eslint/no-explicit-any -- evaluation script over loosely typed rows */
// Compare Jev (text only) with the stored LLM verdicts on a stratified sample of one artist.
// Usage: NODE_OPTIONS=--conditions=react-server npx tsx --env-file=.env.local scripts/compare-classifiers.ts <artistId> [perBucket]
import { writeFileSync } from "node:fs";
import { classifyWithJev } from "../src/lib/classify/jev";
import { applyRules } from "../src/lib/classify/rules";
import { db } from "../src/lib/supabase";
import type { Artist } from "../src/lib/types";
import { mapLimit } from "../src/lib/util";

async function main() {
  const [artistId, perBucketArg] = process.argv.slice(2);
  const perBucket = Number(perBucketArg ?? 100);
  const supabase = db();
  const { data: artist } = await supabase.from("artists").select("*").eq("id", artistId).single<Artist>();
  if (!artist) throw new Error("artist not found");

  const sample: any[] = [];
  for (const status of ["relevant", "review", "unrelated"]) {
    const { data } = await supabase
      .from("video_status")
      .select("id, status, relevance, layer, content_type, author_handle, caption, hashtags, sound_id, sound_title, sound_author")
      .eq("artist_id", artistId)
      .eq("status", status)
      .eq("layer", "llm")
      .limit(2000);
    const rows = (data ?? []).sort(() => Math.random() - 0.5).slice(0, perBucket);
    sample.push(...rows);
  }

  const results = await mapLimit(sample, 8, async (v) => {
    const { hints } = applyRules(artist, v);
    const t = Date.now();
    const jev = await classifyWithJev(artist, { ...v, hints }, []);
    const p = jev.is_about_artist ? jev.confidence : 1 - jev.confidence;
    return { ...v, llm_p: v.relevance, jev_p: p, jev_type: jev.content_type, ms: Date.now() - t };
  });

  const bucket = (p: number, hi: number, lo: number) => (p >= hi ? "relevant" : p <= lo ? "unrelated" : "review");
  for (const [hi, lo] of [[0.85, 0.3], [0.7, 0.3]]) {
    const m: Record<string, number> = {};
    for (const r of results) {
      const k = `${r.status} -> ${bucket(r.jev_p, hi, lo)}`;
      m[k] = (m[k] ?? 0) + 1;
    }
    console.log(`\nLLM status -> Jev status (Jev thresholds ${hi}/${lo})`);
    console.table(m);
  }
  const ms = results.map((r) => r.ms).sort((a, b) => a - b);
  console.log("latency ms p50/p90:", ms[Math.floor(ms.length / 2)], ms[Math.floor(ms.length * 0.9)]);
  writeFileSync(process.argv[4] ?? "compare.json", JSON.stringify(results, null, 1));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
