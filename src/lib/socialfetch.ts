import "server-only";
import { env } from "./env";

// Thin client for the documented Social Fetch TikTok routes we use.
// Docs: https://www.socialfetch.dev/llms-tiktok.txt

const BASE = "https://api.socialfetch.dev";

export type SfVideo = {
  id: string;
  caption: string | null;
  createdAt: string | null;
  url: string | null;
  thumbnailUrl: string | null;
  durationMs: number | null;
  isAd: boolean;
  stats: { views?: number; likes?: number; comments?: number; shares?: number; saves?: number };
  media: { downloadUrl?: string | null; downloadWithoutWatermarkUrl?: string | null };
  author?: { id?: string; handle?: string; displayName?: string }; // hashtag route only
  details?: Record<string, unknown>;
};

export type SfPage = { nextCursor: string | null; hasMore: boolean };
export type SfListResponse = {
  data: { videos: SfVideo[]; page: SfPage; lookupStatus?: string };
  meta: { requestId: string; creditsCharged: number };
};

export type SfDownloadResponse = {
  data: {
    lookupStatus: "found" | "not_found";
    video: { id: string; url: string; mediaType: "video" | "slideshow" } | null;
    media: { downloadUrl: string | null; downloadWithoutWatermarkUrl: string | null } | null;
    downloads: { cdnUrl: string; type: "video" | "image" }[];
  };
  meta: { requestId: string; creditsCharged: number };
};

type Meta = { requestId: string; creditsCharged: number };
export type SfInstagramMedia = {
  url: string | null;
  mediaType: "image" | "video" | "carousel" | null;
  imageUrl: string | null;
  carousel: { imageUrl?: string | null }[] | null;
};
export type SfInstagramProfile = {
  data: {
    lookupStatus: "found" | "private" | "not_found";
    profile?: { displayName: string | null; avatarUrl: string | null; avatarUrlHd: string | null } | null;
    recentMedia: SfInstagramMedia[] | null;
  };
  meta: Meta;
};
export type SfInstagramMediaPage = {
  data: { lookupStatus: string; media: SfInstagramMedia[]; page?: { nextCursor: string | null; hasMore: boolean } };
  meta: Meta;
};
export type SfAppleSearch = {
  data: { artists: { displayName: string; url: string | null; artworkUrl: string | null }[] };
  meta: Meta;
};
export type SfSpotifyArtist = {
  data: { lookupStatus: "found" | "not_found"; artist?: { displayName: string; avatarUrl: string | null } | null } & Record<string, unknown>;
  meta: Meta;
};
export type SfWebSearch = { data: { results: { title: string; url: string; content: string }[] }; meta: Meta };

export class SocialFetchError extends Error {
  constructor(
    message: string,
    public status: number,
  ) {
    super(message);
  }
}

async function get<T>(path: string, params: Record<string, string | undefined>): Promise<T> {
  const url = new URL(path, BASE);
  for (const [k, v] of Object.entries(params)) if (v !== undefined) url.searchParams.set(k, v);

  // 502/503 are documented as retryable; everything else fails fast.
  for (let attempt = 0; ; attempt++) {
    const res = await fetch(url, { headers: { "x-api-key": env.socialFetchKey() }, cache: "no-store" });
    if (res.ok) return (await res.json()) as T;
    if ((res.status === 502 || res.status === 503) && attempt < 3) {
      await new Promise((r) => setTimeout(r, 1000 * 2 ** attempt + Math.random() * 500));
      continue;
    }
    const body = await res.text();
    throw new SocialFetchError(`Social Fetch ${res.status} on ${path}: ${body.slice(0, 300)}`, res.status);
  }
}

export type DatePosted = "yesterday" | "this-week" | "this-month" | "last-3-months" | "last-6-months" | "all-time";

export const socialFetch = {
  searchVideos: (
    query: string,
    opts: { cursor?: string; region?: string; sortBy?: "relevance" | "most-liked" | "date-posted"; datePosted?: DatePosted } = {},
  ) => get<SfListResponse>("/v1/tiktok/search", { query, ...opts }),
  searchHashtag: (hashtag: string, cursor?: string) =>
    get<SfListResponse>("/v1/tiktok/search/hashtags", { hashtag, cursor }),
  profileVideos: (handle: string, cursor?: string) =>
    get<SfListResponse>(`/v1/tiktok/profiles/${encodeURIComponent(handle)}/videos`, { cursor }),
  musicVideos: (clipId: string, cursor?: string) =>
    get<SfListResponse>(`/v1/tiktok/music/${encodeURIComponent(clipId)}/videos`, { cursor }),
  download: (url: string) => get<SfDownloadResponse>("/v1/tiktok/videos/download", { url }),
  // Same response shape as download, without hosted copies (1 credit). Used to refresh expired CDN links.
  getVideo: (url: string) => get<SfDownloadResponse>("/v1/tiktok/videos", { url }),
  instagramProfile: (handle: string) =>
    get<SfInstagramProfile>(`/v2/instagram/profiles/${encodeURIComponent(handle)}`, { include: "recentMedia" }),
  // tab "tagged" = posts by others in which the account is tagged (stage photos, fan photos).
  instagramMedia: (handle: string, tab: "posts" | "tagged", cursor?: string) =>
    get<SfInstagramMediaPage>(`/v2/instagram/profiles/${encodeURIComponent(handle)}/media`, { tab, cursor }),
  appleMusicSearch: (query: string) => get<SfAppleSearch>("/v1/apple-music/search", { query, type: "artist" }),
  spotifyArtist: (url: string) => get<SfSpotifyArtist>("/v1/spotify/artist", { url }),
  webSearch: (query: string) => get<SfWebSearch>("/v1/web/search", { query }),
};
