import "server-only";
import { box, choice, image, noul, TypeSafeClient } from "@typesafe-ai/sdk";
import { z } from "zod";
import { JEV_MODEL } from "./classify/jev";
import { cropFace, toJevImage } from "./images";
import { generateStructured } from "./llm-client";
import { normalizeVideo } from "./normalize";
import { socialFetch } from "./socialfetch";
import { db, THUMB_BUCKET } from "./supabase";
import type { Artist } from "./types";
import { mapLimit } from "./util";

// Artist sheet: labelled reference photos of the artist from several sources, so the vision
// layer recognises them from different angles, with sunglasses or a cap, and on stage.
//
// 1. Collect candidates: TikTok (profile picture, own covers), Instagram (profile picture,
//    own posts, posts they're tagged in), Apple Music and Spotify artist photos.
// 2. Jev labels each candidate: face box, face visible/clear, sunglasses, headwear, angle, setting.
// 3. Face crops are compared pairwise; the person who recurs across the most sources is the
//    artist (namesakes on Apple Music or collaborators on own posts drop out).
// 4. Fill slots from that person's photos and describe stable visual traits.

export const SHEET_BUCKET = "references";
const IMAGES_HEADER = { "TypeSafe-Danger-Zone-Images": "true" };
const MAX_CANDIDATES = 40;
const MAX_FACES = 30;

export type SheetSlot = "front" | "side" | "sunglasses" | "headwear" | "stage" | "everyday";
export type SheetEntry = { slot: SheetSlot; path: string; source: Source };
type Source = "tiktok_avatar" | "tiktok_cover" | "instagram_avatar" | "instagram_post" | "instagram_tagged" | "apple_music" | "spotify";
const SLOT_PLAN: { slot: SheetSlot; count: number }[] = [
  { slot: "front", count: 2 },
  { slot: "side", count: 2 },
  { slot: "sunglasses", count: 1 },
  { slot: "headwear", count: 1 },
  { slot: "stage", count: 1 },
  { slot: "everyday", count: 1 },
];

let client: TypeSafeClient | null = null;
const jev = () => (client ??= new TypeSafeClient({ defaultModel: JEV_MODEL }));

type Candidate = { source: Source; data: Buffer };
type Labelled = Candidate & {
  full: Buffer; // 480px wide, for stage/everyday slots
  face: Buffer | null; // square crop, for face slots
  clear: number;
  sunglasses: number;
  headwear: number;
  group: number;
  angle: string;
  setting: string;
};

export type SheetResult = {
  entries: SheetEntry[];
  traits: string;
  candidates: number;
  faces: number;
  sources: Record<string, number>;
  credits: number;
  instagramHandle: string | null;
  spotifyUrl: string | null;
};

async function download(url: string | null | undefined): Promise<Buffer | null> {
  if (!url) return null;
  try {
    const res = await fetch(url, { cache: "no-store" });
    return res.ok ? Buffer.from(await res.arrayBuffer()) : null;
  } catch {
    return null;
  }
}

export async function collectCandidates(artist: Artist) {
  const supabase = db();
  let credits = 0;
  const out: Candidate[] = [];
  const add = async (source: Source, url: string | null | undefined) => {
    const data = await download(url);
    if (data) out.push({ source, data });
  };

  // TikTok: profile picture + covers of own posts (cached at ingest; else one profile page).
  const handle = artist.handles[0];
  let instagramHandle = artist.instagram_handle;
  if (handle) {
    const profile = await fetch(`https://api.socialfetch.dev/v1/tiktok/profiles/${encodeURIComponent(handle)}`, {
      headers: { "x-api-key": process.env.SOCIALFETCH_API_KEY ?? "" },
    }).then((r) => r.json());
    credits += profile.meta?.creditsCharged ?? 0;
    const p = profile.data?.profile ?? profile.data;
    await add("tiktok_avatar", p?.avatarUrls?.large ?? p?.avatarUrl);

    const { data: stored } = await supabase
      .from("videos")
      .select("thumbnail_cached_path")
      .eq("artist_id", artist.id)
      .in("author_handle", artist.handles)
      .not("thumbnail_cached_path", "is", null)
      .order("views", { ascending: false })
      .limit(12);
    for (const row of stored ?? []) {
      const { data } = await supabase.storage.from(THUMB_BUCKET).download(row.thumbnail_cached_path);
      if (data) out.push({ source: "tiktok_cover", data: Buffer.from(await data.arrayBuffer()) });
    }
    // One profile page also tells us the linked Instagram account (author.ins_id).
    if (!stored?.length || !instagramHandle) {
      const page = await socialFetch.profileVideos(handle);
      credits += page.meta.creditsCharged ?? 0;
      const author = (page.data.videos[0]?.details?.author ?? {}) as { ins_id?: string };
      instagramHandle ||= author.ins_id || null;
      if (!stored?.length)
        await mapLimit(page.data.videos.slice(0, 12).map(normalizeVideo), 4, (v) => add("tiktok_cover", v.thumbnail_url));
    }
  }

  // Instagram: HD profile picture, own posts, and posts others tagged them in.
  if (instagramHandle) {
    const ig = await socialFetch.instagramProfile(instagramHandle).catch(() => null);
    if (ig) {
      credits += ig.meta.creditsCharged ?? 0;
      await add("instagram_avatar", ig.data.profile?.avatarUrlHd ?? ig.data.profile?.avatarUrl);
      const firstImage = (m: { imageUrl: string | null; carousel: { imageUrl?: string | null }[] | null }) =>
        m.carousel?.[0]?.imageUrl ?? m.imageUrl;
      await mapLimit((ig.data.recentMedia ?? []).slice(0, 10), 4, (m) => add("instagram_post", firstImage(m)));
      const tagged = await socialFetch.instagramMedia(instagramHandle, "tagged").catch(() => null);
      if (tagged) {
        credits += tagged.meta.creditsCharged ?? 0;
        await mapLimit(tagged.data.media.slice(0, 10), 4, (m) => add("instagram_tagged", firstImage(m)));
      }
    }
  }

  // Apple Music: top artist results for the name (namesakes are filtered out by clustering).
  const apple = await socialFetch.appleMusicSearch(artist.name).catch(() => null);
  if (apple) {
    credits += apple.meta.creditsCharged ?? 0;
    await mapLimit((apple.data.artists ?? []).slice(0, 3), 3, (a) => add("apple_music", a.artworkUrl));
  }

  // Spotify: the card's link, or the first open.spotify.com/artist result of a web search.
  let spotifyUrl = artist.spotify_url;
  if (!spotifyUrl) {
    const search = await socialFetch.webSearch(`${artist.name} spotify artist`).catch(() => null);
    credits += search?.meta.creditsCharged ?? 0;
    spotifyUrl = search?.data.results.find((r) => /open\.spotify\.com\/artist\//.test(r.url))?.url ?? null;
  }
  if (spotifyUrl) {
    const sp = await socialFetch.spotifyArtist(spotifyUrl).catch(() => null);
    credits += sp?.meta.creditsCharged ?? 0;
    await add("spotify", sp?.data.artist?.avatarUrl);
  }

  return { candidates: out.slice(0, MAX_CANDIDATES), credits, instagramHandle, spotifyUrl };
}

export async function label(candidates: Candidate[]): Promise<Labelled[]> {
  const prepared = (
    await mapLimit(candidates, 4, async (c) => {
      const big = await toJevImage(c.data, 720).catch(() => null);
      const full = big ? await toJevImage(big, 480).catch(() => null) : null;
      return big && full ? { ...c, big, full } : null;
    })
  ).filter((c): c is Candidate & { big: Buffer; full: Buffer } => !!c);

  // One request per photo: a Box question locates something in *the* image of the request,
  // so batching several photos makes the boxes land on the wrong one.
  const labelled = await mapLimit(prepared, 6, async (c): Promise<Labelled | null> => {
    const res = await jev()
      .systemOne(
      {
        model: "jev-preview", // Box questions need Jev 1.14
        state: { photo: image(c.full) },
        questions: {
          face: box("the face of the most prominent person in `photo`"),
          hasface: noul("Is a human face visible in `photo` (sunglasses, caps or hoods allowed)?"),
          clear: noul("Is the face of the most prominent person in `photo` large and sharp enough to recognise who it is?"),
          sunglasses: noul("Does the most prominent person in `photo` wear sunglasses?"),
          headwear: noul("Does the most prominent person in `photo` wear a cap, hat or hood?"),
          group: noul("Are several people about equally prominent in `photo`?"),
          angle: choice("How is the face of the most prominent person in `photo` turned?", {
            front: "Facing the camera",
            three_quarter: "Turned partly to the side",
            profile: "Side view",
            away: "Face not visible",
          }),
          setting: choice("Where was `photo` taken?", {
            stage: "On a stage or performing",
            studio_or_press: "Studio, photo shoot or press photo",
            everyday: "Everyday setting: street, home, car, backstage",
            artwork: "Artwork, logo or text rather than a photo of a person",
          }),
        },
      },
        { headers: IMAGES_HEADER },
      )
      .catch(() => null); // skip photos Jev rejects (odd sizes, damaged files)
    if (!res) return null;
    const a = res.answers;
    const b = a.face.box;
    const hasFace = a.hasface.noul >= 0.5 && b.right - b.left >= 0.04;
    return {
      source: c.source,
      data: c.data,
      full: c.full,
      face: hasFace ? await cropFace(c.big, b).catch(() => null) : null,
      clear: a.clear.noul,
      sunglasses: a.sunglasses.noul,
      headwear: a.headwear.noul,
      group: a.group.noul,
      angle: a.angle.choice,
      setting: a.setting.choice,
    };
  });
  const out = labelled.filter((l): l is Labelled => !!l);
  return out;
}

// Who is the artist? Jev's face-to-face "same person" scores are weak (0.1-0.5 between clear
// photos of the same person), so similarity alone can't cluster. Source priors carry most of
// the weight: single-person photos on the artist's own Instagram (posts + profile picture)
// are the anchor; other sources join when they resemble the anchor more than average.
async function pickArtist(labelled: Labelled[]): Promise<Labelled[]> {
  const faces = labelled
    .filter((l) => l.face && l.setting !== "artwork")
    .sort((x, y) => y.clear - x.clear)
    .slice(0, MAX_FACES);
  const isAnchor = (l: Labelled) => (l.source === "instagram_post" || l.source === "instagram_avatar") && l.group < 0.5;
  const anchors = faces.filter(isAnchor);
  if (anchors.length < 2) {
    // No usable Instagram: fall back to TikTok profile picture + streaming photos as anchor.
    anchors.push(...faces.filter((l) => !anchors.includes(l) && ["tiktok_avatar", "spotify", "apple_music"].includes(l.source)));
  }
  const others = faces.filter((l) => !anchors.includes(l));
  if (!anchors.length || !others.length) return anchors.length ? anchors : faces;

  const res = await jev().systemOne(
    {
      state: {
        artist: Object.fromEntries(anchors.map((a, k) => [`photo_${k}`, image(a.face!)])),
        ...Object.fromEntries(others.map((o, k) => [`candidate_${k}`, image(o.face!)])),
      },
      questions: Object.fromEntries(
        others.map((_, k) => [`same_${k}`, noul(`Does \`candidate_${k}\` show the same person as the photos in \`artist\`?`)]),
      ),
    },
    { headers: IMAGES_HEADER },
  );
  const answers = res.answers as Record<string, { noul: number }>;
  const scores = others.map((_, k) => answers[`same_${k}`]?.noul ?? 0);
  // Relative threshold: Jev's scores are compressed, so take those clearly above the median.
  const sorted = [...scores].sort((a, b) => a - b);
  const median = sorted[Math.floor(sorted.length / 2)];
  const cut = Math.max(0.5, median + 0.15);
  return [...anchors, ...others.filter((_, k) => scores[k] >= cut)];
}

function fillSlots(person: Labelled[]): { slot: SheetSlot; image: Buffer; source: Source }[] {
  const used = new Set<Labelled>();
  const take = (filter: (l: Labelled) => boolean, sort: (l: Labelled) => number, n: number) =>
    person
      .filter((l) => !used.has(l) && filter(l))
      .sort((x, y) => sort(y) - sort(x))
      .slice(0, n)
      .map((l) => (used.add(l), l));
  const out: { slot: SheetSlot; image: Buffer; source: Source }[] = [];
  for (const { slot, count } of SLOT_PLAN) {
    const picks =
      slot === "front"
        ? take((l) => l.angle === "front" && l.sunglasses < 0.5 && l.headwear < 0.5, (l) => l.clear, count)
        : slot === "side"
          ? take((l) => l.angle === "three_quarter" || l.angle === "profile", (l) => l.clear, count)
          : slot === "sunglasses"
            ? take((l) => l.sunglasses >= 0.6, (l) => l.clear, count)
            : slot === "headwear"
              ? take((l) => l.headwear >= 0.6, (l) => l.clear, count)
              : slot === "stage"
                ? take((l) => l.setting === "stage", (l) => 1 - l.group, count)
                : take((l) => l.setting !== "stage" && l.group < 0.5, (l) => l.clear, count);
    const fullImage = slot === "stage" || slot === "everyday";
    for (const p of picks) out.push({ slot, image: fullImage ? p.full : p.face!, source: p.source });
  }
  // An empty front slot is filled with the clearest remaining face.
  if (!out.some((o) => o.slot === "front")) {
    for (const p of take(() => true, (l) => l.clear, 1)) out.push({ slot: "front", image: p.face!, source: p.source });
  }
  return out;
}

const TraitsSchema = z.object({
  traits: z
    .string()
    .describe(
      "2-4 short lines with stable visual traits to recognise this person in video: hairstyle and colour, facial hair, glasses, visible tattoos or piercings, typical clothing or accessories. No guesses about identity, ethnicity or age.",
    ),
});

export async function buildArtistSheet(artist: Artist): Promise<SheetResult> {
  const supabase = db();
  const { candidates, credits, instagramHandle, spotifyUrl } = await collectCandidates(artist);
  if (!candidates.length) throw new Error("Geen foto's gevonden voor het artist sheet");
  const labelled = await label(candidates);
  const person = await pickArtist(labelled);
  if (!person.length) throw new Error("Geen duidelijk zichtbare gezichten gevonden");
  const filled = fillSlots(person);

  const { data: traits } = await generateStructured(TraitsSchema, {
    system: "You describe a person's stable visual traits for recognising them in video footage.",
    text: "These photos all show the same person. Describe their recognisable visual traits.",
    images: filled.slice(0, 4).map((f) => f.image),
    maxTokens: 512,
  }).catch(() => ({ data: { traits: "" } }));

  // Replace the previous sheet.
  const old = (artist.artist_sheet ?? []).map((e) => e.path);
  if (old.length) await supabase.storage.from(SHEET_BUCKET).remove(old);
  const stamp = Date.now();
  const entries: SheetEntry[] = [];
  for (const [n, f] of filled.entries()) {
    const path = `${artist.id}/sheet_${stamp}_${n}_${f.slot}.jpg`;
    const { error } = await supabase.storage.from(SHEET_BUCKET).upload(path, f.image, { contentType: "image/jpeg", upsert: true });
    if (!error) entries.push({ slot: f.slot, path, source: f.source });
  }
  await supabase
    .from("artists")
    .update({
      artist_sheet: entries,
      traits: traits.traits,
      instagram_handle: artist.instagram_handle ?? instagramHandle,
      spotify_url: artist.spotify_url ?? spotifyUrl,
    })
    .eq("id", artist.id);

  const sources: Record<string, number> = {};
  for (const c of candidates) sources[c.source] = (sources[c.source] ?? 0) + 1;
  return {
    entries,
    traits: traits.traits,
    candidates: candidates.length,
    faces: labelled.filter((l) => l.face).length,
    sources,
    credits,
    instagramHandle,
    spotifyUrl,
  };
}

export type SheetImage = { label: string; image: Buffer };

export async function loadSheet(artist: Artist): Promise<SheetImage[]> {
  const out: SheetImage[] = [];
  for (const entry of artist.artist_sheet ?? []) {
    const { data } = await db().storage.from(SHEET_BUCKET).download(entry.path);
    if (data) out.push({ label: entry.slot, image: Buffer.from(await data.arrayBuffer()) });
  }
  return out;
}
