import "server-only";
import { z } from "zod";
import { env } from "./env";
import { generateStructured } from "./llm-client";
import { normalizeVideo, type NormalizedVideo } from "./normalize";
import { socialFetch } from "./socialfetch";
import { truncate } from "./util";

// Proposes an artist card from just a TikTok handle: profile + own posts (who they
// work with, which songs, which hashtags fans use) + one page of name search (which
// namesakes and noise to exclude). The user reviews the draft before saving.

const CardSchema = z.object({
  name: z.string().describe("Artist name as fans search for it (stage name, not the handle)"),
  aliases: z
    .array(z.string())
    .describe(
      "Other names/spellings fans use (real name, nicknames). Each alias becomes a search query, so only include ones specific to this artist: never a plain first name or common word",
    ),
  region: z.string().describe("Two-letter country code of the artist's main market, e.g. NL"),
  countries: z
    .array(z.string())
    .describe("Two-letter codes of the countries where most of the audience posting about this artist lives, e.g. [\"NL\", \"BE\"] for a Dutch-language artist. Empty for an artist with a worldwide audience"),
  notes: z
    .string()
    .describe("2-4 sentences: who the artist is (genre, city, scene, known shows), and namesakes it must NOT be confused with"),
  song_titles: z.array(z.string()).describe("The artist's own songs, from sound credits on their posts"),
  collaborators: z.array(z.string()).describe("Other artists they feature with"),
  hashtags: z.array(z.string()).describe("Hashtags (without #) that fans use specifically for this artist; skip generic ones like fyp"),
  negative_terms: z
    .array(z.string())
    .describe("Words/hashtags (not account names) that only appear in search noise about namesakes or other meanings of the name"),
  blocked_accounts: z
    .array(z.string())
    .describe("Handles (without @) from the search results that clearly belong to namesakes or unrelated topics"),
});

export type CardDraft = z.infer<typeof CardSchema> & { handles: string[]; credits: number };

const PROMPT = `You prepare an "artist card" for a tool that searches TikTok for footage of a music artist posted by other accounts.
From the artist's own profile and posts, and one page of TikTok search results for their name (which contains noise), propose the card.
Only use information you see in the data. Keep lists short and specific; leave a list empty rather than guess.`;

export async function proposeCard(handleInput: string): Promise<CardDraft> {
  const handle = handleInput.trim().replace(/^https?:\/\/(www\.)?tiktok\.com\//, "").replace(/^@/, "").split(/[/?#]/)[0].toLowerCase();
  if (!handle) throw new Error("Geen geldige TikTok-handle");
  let credits = 0;

  const profileRes = await fetch(`https://api.socialfetch.dev/v1/tiktok/profiles/${encodeURIComponent(handle)}`, {
    headers: { "x-api-key": env.socialFetchKey() },
  });
  const profileJson = await profileRes.json();
  credits += profileJson.meta?.creditsCharged ?? 0;
  if (profileJson.data?.lookupStatus !== "found") throw new Error(`TikTok-account @${handle} niet gevonden`);
  const profile = profileJson.data.profile ?? profileJson.data;

  const own: NormalizedVideo[] = [];
  let cursor: string | undefined;
  for (let page = 0; page < 3; page++) {
    const res = await socialFetch.profileVideos(handle, cursor);
    credits += res.meta.creditsCharged ?? 0;
    own.push(...res.data.videos.map(normalizeVideo));
    if (!res.data.page.hasMore || !res.data.page.nextCursor) break;
    cursor = res.data.page.nextCursor;
  }

  const searchName = profile.displayName?.replace(/[^\p{L}\p{N}\s.'-]/gu, "").trim() || handle;
  const search = await socialFetch.searchVideos(searchName);
  credits += search.meta.creditsCharged ?? 0;
  const noise = search.data.videos.map(normalizeVideo).filter((v) => v.author_handle !== handle);

  const line = (v: NormalizedVideo) =>
    `- @${v.author_handle}: ${truncate(v.caption ?? "", 160).replace(/\n/g, " ")} | sound: ${v.sound_title ?? "?"} — ${v.sound_author ?? "?"}`;
  const data = `PROFILE
Handle: @${handle}
Display name: ${profile.displayName ?? "?"}
Bio: ${profile.bio || "(empty)"}
Verified: ${profile.verified ? "yes" : "no"}

OWN POSTS (${own.length})
${own.map(line).join("\n")}

SEARCH RESULTS FOR "${searchName}" (other accounts, contains noise)
${noise.map(line).join("\n")}`;

  const { data: card } = await generateStructured(CardSchema, { system: PROMPT, text: data, maxTokens: 4096, effort: "medium" });

  return {
    ...card,
    region: card.region.toUpperCase().slice(0, 2),
    countries: card.countries.map((c) => c.toUpperCase().slice(0, 2)),
    hashtags: card.hashtags.map((h) => h.replace(/^#/, "").toLowerCase()),
    blocked_accounts: card.blocked_accounts.map((h) => h.replace(/^@/, "").toLowerCase()),
    handles: [handle],
    credits,
  };
}
