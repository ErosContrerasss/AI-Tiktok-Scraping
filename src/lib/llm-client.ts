import "server-only";
import Anthropic from "@anthropic-ai/sdk";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import { GoogleGenAI } from "@google/genai";
import { z } from "zod";
import { config, env } from "./env";

// One structured-output call (Zod schema) on Claude or Gemini, with fallback:
// when Anthropic refuses for account reasons (no credit, bad key) and a Gemini key
// is set, the rest of the process switches to Gemini.

export type Provider = { name: "anthropic" | "gemini"; model: string };

let anthropicUnavailable = false;

export function llmProvider(): Provider | null {
  const preferred = process.env.LLM_PROVIDER;
  const anthropic = env.anthropicKey() && !anthropicUnavailable ? { name: "anthropic" as const, model: config.anthropicModel } : null;
  const gemini = env.geminiKey() ? { name: "gemini" as const, model: config.geminiModel } : null;
  return preferred === "gemini" ? (gemini ?? anthropic) : (anthropic ?? gemini);
}

type Request = { system: string; text: string; images?: Buffer[]; maxTokens?: number; effort?: "low" | "medium" };

let anthropicClient: Anthropic | null = null;
let geminiClient: GoogleGenAI | null = null;

export async function generateStructured<S extends z.ZodType>(schema: S, req: Request): Promise<{ data: z.infer<S>; model: string }> {
  const provider = llmProvider();
  if (!provider) throw new Error("Set ANTHROPIC_API_KEY or GEMINI_API_KEY in .env.local");
  const geminiModel = req.images?.length ? config.geminiVisionModel : config.geminiModel;
  if (provider.name === "gemini") return { data: await askGemini(schema, req, geminiModel), model: geminiModel };
  try {
    return { data: await askAnthropic(schema, req, provider.model), model: provider.model };
  } catch (e) {
    if (isAccountError(e) && env.geminiKey()) {
      anthropicUnavailable = true;
      console.warn(`Anthropic unavailable (${(e as Error).message.slice(0, 120)}), falling back to Gemini`);
      return { data: await askGemini(schema, req, geminiModel), model: geminiModel };
    }
    throw e;
  }
}

function isAccountError(e: unknown): boolean {
  if (!(e instanceof Anthropic.APIError)) return false;
  return e.status === 401 || e.status === 403 || (e.status === 400 && /credit balance/i.test(e.message));
}

async function askAnthropic<S extends z.ZodType>(schema: S, req: Request, model: string): Promise<z.infer<S>> {
  anthropicClient ??= new Anthropic({ apiKey: env.anthropicKey() });
  const response = await anthropicClient.messages.parse({
    model,
    max_tokens: req.maxTokens ?? 1024,
    system: req.system,
    messages: [
      {
        role: "user",
        content: [
          ...(req.images ?? []).map((img) => ({
            type: "image" as const,
            source: { type: "base64" as const, media_type: "image/jpeg" as const, data: img.toString("base64") },
          })),
          { type: "text" as const, text: req.text },
        ],
      },
    ],
    output_config: { effort: req.effort ?? "low", format: zodOutputFormat(schema) },
  });
  if (!response.parsed_output) throw new Error(`No structured output (stop_reason: ${response.stop_reason})`);
  return response.parsed_output as z.infer<S>;
}

async function askGemini<S extends z.ZodType>(schema: S, req: Request, model: string): Promise<z.infer<S>> {
  geminiClient ??= new GoogleGenAI({ apiKey: env.geminiKey() });
  const response = await geminiClient.models.generateContent({
    model,
    contents: [
      {
        role: "user",
        parts: [
          ...(req.images ?? []).map((img) => ({ inlineData: { mimeType: "image/jpeg", data: img.toString("base64") } })),
          { text: req.text },
        ],
      },
    ],
    config: {
      systemInstruction: req.system,
      responseMimeType: "application/json",
      responseJsonSchema: z.toJSONSchema(schema),
    },
  });
  return schema.parse(JSON.parse(response.text ?? ""));
}
