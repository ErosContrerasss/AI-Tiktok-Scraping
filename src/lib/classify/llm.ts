import "server-only";
import Anthropic from "@anthropic-ai/sdk";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import { GoogleGenAI } from "@google/genai";
import { z } from "zod";
import { config, env } from "../env";
import { CONTENT_TYPES, type Artist, type VideoRow, type Verdict } from "../types";
import { truncate } from "../util";

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

export function llmProvider(): { name: "anthropic" | "gemini"; model: string } | null {
  if (env.anthropicKey()) return { name: "anthropic", model: config.anthropicModel };
  if (env.geminiKey()) return { name: "gemini", model: config.geminiModel };
  return null;
}

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

let anthropic: Anthropic | null = null;
let gemini: GoogleGenAI | null = null;

export async function classifyWithLlm(artist: Artist, video: LlmInput, examples: FewShot[]): Promise<Verdict & { model: string }> {
  const provider = llmProvider();
  if (!provider) throw new Error("Set ANTHROPIC_API_KEY or GEMINI_API_KEY in .env.local");
  const system = systemPrompt(artist, examples);
  const user = `Classify this video:\n${describe(video)}`;

  let parsed: z.infer<typeof LlmVerdictSchema>;
  if (provider.name === "anthropic") {
    anthropic ??= new Anthropic({ apiKey: env.anthropicKey() });
    const response = await anthropic.messages.parse({
      model: provider.model,
      max_tokens: 1024,
      system,
      messages: [{ role: "user", content: user }],
      output_config: { effort: "low", format: zodOutputFormat(LlmVerdictSchema) },
    });
    if (!response.parsed_output) throw new Error(`No structured output (stop_reason: ${response.stop_reason})`);
    parsed = response.parsed_output;
  } else {
    gemini ??= new GoogleGenAI({ apiKey: env.geminiKey() });
    const response = await gemini.models.generateContent({
      model: provider.model,
      contents: user,
      config: {
        systemInstruction: system,
        responseMimeType: "application/json",
        responseJsonSchema: z.toJSONSchema(LlmVerdictSchema),
      },
    });
    parsed = LlmVerdictSchema.parse(JSON.parse(response.text ?? ""));
  }

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
    model: provider.model,
  };
}
