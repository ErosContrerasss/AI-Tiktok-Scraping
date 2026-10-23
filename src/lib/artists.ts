import "server-only";
import { z } from "zod";
import { db } from "./supabase";
import type { Artist } from "./types";

const list = z
  .union([z.array(z.string()), z.string()])
  .optional()
  .transform((v) => {
    const items = Array.isArray(v) ? v : (v ?? "").split(/[,\n]/);
    return [...new Set(items.map((s) => s.trim()).filter(Boolean))];
  });

export const ArtistInput = z.object({
  name: z.string().trim().min(1),
  aliases: list,
  handles: list,
  hashtags: list,
  song_titles: list,
  sound_ids: list,
  collaborators: list,
  negative_terms: list,
  blocked_accounts: list,
  fan_accounts: list,
  extra_queries: list,
  notes: z.string().optional().transform((v) => (v ?? "").trim()),
  instagram_handle: z
    .string()
    .optional()
    .nullable()
    .transform((v) => v?.trim().replace(/^@/, "").replace(/^https?:\/\/(www\.)?instagram\.com\//, "").split(/[/?#]/)[0].toLowerCase() || null),
  spotify_url: z
    .string()
    .optional()
    .nullable()
    .transform((v) => v?.trim() || null),
  region: z
    .string()
    .optional()
    .transform((v) => (v?.trim() ? v.trim().toUpperCase() : null)),
}) satisfies z.ZodType<Omit<Artist, "id" | "created_at" | "reference_images" | "artist_sheet" | "traits">>;

// Handles/accounts are stored lower-case without @, hashtags without #.
function clean(input: Omit<Artist, "id" | "created_at" | "reference_images" | "artist_sheet" | "traits">) {
  const strip = (xs: string[], prefix: string) => xs.map((x) => x.replace(new RegExp(`^${prefix}`), "").toLowerCase());
  return {
    ...input,
    handles: strip(input.handles, "@"),
    blocked_accounts: strip(input.blocked_accounts, "@"),
    fan_accounts: strip(input.fan_accounts, "@"),
    hashtags: strip(input.hashtags, "#"),
  };
}

export async function listArtists(): Promise<Artist[]> {
  const { data } = await db().from("artists").select("*").order("created_at");
  return (data ?? []) as Artist[];
}

export async function getArtist(id: string): Promise<Artist | null> {
  const { data } = await db().from("artists").select("*").eq("id", id).maybeSingle();
  return data as Artist | null;
}

export async function createArtist(body: unknown): Promise<Artist> {
  const { data, error } = await db().from("artists").insert(clean(ArtistInput.parse(body))).select("*").single();
  if (error) throw new Error(error.message);
  return data as Artist;
}

export async function updateArtist(id: string, body: unknown): Promise<Artist> {
  const { data, error } = await db()
    .from("artists")
    .update({ ...clean(ArtistInput.parse(body)), updated_at: new Date().toISOString() })
    .eq("id", id)
    .select("*")
    .single();
  if (error) throw new Error(error.message);
  return data as Artist;
}
