import type { SfVideo } from "./socialfetch";

// Maps a Social Fetch video item to our videos row. `details` is TikTok-native
// and undocumented field-by-field, so every read there is defensive.

type Obj = Record<string, unknown>;
const obj = (v: unknown): Obj => (v && typeof v === "object" ? (v as Obj) : {});
const str = (v: unknown): string | null =>
  typeof v === "string" && v ? v : typeof v === "number" ? String(v) : null;

export type NormalizedVideo = {
  id: string;
  url: string | null;
  author_handle: string | null;
  caption: string | null;
  hashtags: string[];
  sound_id: string | null;
  sound_title: string | null;
  sound_author: string | null;
  views: number | null;
  likes: number | null;
  comments: number | null;
  shares: number | null;
  duration_ms: number | null;
  posted_at: string | null;
  thumbnail_url: string | null;
  raw: Obj;
};

export function normalizeVideo(v: SfVideo): NormalizedVideo {
  const d = obj(v.details);
  const author = obj(d.author);
  const music = obj(d.music);

  const handleFromUrl = v.url?.match(/tiktok\.com\/@([^/?#]+)/)?.[1] ?? null;
  const author_handle = (
    v.author?.handle ?? str(author.unique_id) ?? str(author.uniqueId) ?? handleFromUrl
  )?.toLowerCase() ?? null;

  const textExtra = Array.isArray(d.text_extra) ? d.text_extra : [];
  const tagsFromDetails = textExtra.map((t) => str(obj(t).hashtag_name)).filter(Boolean) as string[];
  const tagsFromCaption = [...(v.caption ?? "").matchAll(/#([\p{L}\p{N}_]+)/gu)].map((m) => m[1]);
  const hashtags = [...new Set([...tagsFromDetails, ...tagsFromCaption].map((t) => t.toLowerCase()))];

  const url = v.url ?? (author_handle ? `https://www.tiktok.com/@${author_handle}/video/${v.id}` : null);

  return {
    id: v.id,
    url,
    author_handle,
    caption: v.caption,
    hashtags,
    // id is a 64-bit number in JSON (loses precision); prefer the string form.
    sound_id: str(music.id_str) ?? str(music.idStr) ?? str(music.mid) ?? null,
    sound_title: str(music.title),
    sound_author: str(music.author),
    views: v.stats?.views ?? null,
    likes: v.stats?.likes ?? null,
    comments: v.stats?.comments ?? null,
    shares: v.stats?.shares ?? null,
    duration_ms: v.durationMs,
    posted_at: v.createdAt,
    thumbnail_url: v.thumbnailUrl,
    // Keep a slim raw copy: full `details` is ~30KB per video.
    raw: {
      id: v.id,
      caption: v.caption,
      createdAt: v.createdAt,
      url: v.url,
      isAd: v.isAd,
      stats: v.stats,
      author: v.author ?? {
        uid: str(author.uid),
        unique_id: str(author.unique_id),
        nickname: str(author.nickname),
      },
      music: {
        id: str(music.id_str),
        title: str(music.title),
        author: str(music.author),
        is_original: music.is_original ?? null,
        owner_handle: str(music.owner_handle),
      },
      hashtags,
      content_desc: str(d.content_desc),
      desc_language: str(d.desc_language),
      region: str(d.region),
    },
  };
}
