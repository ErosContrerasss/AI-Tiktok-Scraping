import { z } from "zod";
import { getArtist } from "@/lib/artists";
import { handle, jsonBody, type IdCtx } from "@/lib/http";
import { buildArtistSheet, SHEET_BUCKET } from "@/lib/sheet";
import { db } from "@/lib/supabase";

export const maxDuration = 300;

// (Re)build the artist sheet from TikTok, Instagram, Apple Music and Spotify (~8-10 credits).
export const POST = handle(async (_req, { params }: IdCtx) => {
  const artist = await getArtist((await params).id);
  if (!artist) throw new Error("Artist not found");
  return buildArtistSheet(artist);
});

// Remove one photo from the sheet, e.g. when it shows someone else.
export const DELETE = handle(async (req, { params }: IdCtx) => {
  const { id } = await params;
  const { path } = z.object({ path: z.string().min(1) }).parse(await jsonBody(req));
  const artist = await getArtist(id);
  if (!artist) throw new Error("Artist not found");
  const artist_sheet = artist.artist_sheet.filter((e) => e.path !== path);
  await db().storage.from(SHEET_BUCKET).remove([path]);
  const { error } = await db().from("artists").update({ artist_sheet }).eq("id", id);
  if (error) throw new Error(error.message);
  return { artist_sheet };
});
