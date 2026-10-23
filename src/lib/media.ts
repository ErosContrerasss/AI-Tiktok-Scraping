import "server-only";
import { db } from "./supabase";

// All media (thumbnails, frames, artist sheets, downloaded videos) goes through this module,
// so the storage backend can change without touching the rest of the app. Today: Supabase
// Storage. For a large clip library, an S3-compatible store such as Cloudflare R2 (no egress
// fees) can implement the same interface, selected with MEDIA_STORE.

export const BUCKETS = {
  thumbnails: "thumbnails", // public: cached TikTok covers
  frames: "frames", // private: frames extracted for the vision layer
  sheets: "references", // private: artist sheet photos
  videos: "videos", // private: downloaded mp4s
} as const;
export type Bucket = (typeof BUCKETS)[keyof typeof BUCKETS];

export interface MediaStore {
  put(bucket: Bucket, path: string, data: Buffer, contentType: string): Promise<boolean>;
  get(bucket: Bucket, path: string): Promise<Buffer | null>;
  list(bucket: Bucket, prefix: string): Promise<string[]>; // file names directly under prefix, sorted
  remove(bucket: Bucket, paths: string[]): Promise<void>;
  signedUrl(bucket: Bucket, path: string, ttlSeconds: number, opts?: { download?: boolean }): Promise<string | null>;
  publicUrl(bucket: Bucket, path: string): string;
}

class SupabaseMediaStore implements MediaStore {
  async put(bucket: Bucket, path: string, data: Buffer, contentType: string) {
    const { error } = await db().storage.from(bucket).upload(path, data, { contentType, upsert: true });
    return !error;
  }

  async get(bucket: Bucket, path: string) {
    const { data } = await db().storage.from(bucket).download(path);
    return data ? Buffer.from(await data.arrayBuffer()) : null;
  }

  async list(bucket: Bucket, prefix: string) {
    const names: string[] = [];
    for (let offset = 0; ; offset += 1000) {
      const { data } = await db().storage.from(bucket).list(prefix, { limit: 1000, offset, sortBy: { column: "name", order: "asc" } });
      names.push(...(data ?? []).map((f) => f.name));
      if (!data || data.length < 1000) return names;
    }
  }

  async remove(bucket: Bucket, paths: string[]) {
    // The Storage API accepts up to 1000 paths per call.
    for (let i = 0; i < paths.length; i += 1000) await db().storage.from(bucket).remove(paths.slice(i, i + 1000));
  }

  async signedUrl(bucket: Bucket, path: string, ttlSeconds: number, opts?: { download?: boolean }) {
    const { data } = await db().storage.from(bucket).createSignedUrl(path, ttlSeconds, opts?.download ? { download: true } : undefined);
    return data?.signedUrl ?? null;
  }

  publicUrl(bucket: Bucket, path: string) {
    return db().storage.from(bucket).getPublicUrl(path).data.publicUrl;
  }
}

let store: MediaStore | null = null;

export function media(): MediaStore {
  if (!store) {
    const kind = process.env.MEDIA_STORE ?? "supabase";
    if (kind !== "supabase") throw new Error(`MEDIA_STORE=${kind} is not implemented yet (supported: supabase)`);
    store = new SupabaseMediaStore();
  }
  return store;
}

export function publicThumbUrl(path: string | null): string | null {
  return path ? media().publicUrl(BUCKETS.thumbnails, path) : null;
}
