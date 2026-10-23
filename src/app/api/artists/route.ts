import { createArtist, listArtists } from "@/lib/artists";
import { handle, jsonBody } from "@/lib/http";

export const GET = handle(async () => listArtists());
export const POST = handle(async (req) => createArtist(await jsonBody(req)));
