export const CONTENT_TYPES = [
  "own_post",
  "live_concert",
  "fan_edit",
  "interview",
  "meme",
  "sound_only",
  "unrelated",
] as const;
export type ContentType = (typeof CONTENT_TYPES)[number];

export const STATUSES = ["relevant", "review", "unrelated", "own", "unclassified"] as const;
export type Status = (typeof STATUSES)[number];

export type SourceType = "search" | "hashtag" | "fan_account" | "profile" | "sound";
export type Source = { type: SourceType; query: string };

export type Artist = {
  id: string;
  name: string;
  aliases: string[];
  handles: string[];
  hashtags: string[];
  song_titles: string[];
  sound_ids: string[];
  collaborators: string[];
  negative_terms: string[];
  blocked_accounts: string[];
  fan_accounts: string[];
  extra_queries: string[];
  notes: string;
  region: string | null;
  created_at: string;
};

export type VideoRow = {
  id: string;
  artist_id: string;
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
  thumbnail_cached_path: string | null;
  sources: Source[];
  first_seen_at: string;
};

export type VideoStatusRow = VideoRow & {
  layer: "rules" | "llm" | "human" | null;
  is_about_artist: boolean | null;
  confidence: number | null;
  content_type: ContentType | null;
  usability: number | null;
  reason: string | null;
  relevance: number | null;
  status: Status;
  human_vote: boolean | null;
  download_path: string | null;
};

export type Verdict = {
  is_about_artist: boolean;
  confidence: number;
  content_type: ContentType | null;
  usability: number | null;
  reason: string;
};
