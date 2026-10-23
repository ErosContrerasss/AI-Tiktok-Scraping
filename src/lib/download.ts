import "server-only";
import { socialFetch } from "./socialfetch";
import { db, VIDEO_BUCKET } from "./supabase";

const SIGNED_URL_TTL = 60 * 60; // 1 hour

export type DownloadResult = { url: string; storagePath: string; creditsUsed: number; cached: boolean };

// On demand only: costs 11 Social Fetch credits per video. Re-requests reuse the stored mp4.
export async function downloadVideo(videoId: string): Promise<DownloadResult> {
  const supabase = db();
  const { data: video } = await supabase.from("videos").select("id, artist_id, url").eq("id", videoId).single();
  if (!video?.url) throw new Error(`Video ${videoId} not found`);

  const { data: prev } = await supabase
    .from("downloads")
    .select("storage_path")
    .eq("video_id", videoId)
    .order("downloaded_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (prev) return { url: await signedUrl(prev.storage_path), storagePath: prev.storage_path, creditsUsed: 0, cached: true };

  const res = await socialFetch.download(video.url);
  const credits = res.meta.creditsCharged ?? 0;
  if (res.data.lookupStatus !== "found") throw new Error(`Video not found on TikTok (charged ${credits} credit)`);
  if (res.data.video?.mediaType === "slideshow") throw new Error("This post is a photo slideshow, not a video");

  const mediaUrl =
    res.data.downloads.find((d) => d.type === "video")?.cdnUrl ??
    res.data.media?.downloadWithoutWatermarkUrl ??
    res.data.media?.downloadUrl;
  if (!mediaUrl) throw new Error("No downloadable media returned");

  const file = await fetch(mediaUrl, { cache: "no-store" });
  if (!file.ok) throw new Error(`Fetching media failed: ${file.status}`);
  const storagePath = `${video.artist_id}/${videoId}.mp4`;
  const { error } = await supabase.storage
    .from(VIDEO_BUCKET)
    .upload(storagePath, await file.arrayBuffer(), { contentType: "video/mp4", upsert: true });
  if (error) throw new Error(`Storage upload failed: ${error.message}`);

  await supabase.from("downloads").insert({ video_id: videoId, storage_path: storagePath, credits_used: credits });
  return { url: await signedUrl(storagePath), storagePath, creditsUsed: credits, cached: false };
}

export async function signedUrl(path: string): Promise<string> {
  const { data, error } = await db()
    .storage.from(VIDEO_BUCKET)
    .createSignedUrl(path, SIGNED_URL_TTL, { download: true });
  if (error || !data) throw new Error(`Signing URL failed: ${error?.message}`);
  return data.signedUrl;
}
