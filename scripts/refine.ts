// Refine the fragments of an artist's best videos on the real mp4 (2 frames a second) and
// record the real resolution. Usage:
//   NODE_OPTIONS=--conditions=react-server npx tsx --env-file=.env.local scripts/refine.ts <artistId> [--limit N] [--force] [--ids a,b]
import { refineVideos } from "../src/lib/refine";

async function main() {
  const [artistId, ...flags] = process.argv.slice(2);
  const arg = (name: string) => (flags.includes(name) ? flags[flags.indexOf(name) + 1] : undefined);
  const results = await refineVideos(artistId, {
    limit: arg("--limit") ? Number(arg("--limit")) : undefined,
    force: flags.includes("--force"),
    videoIds: arg("--ids")?.split(","),
  });
  const fmt = (ss: { start_s: number; end_s: number; inpaint?: boolean }[]) =>
    ss.map((s) => `${s.start_s}-${s.end_s}${s.inpaint ? "🖌" : ""}`).join(" ") || "–";
  for (const r of results)
    console.log(r.error ? `${r.videoId} ERROR ${r.error}` : `${r.videoId} ${r.frames}f ${r.quality ?? "?"} ${r.effectiveHeight ?? "?"}px | ${fmt(r.before)}  →  ${fmt(r.after)}`);
  console.log(JSON.stringify({ videos: results.length, errors: results.filter((r) => r.error).length, credits: results.reduce((n, r) => n + (r.credits ?? 0), 0) }));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
