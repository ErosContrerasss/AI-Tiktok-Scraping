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

export const socialFetch = {
  searchVideos: (
    query: string,
    opts: { cursor?: string; region?: string; sortBy?: "relevance" | "most-liked" | "date-posted" } = {},
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
};
