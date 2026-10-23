import "server-only";
import { selectAll } from "./classify";
import type { Artist, Source, Status } from "./types";

export type FanAccountSuggestion = { handle: string; footage: number; review: number; views: number };

// Accounts that keep posting footage of the artist (fan pages, tour accounts,
// venues) are worth fetching in full via their profile.
export async function suggestFanAccounts(artist: Artist, limit = 8): Promise<FanAccountSuggestion[]> {
  const rows = await selectAll<{ author_handle: string | null; status: Status; views: number | null }>(
    "video_status",
    "author_handle, status, views",
    artist.id,
  );
  const skip = new Set([...artist.handles, ...artist.fan_accounts, ...artist.blocked_accounts]);
  const byAuthor = new Map<string, FanAccountSuggestion>();
  for (const r of rows) {
    if (!r.author_handle || skip.has(r.author_handle)) continue;
    if (r.status !== "relevant" && r.status !== "review") continue;
    const s = byAuthor.get(r.author_handle) ?? { handle: r.author_handle, footage: 0, review: 0, views: 0 };
    if (r.status === "relevant") s.footage++;
    else s.review++;
    s.views += r.views ?? 0;
    byAuthor.set(r.author_handle, s);
  }
  return [...byAuthor.values()]
    .filter((s) => s.footage >= 2 || (s.footage >= 1 && s.footage + s.review >= 3))
    .sort((a, b) => b.footage - a.footage || b.views - a.views)
    .slice(0, limit);
}

export type QueryYield = { type: string; query: string; footage: number; review: number; total: number };

// Footage found per search query / hashtag / account, to prune queries that only bring noise.
export async function queryYield(artistId: string): Promise<QueryYield[]> {
  const rows = await selectAll<{ status: Status; sources: Source[] }>("video_status", "status, sources", artistId);
  const byQuery = new Map<string, QueryYield>();
  for (const r of rows) {
    if (r.status === "own") continue;
    for (const s of r.sources ?? []) {
      const key = `${s.type}:${s.query}`;
      const y = byQuery.get(key) ?? { type: s.type, query: s.query, footage: 0, review: 0, total: 0 };
      y.total++;
      if (r.status === "relevant") y.footage++;
      if (r.status === "review") y.review++;
      byQuery.set(key, y);
    }
  }
  return [...byQuery.values()].sort((a, b) => b.footage - a.footage || b.review - a.review);
}
