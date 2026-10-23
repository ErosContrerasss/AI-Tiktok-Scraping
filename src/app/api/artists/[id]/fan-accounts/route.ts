import { z } from "zod";
import { getArtist } from "@/lib/artists";
import { handle, jsonBody, type IdCtx } from "@/lib/http";
import { db } from "@/lib/supabase";

const Body = z.object({ handle: z.string().trim().min(1) });

// Adds one account to the artist's fan_accounts (fetched in full on the next ingest).
export const POST = handle(async (req, { params }: IdCtx) => {
  const { id } = await params;
  const handleName = Body.parse(await jsonBody(req)).handle.replace(/^@/, "").toLowerCase();
  const artist = await getArtist(id);
  if (!artist) throw new Error("Artist not found");
  if (artist.fan_accounts.includes(handleName)) return { fan_accounts: artist.fan_accounts };
  const fan_accounts = [...artist.fan_accounts, handleName];
  const { error } = await db().from("artists").update({ fan_accounts }).eq("id", id);
  if (error) throw new Error(error.message);
  return { fan_accounts };
});
