import "server-only";
import { box, image, noul, TypeSafeClient } from "@typesafe-ai/sdk";
import { JEV_MODEL } from "./classify/jev";
import { cropFace, toJevImage } from "./images";
import { normalizeVideo } from "./normalize";
import { socialFetch } from "./socialfetch";
import { env } from "./env";
import { db, THUMB_BUCKET } from "./supabase";
import type { Artist } from "./types";
import { mapLimit } from "./util";

// Reference photos of the artist, so the vision layer can check whether THIS person is
// on screen without relying on captions. From the profile picture and the covers of the
// artist's own posts, Jev locates the main face (Box), the faces are cropped and compared
// pairwise, and the biggest group of the same person wins, with a bonus when the profile
// picture is in it (own posts also show collaborators, and profile pictures can hide the face).

export const REFERENCE_BUCKET = "references";
const MAX_REFERENCES = 4;
const IMAGES_HEADER = { "TypeSafe-Danger-Zone-Images": "true" };
let client: TypeSafeClient | null = null;
const jev = () => (client ??= new TypeSafeClient({ defaultModel: JEV_MODEL }));

export async function loadReferences(artist: Artist): Promise<Buffer[]> {
  const out: Buffer[] = [];
  for (const path of artist.reference_images ?? []) {
    const { data } = await db().storage.from(REFERENCE_BUCKET).download(path);
    if (data) out.push(Buffer.from(await data.arrayBuffer()));
  }
  return out;
}

export type ReferenceResult = { paths: string[]; candidates: number; credits: number };

export async function buildReferences(artist: Artist): Promise<ReferenceResult> {
  const supabase = db();
  let credits = 0;

  // Covers of the artist's own posts: already cached from ingest, otherwise fetch a profile page.
  const { data: stored } = await supabase
    .from("videos")
    .select("thumbnail_cached_path, views")
    .eq("artist_id", artist.id)
    .in("author_handle", artist.handles)
    .not("thumbnail_cached_path", "is", null)
    .order("views", { ascending: false })
    .limit(16);
  const covers: Buffer[] = [];
  for (const row of stored ?? []) {
    const { data } = await supabase.storage.from(THUMB_BUCKET).download(row.thumbnail_cached_path);
    if (data) covers.push(Buffer.from(await data.arrayBuffer()));
  }
  if (covers.length < 6) {
    for (const handle of artist.handles) {
      const res = await socialFetch.profileVideos(handle);
      credits += res.meta.creditsCharged ?? 0;
      for (const v of res.data.videos.map(normalizeVideo)) {
        if (!v.thumbnail_url) continue;
        const r = await fetch(v.thumbnail_url).catch(() => null);
        if (r?.ok) covers.push(Buffer.from(await r.arrayBuffer()));
      }
    }
  }
  // 1. Anchor: the profile picture usually shows the artist (but may hide the face).
  const handle = artist.handles[0];
  if (!handle) throw new Error("Artist card heeft geen eigen TikTok-account");
  const profileRes = await fetch(`https://api.socialfetch.dev/v1/tiktok/profiles/${encodeURIComponent(handle)}`, {
    headers: { "x-api-key": env.socialFetchKey() },
  });
  const profileJson = await profileRes.json();
  credits += profileJson.meta?.creditsCharged ?? 0;
  const profile = profileJson.data?.profile ?? profileJson.data;
  const avatarUrl: string | undefined = profile?.avatarUrls?.large ?? profile?.avatarUrl;
  const avatarRes = avatarUrl ? await fetch(avatarUrl).catch(() => null) : null;
  const sources = [
    ...(avatarRes?.ok ? [Buffer.from(await avatarRes.arrayBuffer())] : []),
    ...covers.slice(0, 16),
  ];
  const hasAvatar = !!avatarRes?.ok;
  const images = (await mapLimit(sources, 4, (c) => toJevImage(c, 720).catch(() => null))).filter(
    (b): b is Buffer => !!b && b.length > 0,
  );
  if (!images.length) throw new Error("Geen profielfoto of covers gevonden om referenties uit te halen");

  // 2. Locate the main person's face in every image (one request) and crop it.
  const located = await jev().systemOne(
    {
      model: "jev-preview", // Box questions need Jev 1.14
      state: Object.fromEntries(images.map((img, i) => [`img_${i}`, image(img)])),
      questions: Object.fromEntries(
        images.flatMap((_, i) => [
          [`face_${i}`, box(`the face of the most prominent person in \`img_${i}\``)],
          [`visible_${i}`, noul(`Is a person's face clearly visible in \`img_${i}\` (eyes not covered, not tiny or blurred)?`)],
        ]),
      ),
    },
    { headers: IMAGES_HEADER },
  );
  const answers = located.answers as Record<string, { box?: { top: number; bottom: number; left: number; right: number }; noul?: number }>;
  const faces = (
    await mapLimit(images.map((img, i) => ({ img, i })), 4, async ({ img, i }) => {
      const b = answers[`face_${i}`]?.box;
      const visible = answers[`visible_${i}`]?.noul ?? 0;
      if (!b || visible < 0.5 || b.right - b.left < 0.05) return null;
      const crop = await cropFace(img, b).catch(() => null);
      return crop ? { img: crop, source: i, visible, isAvatar: hasAvatar && i === 0 } : null;
    })
  ).filter((f): f is { img: Buffer; source: number; visible: number; isAvatar: boolean } => !!f);
  if (!faces.length) throw new Error("Geen duidelijk zichtbare gezichten gevonden");

  // 3. Compare every pair of faces (one request) and keep the biggest group of the same person.
  //    The artist appears most on their own posts; agreeing with the profile picture is a bonus.
  const pairs: [number, number][] = [];
  for (let a = 0; a < faces.length; a++) for (let b = a + 1; b < faces.length; b++) pairs.push([a, b]);
  const same = pairs.length
    ? await jev().systemOne(
        {
          state: Object.fromEntries(faces.map((f, k) => [`face_${k}`, image(f.img)])),
          questions: Object.fromEntries(
            pairs.map(([a, b]) => [`same_${a}_${b}`, noul(`Do \`face_${a}\` and \`face_${b}\` show the same person?`)]),
          ),
        },
        { headers: IMAGES_HEADER },
      )
    : null;
  const sim = (a: number, b: number) =>
    a === b ? 1 : ((same?.answers as Record<string, { noul: number }> | undefined)?.[`same_${Math.min(a, b)}_${Math.max(a, b)}`]?.noul ?? 0);
  const groups = faces.map((_, k) => {
    const members = faces.map((__, j) => j).filter((j) => sim(k, j) >= 0.6);
    const withAvatar = members.some((j) => faces[j].isAvatar);
    return { k, members, score: members.length + (withAvatar ? 1.5 : 0) };
  });
  const best = groups.sort((a, b) => b.score - a.score)[0];
  const chosen = best.members
    .map((j) => ({ ...faces[j], score: sim(best.k, j) * faces[j].visible }))
    .sort((a, b) => b.score - a.score)
    .slice(0, MAX_REFERENCES);

  // 3. Store them; replace any previous set.
  const old = artist.reference_images ?? [];
  if (old.length) await supabase.storage.from(REFERENCE_BUCKET).remove(old);
  const paths: string[] = [];
  for (const [n, c] of chosen.entries()) {
    const path = `${artist.id}/ref_${Date.now()}_${n}.jpg`;
    const { error } = await supabase.storage.from(REFERENCE_BUCKET).upload(path, c.img, { contentType: "image/jpeg", upsert: true });
    if (!error) paths.push(path);
  }
  await supabase.from("artists").update({ reference_images: paths }).eq("id", artist.id);
  return { paths, candidates: images.length, credits };
}
