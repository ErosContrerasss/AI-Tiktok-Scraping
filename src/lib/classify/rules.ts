import type { Artist, VideoRow, Verdict } from "../types";

// Layer 0: deterministic rules. Returns a decisive verdict (stored) or hints for the LLM.

export type RulesResult = { verdict: Verdict | null; hints: string[] };

const norm = (s: string) => s.toLowerCase().replace(/^[@#]/, "").trim();

function containsTerm(haystack: string, term: string): boolean {
  const t = term.toLowerCase().trim();
  if (!t) return false;
  const escaped = t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(^|[^\\p{L}\\p{N}])${escaped}($|[^\\p{L}\\p{N}])`, "u").test(haystack);
}

export function applyRules(artist: Artist, v: Pick<VideoRow, "author_handle" | "caption" | "hashtags" | "sound_id" | "sound_title">): RulesResult {
  const author = norm(v.author_handle ?? "");
  const haystack = [v.caption ?? "", ...v.hashtags.map((h) => `#${h}`), v.sound_title ?? ""].join(" ").toLowerCase();

  if (author && artist.blocked_accounts.map(norm).includes(author))
    return { verdict: unrelated(`Blocked account @${author}`), hints: [] };

  if (author && artist.handles.map(norm).includes(author))
    return {
      verdict: { is_about_artist: true, confidence: 1, content_type: "own_post", usability: null, reason: `Own account @${author}` },
      hints: [],
    };

  if (v.sound_id && artist.sound_ids.includes(v.sound_id))
    return {
      verdict: { is_about_artist: true, confidence: 1, content_type: null, usability: null, reason: `Uses artist sound ${v.sound_id}` },
      hints: [],
    };

  const negative = artist.negative_terms.find((t) => containsTerm(haystack, t));
  if (negative) return { verdict: unrelated(`Negative term "${negative}"`), hints: [] };

  const hints: string[] = [];
  for (const h of artist.handles) if (haystack.includes(`@${norm(h)}`)) hints.push(`caption tags @${norm(h)}`);
  for (const s of artist.song_titles) if (containsTerm(haystack, s)) hints.push(`mentions song "${s}"`);
  for (const c of artist.collaborators) if (containsTerm(haystack, c)) hints.push(`mentions collaborator "${c}"`);
  return { verdict: null, hints };
}

function unrelated(reason: string): Verdict {
  return { is_about_artist: false, confidence: 1, content_type: "unrelated", usability: 1, reason };
}
