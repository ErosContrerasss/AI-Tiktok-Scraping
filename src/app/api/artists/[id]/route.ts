import { getArtist, updateArtist } from "@/lib/artists";
import { handle, jsonBody, type IdCtx } from "@/lib/http";

export const GET = handle(async (_req, { params }: IdCtx) => getArtist((await params).id));
export const PUT = handle(async (req, { params }: IdCtx) => updateArtist((await params).id, await jsonBody(req)));
