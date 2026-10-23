import { z } from "zod";
import { proposeCard } from "@/lib/bootstrap";
import { handle, jsonBody } from "@/lib/http";

export const maxDuration = 120;

// Draft artist card from a TikTok handle or profile URL (~5 Social Fetch credits). Not saved.
export const POST = handle(async (req) => proposeCard(z.object({ handle: z.string().min(1) }).parse(await jsonBody(req)).handle));
