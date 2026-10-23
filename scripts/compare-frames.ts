/* eslint-disable @typescript-eslint/no-explicit-any -- evaluation script over loosely typed rows */
// Compare Jev variants on a stratified sample of one artist and save frames for manual review:
// text only, caption + 4 frames, and frames-first (reference photos + 12 frames, no captions).
// Usage: NODE_OPTIONS=--conditions=react-server npx tsx --env-file=.env.local scripts/compare-frames.ts <artistId> <perBucket> <outDir> [idsFile]
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { classifyFramesWithJev, classifyWithJev } from "../src/lib/classify/jev";
import { applyRules } from "../src/lib/classify/rules";
import { grabFrames } from "../src/lib/frames";
import { loadReferences } from "../src/lib/references";
import { db } from "../src/lib/supabase";
import type { Artist } from "../src/lib/types";
import { mapLimit } from "../src/lib/util";

const prob = (v: { is_about_artist: boolean; confidence: number }) => (v.is_about_artist ? v.confidence : 1 - v.confidence);

async function main() {
  const [artistId, perBucketArg, outDir, idsFile] = process.argv.slice(2);
  mkdirSync(outDir, { recursive: true });
  const supabase = db();
  const { data: artist } = await supabase.from("artists").select("*").eq("id", artistId).single<Artist>();
  if (!artist) throw new Error("artist not found");
  const refs = await loadReferences(artist);
  if (!refs.length) throw new Error("no reference photos; run scripts/build-references.ts first");

  // Reuse an earlier sample when given, so results stay comparable.
  let picks: { id: string; status: string }[];
  if (idsFile && existsSync(idsFile)) {
    picks = JSON.parse(readFileSync(idsFile, "utf8")).map((r: { id: string; status: string }) => ({ id: r.id, status: r.status }));
  } else {
    picks = [];
    for (const status of ["relevant", "review", "unrelated"]) {
      const { data } = await supabase.from("video_status").select("id").eq("artist_id", artistId).eq("status", status).limit(2000);
      picks.push(...(data ?? []).sort(() => Math.random() - 0.5).slice(0, Number(perBucketArg)).map((r) => ({ id: r.id, status })));
    }
  }
  const { data: rows } = await supabase
    .from("videos")
    .select("id, url, duration_ms, raw, thumbnail_cached_path, author_handle, caption, hashtags, sound_id, sound_title, sound_author")
    .in("id", picks.map((p) => p.id));

  let credits = 0;
  const results = await mapLimit(rows ?? [], 4, async (v) => {
    const status = picks.find((p) => p.id === v.id)!.status;
    try {
      const { hints } = applyRules(artist, v);
      const { frames, credits: c } = await grabFrames(v, 12);
      credits += c;
      frames.forEach((f, i) => writeFileSync(`${outDir}/${v.id}_${String(i).padStart(2, "0")}.jpg`, f.image));
      const four = [1, 4, 7, 10].map((i) => frames[i]?.image).filter(Boolean) as Buffer[];
      const t0 = Date.now();
      const visual = await classifyFramesWithJev(refs.map((image) => ({ label: "reference", image })), frames, { artist, post: v });
      const visualMs = Date.now() - t0;
      const [text, captionFrames] = await Promise.all([
        classifyWithJev(artist, { ...v, hints }, []),
        classifyWithJev(artist, { ...v, hints }, [], four),
      ]);
      return {
        id: v.id, status, author: v.author_handle, caption: (v.caption ?? "").slice(0, 90),
        text_p: prob(text), caption4_p: prob(captionFrames), visual_p: prob(visual),
        visual_type: visual.content_type, visual_reason: visual.reason, visual_ms: visualMs, frames: frames.length,
      };
    } catch (e) {
      return { id: v.id, status, error: (e as Error).message };
    }
  });
  writeFileSync(`${outDir}/results.json`, JSON.stringify(results, null, 1));
  console.log("credits used for link refresh:", credits);
  for (const st of ["relevant", "review", "unrelated"]) {
    const rs = results.filter((r: any) => r.status === st && r.visual_p != null) as any[];
    const avg = (k: string) => (rs.reduce((n, r) => n + r[k], 0) / rs.length).toFixed(2);
    const hi = (k: string) => rs.filter((r) => r[k] >= 0.7).length;
    console.log(`${st.padEnd(10)} n=${rs.length} | avg text ${avg("text_p")} caption+4 ${avg("caption4_p")} visual ${avg("visual_p")} | >=0.7: text ${hi("text_p")} caption+4 ${hi("caption4_p")} visual ${hi("visual_p")}`);
  }
  const ms = (results as any[]).filter((r) => r.visual_ms).map((r) => r.visual_ms).sort((a, b) => a - b);
  console.log("visual latency ms p50/p90:", ms[Math.floor(ms.length / 2)], ms[Math.floor(ms.length * 0.9)]);
  console.log("errors:", (results as any[]).filter((r) => r.error).map((r) => r.error).slice(0, 5));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
