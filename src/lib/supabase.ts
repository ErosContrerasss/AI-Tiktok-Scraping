import "server-only";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { env } from "./env";

let client: SupabaseClient | null = null;

// Service-role client. Server only: every table has RLS without policies.
export function db(): SupabaseClient {
  client ??= createClient(env.supabaseUrl(), env.supabaseServiceKey(), {
    auth: { persistSession: false },
  });
  return client;
}

export const THUMB_BUCKET = "thumbnails";
export const VIDEO_BUCKET = "videos";

export function publicThumbUrl(path: string | null): string | null {
  if (!path) return null;
  return db().storage.from(THUMB_BUCKET).getPublicUrl(path).data.publicUrl;
}
