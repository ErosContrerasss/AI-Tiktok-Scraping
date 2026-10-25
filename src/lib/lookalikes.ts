import "server-only";
import { z } from "zod";
import { selectAll } from "./classify";
import { whoIsOnScreenWithJev } from "./classify/jev";
import { loadStoredFrames } from "./frames";
import { toJevImage } from "./images";
import { generateStructured } from "./llm-client";
import { segmentArtist } from "./segments";
import { composeSheet, loadSheet, type SheetEntry } from "./sheet";
import { socialFetch } from "./socialfetch";
import { db } from "./supabase";
import type { Artist, Status, VideoRow } from "./types";
import { chunks, mapLimit, uniq } from "./util";

// Look-alikes, found and handled without anyone adding them:
// 1. Discover: names, @accounts and hashtags that keep coming up in videos the frames check
//    took for the artist while nothing in the post points to the artist. A model keeps the
//    tokens that are a person (not an event, place or brand) and merges them per person.
// 2. Sheet: photos of that person from their own account, like the artist sheet.
// 3. Check again: the usable videos that mention the person (plus a sample of the rest), frame
//    by frame, with both sheets side by side: the artist, the look-alike, both, or someone else.
//    Frames without the artist drop out of the fragments; videos without the artist at all
//    become unrelated. The person's own account and fan pages go on the block list.
// Undo: "not a look-alike" removes its verdicts and blocks again.

// "Confused" = the frames check took the video for the artist or doubted (relevant or review).
const MIN_CONFUSED = 5;
const MIN_RATE = 0.15; // ...of the checked videos mentioning the token without the artist,
const MIN_LIFT = 1.5; // and clearly more than for posts without the artist in general
const MAX_LOOKALIKES = 3;
const SAMPLE_SHARE = 0.1; // share of the other usable videos checked as well
const SAMPLE_MAX = 60;
const MODEL_PREFIX = "jev-lookalike:";

const GENERIC_TAGS = new Set([
  "fyp", "foryou", "foryoupage", "fy", "fypシ", "fypage", "viral", "trending", "tiktok", "voorjou", "voorjoupagina",
  "xyzbca", "foryourpage", "fypsounds", "capcut", "edit", "concert", "festival", "live", "music", "muziek", "nederland", "dutch",
]);

const norm = (s: string) => s.toLowerCase().replace(/^[@#]/, "").replace(/[^a-z0-9._]/g, "");

type Video = Pick<VideoRow, "id" | "author_handle" | "caption" | "hashtags">;

function tokensOf(v: Video): string[] {
  const mentions = [...(v.caption ?? "").matchAll(/@([\w.]+)/g)].map((m) => `@${norm(m[1])}`);
  return uniq([...v.hashtags.map((h) => `#${norm(h)}`), ...mentions, ...(v.author_handle ? [`@${norm(v.author_handle)}`] : [])]);
}

// Narrow on purpose: only the artist's own name, aliases, handles and hashtags. A collaborator
// mention isn't a sign the artist is on screen, and look-alikes are often collaborators.
function mentionsArtist(artist: Artist, v: Video): boolean {
  const words = [artist.name, ...artist.aliases].map((n) => n.toLowerCase().replace(/\s+/g, ""));
  const own = [...artist.handles, ...artist.hashtags].map(norm);
  const text = `${v.caption ?? ""} ${v.hashtags.join(" ")}`.toLowerCase().replace(/\s+/g, "");
  return words.some((w) => text.includes(w)) || own.some((h) => text.includes(h)) || own.includes(norm(v.author_handle ?? ""));
}

const CandidatesSchema = z.object({
  people: z
    .array(
      z.object({
        name: z.string().describe("The person's name as commonly written"),
        tokens: z.array(z.string()).describe("The tokens from the list that refer to this person (their name tags, own account, fan pages)"),
        tiktok_handle: z.string().nullable().describe("Their own TikTok account if it is one of the @tokens, without @; else null"),
        reason: z.string().describe("One sentence: why this person could be mistaken for the artist"),
      }),
    )
    .describe("At most 3 people, most videos first. Empty if none."),
});

export type Candidate = z.infer<typeof CandidatesSchema>["people"][number] & { confused: number; mentioned: number };

export async function discoverLookalikes(artist: Artist): Promise<Candidate[]> {
  const statuses = await selectAll<{ id: string; status: Status; layer: string | null }>("video_status", "id, status, layer", artist.id);
  const checked = new Map(statuses.filter((s) => s.layer === "vision" || s.layer === "rules").map((s) => [s.id, s.status]));
  const videos = (await selectAll<Video>("videos", "id, author_handle, caption, hashtags", artist.id)).filter((v) => checked.has(v.id));

  const counts = new Map<string, { mentioned: number; confused: number }>();
  const exclude = new Set([...artist.handles, ...artist.hashtags].map(norm));
  const isConfused = (id: string) => ["relevant", "review"].includes(checked.get(id) ?? "");
  let base = 0;
  let baseConfused = 0;
  for (const v of videos) {
    if (mentionsArtist(artist, v)) continue;
    base++;
    if (isConfused(v.id)) baseConfused++;
    for (const t of tokensOf(v)) {
      const bare = norm(t);
      if (GENERIC_TAGS.has(bare) || exclude.has(bare) || bare.length < 3) continue;
      const c = counts.get(t) ?? { mentioned: 0, confused: 0 };
      c.mentioned++;
      if (isConfused(v.id)) c.confused++;
      counts.set(t, c);
    }
  }
  const baseRate = base ? baseConfused / base : 0;
  const suspects = [...counts.entries()]
    .filter(([, c]) => c.confused >= MIN_CONFUSED && c.confused / c.mentioned >= Math.max(MIN_RATE, MIN_LIFT * baseRate))
    .sort((a, b) => b[1].confused - a[1].confused)
    .slice(0, 25);
  if (!suspects.length) return [];

  const { data } = await generateStructured(CandidatesSchema, {
    system:
      "You help verify footage of a music artist. Given tokens (hashtags and @accounts) that keep appearing in videos a face check mistook for the artist, find the specific real people (performers, presenters, creators) behind them who could be confused with the artist on screen: plausibly similar look (same gender, similar age and style). Merge tokens of the same person (name tag, own account, fan pages). Ignore events, venues, places, brands, shows, generic tags and the artist themself.",
    text: `Artist: ${artist.name}${artist.notes ? ` (${artist.notes})` : ""}
Tokens (videos the face check took for the artist or doubted / all checked videos with this token, none mentioning the artist; on average ${Math.round(baseRate * 100)}% of such posts get taken for the artist):
${suspects.map(([t, c]) => `${t}: ${c.confused}/${c.mentioned}`).join("\n")}`,
    maxTokens: 4096,
  });
  return data.people.slice(0, MAX_LOOKALIKES).map((p) => {
    const own = p.tokens.map((t) => counts.get(t.startsWith("@") || t.startsWith("#") ? t.toLowerCase() : `#${norm(t)}`)).filter(Boolean);
    return {
      ...p,
      confused: own.reduce((n, c) => Math.max(n, c!.confused), 0),
      mentioned: own.reduce((n, c) => Math.max(n, c!.mentioned), 0),
    };
  });
}

async function findTikTokHandle(name: string): Promise<{ handle: string | null; credits: number }> {
  const res = await socialFetch.webSearch(`${name} tiktok`).catch(() => null);
  const url = res?.data.results.map((r) => r.url).find((u) => /tiktok\.com\/@[\w.]+/.test(u));
  return { handle: url?.match(/tiktok\.com\/@([\w.]+)/)?.[1]?.toLowerCase() ?? null, credits: res?.meta.creditsCharged ?? 0 };
}

export type LookalikeRow = {
  id: number;
  artist_id: string;
  name: string;
  tiktok_handle: string | null;
  sheet: SheetEntry[];
  traits: string;
  evidence: { tokens?: string[]; confused?: number; mentioned?: number; reason?: string };
  blocked_accounts: string[];
  stats: Record<string, number>;
  status: "active" | "rejected";
};

// New look-alikes get a row with a sheet; the person's own account and accounts named after
// them (fan pages) go on the artist's block list.
async function addLookalike(artist: Artist, c: Candidate): Promise<{ row: LookalikeRow | null; credits: number }> {
  const supabase = db();
  const { data: known } = await supabase.from("lookalikes").select("id").eq("artist_id", artist.id).eq("name", c.name).maybeSingle();
  if (known) return { row: null, credits: 0 }; // already added (or rejected by the team)
  let credits = 0;
  let handle = c.tiktok_handle?.replace(/^@/, "").toLowerCase() ?? null;
  if (!handle) {
    const found = await findTikTokHandle(c.name);
    handle = found.handle;
    credits += found.credits;
  }
  if (!handle) return { row: null, credits };
  const { data: inserted } = await supabase
    .from("lookalikes")
    .upsert(
      { artist_id: artist.id, name: c.name, tiktok_handle: handle, evidence: { tokens: c.tokens, confused: c.confused, mentioned: c.mentioned, reason: c.reason } },
      { onConflict: "artist_id,name", ignoreDuplicates: true },
    )
    .select("*")
    .maybeSingle<LookalikeRow>();
  if (!inserted) return { row: null, credits }; // already known (or rejected earlier)

  const person: Artist = { ...artist, name: c.name, aliases: [], handles: [handle], instagram_handle: null, spotify_url: null, artist_sheet: [] };
  const sheet = await composeSheet(person, `${artist.id}/lookalike_${inserted.id}`).catch(() => null);
  credits += sheet?.credits ?? 0;
  const nameKey = c.name.toLowerCase().replace(/[^a-z0-9]/g, "");
  const blocked = uniq(
    [handle, ...c.tokens.filter((t) => t.startsWith("@")).map(norm)].filter((h) => h === handle || h.replace(/[^a-z0-9]/g, "").includes(nameKey)),
  ).filter((h) => !artist.handles.map(norm).includes(h));
  const { data: row } = await supabase
    .from("lookalikes")
    .update({ sheet: sheet?.entries ?? [], traits: sheet?.traits ?? "", blocked_accounts: blocked, updated_at: new Date().toISOString() })
    .eq("id", inserted.id)
    .select("*")
    .single<LookalikeRow>();
  if (blocked.length)
    await supabase.from("artists").update({ blocked_accounts: uniq([...artist.blocked_accounts, ...blocked]) }).eq("id", artist.id);
  return { row, credits };
}

type VisionRow = { video_id: string; confidence: number; is_about_artist: boolean; content_type: string | null; usability: number | null; model: string | null; details: { frames: { at_seconds: number | null; artist_p: number; text_level: number }[] } | null };

// Check videos again with the artist's and the look-alike's sheets side by side.
async function recheck(artist: Artist, la: LookalikeRow, videoIds: string[]) {
  const supabase = db();
  const artistPhotos = (await loadSheet(artist)).map((s) => s.image);
  const lookalikePhotos = (await loadSheet({ artist_sheet: la.sheet })).map((s) => s.image);
  const stats = { checked: 0, rejected: 0, framesRemoved: 0, confirmed: 0 };
  if (!artistPhotos.length || !lookalikePhotos.length) return stats;

  await mapLimit(videoIds, 4, async (videoId) => {
    const { data: rows } = await supabase
      .from("classifications")
      .select("video_id, confidence, is_about_artist, content_type, usability, model, details")
      .eq("video_id", videoId)
      .eq("layer", "vision")
      .not("details", "is", null)
      .order("created_at", { ascending: false })
      .limit(1);
    const latest = rows?.[0] as VisionRow | undefined;
    if (!latest?.details?.frames.length || latest.model?.startsWith(MODEL_PREFIX)) return;
    const stored = await loadStoredFrames(artist.id, videoId);
    if (!stored.length) return;
    const frames = latest.details.frames;
    const idx = frames.map((_, i) => Math.min(stored.length - 1, Math.round((i * stored.length) / frames.length)));
    const images = await Promise.all(idx.map((j) => toJevImage(stored[j].image)));
    const who = (
      await Promise.all(
        chunks(images, 12).map((batch) =>
          whoIsOnScreenWithJev({ name: artist.name, photos: artistPhotos, traits: artist.traits }, { name: la.name, photos: lookalikePhotos, traits: la.traits }, batch),
        ),
      )
    ).flat();

    // Only lower: a frame without the artist leaves the fragments; the contrast doesn't add frames.
    let removed = 0;
    const updated = frames.map((f, i) => {
      const present = who[i]?.label === "artist" || who[i]?.label === "both";
      if (!present && f.artist_p >= 0.7) removed++;
      return present ? f : { ...f, artist_p: Math.min(f.artist_p, 0.3) };
    });
    const withArtist = who.filter((w) => w.label === "artist" || w.label === "both").length;
    const withLookalike = who.filter((w) => w.label === "lookalike" || w.label === "both").length;
    // The artist must really be in it: at least 2 frames and a quarter of them, and not clearly
    // outnumbered by the look-alike (one stray frame kept look-alike videos in before).
    const keep = withArtist >= Math.max(2, Math.round(0.25 * who.length)) && !(withLookalike >= 3 && withLookalike >= 2 * withArtist);
    await supabase.from("classifications").insert({
      video_id: videoId,
      layer: "vision",
      model: `${MODEL_PREFIX}${la.id}`,
      is_about_artist: keep ? latest.is_about_artist : false,
      confidence: keep ? latest.confidence : 0.85,
      content_type: keep ? latest.content_type : "unrelated",
      usability: latest.usability,
      reason: `Look-alike-check: ${artist.name} in ${withArtist}/${who.length} frames, ${la.name} in ${withLookalike}/${who.length}`,
      details: { ...latest.details, frames: updated, lookalike: la.name },
    });
    stats.checked++;
    stats.framesRemoved += removed;
    if (!keep) stats.rejected++;
    else if (!removed) stats.confirmed++;
  });
  return stats;
}

// Videos to check for one look-alike: usable ones that mention them, plus a sample of the rest.
async function videosToCheck(artist: Artist, la: LookalikeRow): Promise<string[]> {
  const statuses = await selectAll<{ id: string; status: Status }>("video_status", "id, status", artist.id);
  const usable = new Set(statuses.filter((s) => s.status === "relevant").map((s) => s.id));
  const videos = (await selectAll<Video>("videos", "id, author_handle, caption, hashtags", artist.id)).filter((v) => usable.has(v.id));
  const tokens = new Set((la.evidence.tokens ?? []).map((t) => t.toLowerCase()));
  const nameKey = la.name.toLowerCase().replace(/[^a-z0-9]/g, "");
  const mentions = (v: Video) =>
    tokensOf(v).some((t) => tokens.has(t) || t.replace(/[^a-z0-9]/g, "").includes(nameKey)) ||
    (v.caption ?? "").toLowerCase().replace(/[^a-z0-9]/g, "").includes(nameKey);
  const hit = videos.filter(mentions).map((v) => v.id);
  const rest = videos.filter((v) => !hit.includes(v.id));
  const sample = rest
    .sort(() => Math.random() - 0.5)
    .slice(0, Math.min(SAMPLE_MAX, Math.round(rest.length * SAMPLE_SHARE)))
    .map((v) => v.id);
  return [...hit, ...sample];
}

export type LookalikeStats = { discovered: string[]; added: string[]; credits: number; checks: Record<string, { checked: number; rejected: number; framesRemoved: number; confirmed: number }> };

export async function runLookalikes(artistId: string): Promise<LookalikeStats> {
  const supabase = db();
  const { data: artist } = await supabase.from("artists").select("*").eq("id", artistId).single<Artist>();
  if (!artist) throw new Error(`Artist ${artistId} not found`);
  const out: LookalikeStats = { discovered: [], added: [], credits: 0, checks: {} };
  const touched: string[] = [];

  const candidates = await discoverLookalikes(artist);
  out.discovered = candidates.map((c) => c.name);
  for (const c of candidates) {
    const { row, credits } = await addLookalike(artist, c);
    out.credits += credits;
    if (row) out.added.push(row.name);
  }

  const { data: active } = await supabase.from("lookalikes").select("*").eq("artist_id", artistId).eq("status", "active");
  const { data: fresh } = await supabase.from("artists").select("*").eq("id", artistId).single<Artist>();
  for (const la of (active ?? []) as LookalikeRow[]) {
    if (!la.sheet.length) continue;
    const ids = await videosToCheck(fresh ?? artist, la);
    touched.push(...ids);
    const stats = await recheck(fresh ?? artist, la, ids);
    out.checks[la.name] = stats;
    const prev = la.stats ?? {};
    await supabase
      .from("lookalikes")
      .update({
        stats: {
          checked: (prev.checked ?? 0) + stats.checked,
          rejected: (prev.rejected ?? 0) + stats.rejected,
          framesRemoved: (prev.framesRemoved ?? 0) + stats.framesRemoved,
        },
        updated_at: new Date().toISOString(),
      })
      .eq("id", la.id);
  }
  // Fragments follow the new verdicts.
  if (Object.values(out.checks).some((s) => s.checked)) await segmentArtist(artistId, { videoIds: uniq(touched) });
  return out;
}

// "Not a look-alike": undo its verdicts and blocks, and keep it from being added again.
export async function rejectLookalike(id: number) {
  const supabase = db();
  const { data: la } = await supabase.from("lookalikes").select("*").eq("id", id).single<LookalikeRow>();
  if (!la) throw new Error("Look-alike not found");
  const { data: undone } = await supabase.from("classifications").select("video_id").eq("model", `${MODEL_PREFIX}${id}`);
  await supabase.from("classifications").delete().eq("model", `${MODEL_PREFIX}${id}`);
  const { data: artist } = await supabase.from("artists").select("*").eq("id", la.artist_id).single<Artist>();
  if (artist && la.blocked_accounts.length)
    await supabase
      .from("artists")
      .update({ blocked_accounts: artist.blocked_accounts.filter((a) => !la.blocked_accounts.includes(a)) })
      .eq("id", artist.id);
  await supabase.from("lookalikes").update({ status: "rejected", updated_at: new Date().toISOString() }).eq("id", id);
  await segmentArtist(la.artist_id, { videoIds: (undone ?? []).map((r) => r.video_id) });
  return { ok: true };
}

export async function listLookalikes(artistId: string): Promise<LookalikeRow[]> {
  const { data } = await db().from("lookalikes").select("*").eq("artist_id", artistId).order("created_at");
  return (data ?? []) as LookalikeRow[];
}

