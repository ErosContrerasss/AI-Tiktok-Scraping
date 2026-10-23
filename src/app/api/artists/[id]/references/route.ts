import { z } from "zod";
import { getArtist } from "@/lib/artists";
import { handle, jsonBody, type IdCtx } from "@/lib/http";
import { buildReferences, REFERENCE_BUCKET } from "@/lib/references";
import { db } from "@/lib/supabase";

export const maxDuration = 120;

// Re-pick reference photos automatically (profile picture + matching covers).
export const POST = handle(async (_req, { params }: IdCtx) => {
  const artist = await getArtist((await params).id);
  if (!artist) throw new Error("Artist not found");
  return buildReferences(artist);
});

// Remove one reference photo, e.g. when it shows someone else.
export const DELETE = handle(async (req, { params }: IdCtx) => {
  const { id } = await params;
  const { path } = z.object({ path: z.string().min(1) }).parse(await jsonBody(req));
  const artist = await getArtist(id);
  if (!artist) throw new Error("Artist not found");
  const reference_images = artist.reference_images.filter((p) => p !== path);
  await db().storage.from(REFERENCE_BUCKET).remove([path]);
  const { error } = await db().from("artists").update({ reference_images }).eq("id", id);
  if (error) throw new Error(error.message);
  return { reference_images };
});
