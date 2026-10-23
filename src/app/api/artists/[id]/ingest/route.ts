import { ingestArtist } from "@/lib/ingest";
import { handle, jsonBody, type IdCtx } from "@/lib/http";

export const maxDuration = 800;

export const POST = handle(async (req, { params }: IdCtx) => {
  const body = await jsonBody(req);
  const maxPages = body.maxPages ? Math.max(1, Math.min(20, Number(body.maxPages))) : undefined;
  return ingestArtist((await params).id, {
    maxPages,
    mode: body.mode === "refresh" ? "refresh" : "full",
    includeOwnProfile: Boolean(body.includeOwnProfile),
    includeSounds: Boolean(body.includeSounds),
  });
});
