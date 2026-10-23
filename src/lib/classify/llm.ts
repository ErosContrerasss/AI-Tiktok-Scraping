import "server-only";
import { z } from "zod";
import { generateStructured } from "../llm-client";
import { CONTENT_TYPES, type Artist, type VideoRow, type Verdict } from "../types";
import { truncate } from "../util";

export { llmProvider } from "../llm-client";

// Layer 1: LLM on text metadata (caption, hashtags, author, sound, optional transcript).

export const LlmVerdictSchema = z.object({
  // One unambiguous number; is_about_artist + confidence are derived from it.
  on_screen_probability: z
    .number()
    .describe("0-1: probability that this specific artist appears on screen in the video (footage of them)."),
  content_type: z.enum(CONTENT_TYPES),
  usability: z.number().describe("1-5: how usable this footage is for the artist's own channels (5 = clear, close, on-brand footage)."),
  reason: z.string().describe("One short sentence explaining the verdict."),
});

export type LlmInput = Pick<VideoRow, "author_handle" | "caption" | "hashtags" | "sound_title" | "sound_author"> & {
  transcript?: string | null;
  hints?: string[];
};

export type FewShot = LlmInput & { is_about_artist: boolean };


function systemPrompt(artist: Artist, examples: FewShot[]): string {
  const list = (xs: string[]) => (xs.length ? xs.join(", ") : "(none)");
  let prompt = `You filter TikTok search results for a music marketing team. They collect FOOTAGE OF THE ARTIST below that was posted by other accounts: fans filming a show, festival or venue clips, interviews, podcasts, TV fragments, meet & greets, backstage moments, fan edits made from footage of the artist.

Estimate per video the probability that the artist APPEARS ON SCREEN (on_screen_probability). You only see text metadata, so infer it from caption, hashtags, author and sound.
Low probability when:
- the video only uses the artist's song or sound (people dancing, lip-syncing, vlogs, outfit checks with their track);
- the artist is only mentioned, tagged or quoted, without footage of them;
- it is about someone or something else with the same name (other artists, people, words in other languages).
Signals for a high probability: filmed at a show/festival/venue ("optreden", "live", "show", "concert", venue or festival names), "met X", interview/podcast/TV context, a fan account dedicated to the artist, fan edits of the artist.

Calibrating on_screen_probability: you can never see the video, so do NOT lower it just for that.
- 0.9-1.0: caption/hashtags clearly place the artist at a show, venue, festival, interview or meeting (e.g. "@artist - Zwarte Cross #concert", a venue account posting "X komt op bij artist"), or a fan account dedicated to the artist posts a clip/edit of them.
- 0.6-0.8: probably footage of the artist, but it could also be just their song or a mention.
- 0.3-0.5: weak signals only.
- 0.0-0.2: song/sound only, only a mention, or someone/something else.
content_type must agree: sound_only and unrelated mean a low probability.

ARTIST CARD
Name: ${artist.name}${artist.region ? `\nCountry/market: ${artist.region}` : ""}${artist.notes ? `\nAbout: ${artist.notes}` : ""}
Aliases: ${list(artist.aliases)}
Own TikTok accounts: ${list(artist.handles.map((h) => "@" + h.replace(/^@/, "")))}
Known fan accounts (mostly post footage of the artist, often with short captions): ${list(artist.fan_accounts.map((h) => "@" + h))}
Songs: ${list(artist.song_titles)}
Collaborators: ${list(artist.collaborators)}
Known false positives / negative terms: ${list(artist.negative_terms)}

content_type:
- own_post: ONLY when the author is one of the artist's own accounts listed above. Posts by collaborators, venues, media or fans are never own_post
- live_concert: the artist performing (concert, festival, club show), filmed by anyone
- fan_edit: edit or compilation made from footage of the artist
- interview: interview, podcast, TV/radio, backstage or meet & greet talk with the artist
- meme: meme or trend video in which the artist appears
- sound_only: uses the artist's song/sound, artist not on screen
- unrelated: not about this artist

usability: 1-5, how useful the footage is for the artist's own channels (clear, close, good-quality footage of the artist scores high; shaky, far away or barely visible scores low; not on screen = 1).`;

  if (examples.length) {
    prompt += `\n\nEXAMPLES JUDGED BY THE TEAM\n`;
    for (const ex of examples)
      prompt += `${describe(ex)}\n=> artist on screen: ${ex.is_about_artist ? "yes (1.0)" : "no (0.0)"}\n\n`;
  }
  return prompt;
}

function describe(v: LlmInput): string {
  const lines = [
    `Author: @${v.author_handle ?? "?"}`,
    `Caption: ${v.caption ? truncate(v.caption, 600) : "(empty)"}`,
    `Hashtags: ${v.hashtags.length ? v.hashtags.map((h) => "#" + h).join(" ") : "(none)"}`,
    `Sound: ${v.sound_title ?? "?"}${v.sound_author ? ` — ${v.sound_author}` : ""}`,
  ];
  if (v.transcript) lines.push(`Transcript: ${truncate(v.transcript, 1500)}`);
  if (v.hints?.length) lines.push(`Rule hints: ${v.hints.join("; ")}`);
  return lines.join("\n");
}


const FRAMES_INSTRUCTION = `You also get frames sampled from the video (in order). Use them to judge what kind of footage it is and how usable it is: a stage performance, crowd filming a show, an interview or podcast setup, a meet & greet, versus someone dancing or lip-syncing to a song, a lyric/text screen, a still image or unrelated content.
The artist is the one on the ARTIST CARD. If caption, hashtags or on-screen text show the video is about a different person or act (another artist, a namesake, a collaborator on their own), on_screen_probability must be near 0, however good the footage is. A collaborator's own post only counts when the artist is in it too. Never assume the author is the artist's own account unless the handle is listed as such.
Do NOT try to recognise who a person is from their face. Who it is follows from the metadata; the frames tell you whether the video actually shows that kind of footage, so let them raise or lower on_screen_probability accordingly. Base usability on what you see (sharpness, light, distance, how prominently the performer is visible).`;

// Layer 1 (text only) and layer 2 "vision" (same question, plus video frames).
export async function classifyWithLlm(
  artist: Artist,
  video: LlmInput,
  examples: FewShot[],
  frames: Buffer[] = [],
): Promise<Verdict & { model: string }> {
  const system = systemPrompt(artist, examples) + (frames.length ? `\n\n${FRAMES_INSTRUCTION}` : "");
  const user = `Classify this video:\n${describe(video)}`;

  const { data: parsed, model } = await generateStructured(LlmVerdictSchema, { system, text: user, images: frames });

  // Guard: own_post is reserved for the artist's own accounts (the rules layer handles those).
  const own = artist.handles.map((h) => h.replace(/^@/, "").toLowerCase());
  const contentType =
    parsed.content_type === "own_post" && !own.includes((video.author_handle ?? "").toLowerCase())
      ? null
      : parsed.content_type;

  let p = Math.min(1, Math.max(0, parsed.on_screen_probability));
  // Contradictory answer (likely on screen but "unrelated"/"sound_only"): send it to review.
  if (contentType === "unrelated" || contentType === "sound_only") p = Math.min(p, 0.6);

  return {
    is_about_artist: p >= 0.5,
    confidence: p >= 0.5 ? p : 1 - p,
    content_type: contentType,
    usability: Math.min(5, Math.max(1, Math.round(parsed.usability))),
    reason: parsed.reason,
    model,
  };
}
