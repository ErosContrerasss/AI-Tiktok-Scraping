import { classifyArtist } from "@/lib/classify";
import { handle, jsonBody, type IdCtx } from "@/lib/http";

export const maxDuration = 800;

export const POST = handle(async (req, { params }: IdCtx) => {
  const body = await jsonBody(req);
  return classifyArtist((await params).id, {
    force: Boolean(body.force),
    limit: body.limit ? Number(body.limit) : undefined,
  });
});
