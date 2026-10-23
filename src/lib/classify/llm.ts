import "server-only";
import Anthropic from "@anthropic-ai/sdk";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import { GoogleGenAI } from "@google/genai";
import { z } from "zod";
import { config, env } from "../env";
import { CONTENT_TYPES, type Artist, type VideoRow, type Verdict } from "../types";

// Layer 1: LLM on text metadata (caption, hashtags, author, sound, optional transcript).

export const LlmVerdictSchema = z.object({
  is_about_artist: z.boolean().describe("True if the video is genuinely about / features this specific artist or their music."),
  confidence: z.number().describe("0-1: how sure you are that is_about_artist is correct."),
  content_type: z.enum(CONTENT_TYPES),
  usability: z.number().describe("1-5: how usable this clip is for the artist's own marketing (5 = great, on-brand, clear footage)."),
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
  let prompt = `You filter TikTok search results for a music marketing team. Decide whether each video is about the artist below.
Search by name returns lots of noise: other people or things with the same name, unrelated words in other languages, random trending content. Only mark is_about_artist=true when the metadata points to THIS artist.

ARTIST CARD
Name: ${artist.name}${artist.region ? `\nCountry/market: ${artist.region}` : ""}${artist.notes ? `\nAbout: ${artist.notes}` : ""}
Aliases: ${list(artist.aliases)}
Own TikTok accounts: ${list(artist.handles.map((h) => "@" + h.replace(/^@/, "")))}
Songs: ${list(artist.song_titles)}
Collaborators: ${list(artist.collaborators)}
Known false positives / negative terms: ${list(artist.negative_terms)}

content_type:
- own_post: ONLY when the author is one of the artist's own accounts listed above. Posts by collaborators, venues, media or fans are never own_post
- live_concert: concert / festival / live performance footage
- fan_edit: fan-made edit, compilation, cover or tribute
- interview: interview, podcast, talk show, backstage talk
- meme: meme, joke or trend format referencing the artist
- sound_only: uses the artist's song as background sound but the video itself is about something else
- unrelated: not about the artist

usability: 1-5, how useful the clip would be for the artist's own channels (live footage and strong fan edits score high; low-effort or off-topic content scores low; unrelated = 1).`;

  if (examples.length) {
    prompt += `\n\nEXAMPLES JUDGED BY THE TEAM\n`;
    for (const ex of examples)
      prompt += `${describe(ex)}\n=> is_about_artist: ${ex.is_about_artist}\n\n`;
  }
  return prompt;
}

function describe(v: LlmInput): string {
  const lines = [
    `Author: @${v.author_handle ?? "?"}`,
    `Caption: ${v.caption?.slice(0, 600) || "(empty)"}`,
    `Hashtags: ${v.hashtags.length ? v.hashtags.map((h) => "#" + h).join(" ") : "(none)"}`,
    `Sound: ${v.sound_title ?? "?"}${v.sound_author ? ` — ${v.sound_author}` : ""}`,
  ];
  if (v.transcript) lines.push(`Transcript: ${v.transcript.slice(0, 1500)}`);
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

  return {
    is_about_artist: parsed.is_about_artist,
    confidence: Math.min(1, Math.max(0, parsed.confidence)),
    content_type: contentType,
    usability: Math.min(5, Math.max(1, Math.round(parsed.usability))),
    reason: parsed.reason,
    model: provider.model,
  };
}
