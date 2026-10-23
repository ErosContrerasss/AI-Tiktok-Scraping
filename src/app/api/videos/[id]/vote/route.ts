import { db } from "@/lib/supabase";
import { CONTENT_TYPES } from "@/lib/types";
import { z } from "zod";
import { handle, jsonBody, type IdCtx } from "@/lib/http";

const Vote = z.object({ up: z.boolean(), content_type: z.enum(CONTENT_TYPES).optional() });

// Thumbs up/down = a human-layer classification (overrides rules and LLM).
export const POST = handle(async (req, { params }: IdCtx) => {
  const { up, content_type } = Vote.parse(await jsonBody(req));
  const { error } = await db().from("classifications").insert({
    video_id: (await params).id,
    layer: "human",
    is_about_artist: up,
    confidence: 1,
    content_type: up ? (content_type ?? null) : "unrelated",
    reason: up ? "Thumbs up" : "Thumbs down",
  });
  if (error) throw new Error(error.message);
  // A video that turns out not to show the artist shouldn't shape the playbook.
  if (!up) await db().from("video_breakdowns").delete().eq("video_id", (await params).id);
  return { ok: true };
});
