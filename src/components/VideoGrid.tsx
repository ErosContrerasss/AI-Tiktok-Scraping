"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import type { VideoStatusRow } from "@/lib/types";
import { formatCount } from "@/lib/util";

export type CleanInfo = {
  segments: { start_s: number; end_s: number; artist_p: number; inpaint?: boolean }[];
  clean_seconds: number;
  aspect: number | null;
  crop: { x: number; y: number; w: number; h: number } | null;
  crop_kind: "bars" | "edge" | null;
  refined_at: string | null; // cut points checked on the real mp4 at 2 frames a second
  quality: "hd" | "ok" | "low" | null;
  effective_height: number | null;
};
export type GridVideo = VideoStatusRow & { thumb: string | null; clean: CleanInfo | null };

const fmt = (s: number) => `${Math.floor(s / 60)}:${String(Math.round(s % 60)).padStart(2, "0")}`;

const STATUS_STYLE: Record<string, string> = {
  relevant: "bg-green-100 text-green-800",
  review: "bg-amber-100 text-amber-800",
  unrelated: "bg-zinc-200 text-zinc-600",
  own: "bg-blue-100 text-blue-800",
  out_of_region: "bg-zinc-100 text-zinc-500",
  unclassified: "bg-zinc-100 text-zinc-500",
};

export function VideoGrid({ videos }: { videos: GridVideo[] }) {
  const [playing, setPlaying] = useState<GridVideo | null>(null);
  return (
    <>
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6">
        {videos.map((v) => (
          <VideoCard key={v.id} v={v} onPlay={() => setPlaying(v)} />
        ))}
      </div>
      {playing && <Player video={playing} onClose={() => setPlaying(null)} />}
    </>
  );
}

function VideoCard({ v, onPlay }: { v: GridVideo; onPlay: () => void }) {
  const router = useRouter();
  const [vote, setVote] = useState(v.human_vote);
  const [download, setDownload] = useState<{ state: "idle" | "busy" | "done" | "error"; url?: string; msg?: string }>({
    state: "idle",
  });

  async function sendVote(up: boolean) {
    setVote(up);
    const res = await fetch(`/api/videos/${v.id}/vote`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ up, content_type: v.content_type && v.content_type !== "unrelated" ? v.content_type : undefined }),
    });
    if (res.ok) router.refresh();
  }

  async function startDownload() {
    if (!v.download_path && !confirm("Download kost 11 Social Fetch credits. Doorgaan?")) return;
    setDownload({ state: "busy" });
    const res = await fetch(`/api/videos/${v.id}/download`, { method: "POST" });
    const body = await res.json();
    if (!res.ok) return setDownload({ state: "error", msg: body.error });
    setDownload({ state: "done", url: body.url, msg: body.cached ? "uit opslag" : `${body.creditsUsed} credits` });
  }

  return (
    <div className="flex flex-col overflow-hidden rounded-lg border border-zinc-200 bg-white text-xs">
      <button onClick={onPlay} className="relative aspect-[9/16] bg-zinc-100" title="Afspelen">
        {v.thumb ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={v.thumb} alt="" loading="lazy" className="h-full w-full object-cover" />
        ) : (
          <span className="text-zinc-400">geen thumbnail</span>
        )}
        <span className={`absolute left-1 top-1 rounded px-1.5 py-0.5 text-[10px] font-medium ${STATUS_STYLE[v.status]}`}>
          {v.status}
          {v.relevance != null ? ` ${Math.round(v.relevance * 100)}%` : ""}
        </span>
        {v.content_type && (
          <span className="absolute right-1 top-1 rounded bg-black/60 px-1.5 py-0.5 text-[10px] text-white">{v.content_type}</span>
        )}
      </button>
      <div className="flex flex-1 flex-col gap-1 p-2">
        <a href={v.url ?? "#"} target="_blank" rel="noreferrer" className="truncate font-medium hover:underline">
          @{v.author_handle}
          {v.uploader_region ? <span className="ml-1 font-normal text-zinc-400">{v.uploader_region}</span> : null}
        </a>
        <div className="text-zinc-600">
          ▶ {formatCount(v.views)} · ♥ {formatCount(v.likes)} · {v.posted_at ? new Date(v.posted_at).toLocaleDateString("nl-NL") : "–"}
        </div>
        <div className="truncate text-zinc-500" title={v.sources.map((s) => `${s.type}: ${s.query}`).join("\n")}>
          {[...new Set(v.sources.map((s) => s.type))].join(", ")}
          {v.usability ? ` · bruikbaar ${v.usability}/5` : ""}
          {v.layer === "vision" ? " · 👁 frames gecheckt" : ""}
        </div>
        {v.clean && v.clean.segments.length > 0 && (
          <div className="text-emerald-700" title="Fragmenten met de artiest in beeld, zonder tekst of overlays. 🖌 = kleine tekst die met inpainting (LaMa/STTN) weggepoetst kan worden">
            ✂ {v.clean.segments.map((s) => `${fmt(s.start_s)}–${fmt(s.end_s)}${s.inpaint ? " 🖌" : ""}`).join(" · ")}
            {v.clean.aspect && v.clean.aspect > 0.7 ? ` · ${v.clean.aspect > 1.2 ? "liggend" : "vierkant"}` : ""}
            {v.clean.crop_kind === "bars" ? " · balken wegsnijden" : ""}
            {v.clean.crop_kind === "edge" && v.clean.crop
              ? ` · ${v.clean.crop.y > 0 ? "boven" : ""}${v.clean.crop.y > 0 && v.clean.crop.y + v.clean.crop.h < 0.999 ? "+" : ""}${v.clean.crop.y + v.clean.crop.h < 0.999 ? "onder" : ""} bijsnijden (zoom ${(1 / v.clean.crop.h).toFixed(2).replace(".", ",")}×)`
              : ""}
            {v.clean.refined_at
              ? ` · ✓ verfijnd${v.clean.quality ? `, kwaliteit ${v.clean.quality} (${v.clean.effective_height}px)` : ""}`
              : " · grove schatting"}
          </div>
        )}
        <p className="line-clamp-2 text-zinc-500" title={`${v.caption ?? ""}\n\n${v.layer ?? ""}: ${v.reason ?? ""}`}>
          {v.caption}
        </p>
        <div className="mt-auto flex items-center gap-1 pt-1">
          <button
            onClick={() => sendVote(true)}
            className={`rounded border px-2 py-1 ${vote === true ? "border-green-600 bg-green-50" : "border-zinc-300"}`}
            title="Relevant"
          >
            👍
          </button>
          <button
            onClick={() => sendVote(false)}
            className={`rounded border px-2 py-1 ${vote === false ? "border-red-600 bg-red-50" : "border-zinc-300"}`}
            title="Niet relevant"
          >
            👎
          </button>
          {download.state === "done" ? (
            <a href={download.url} className="ml-auto rounded bg-green-700 px-2 py-1 text-white" title={download.msg}>
              mp4 ↓
            </a>
          ) : (
            <button
              onClick={startDownload}
              disabled={download.state === "busy"}
              className="ml-auto rounded border border-zinc-300 px-2 py-1 disabled:opacity-50"
              title={v.download_path ? "Al gedownload" : "Download (11 credits)"}
            >
              {download.state === "busy" ? "…" : v.download_path ? "mp4" : "Download"}
            </button>
          )}
        </div>
        {download.state === "error" && <p className="text-red-600">{download.msg}</p>}
      </div>
    </div>
  );
}

function Player({ video, onClose }: { video: GridVideo; onClose: () => void }) {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4" onClick={onClose}>
      <div className="flex max-h-full flex-col gap-2" onClick={(e) => e.stopPropagation()}>
        <iframe
          src={`https://www.tiktok.com/player/v1/${video.id}?autoplay=1&rel=0`}
          className="aspect-[9/16] h-[80vh] max-w-full rounded-lg bg-black"
          allow="autoplay; fullscreen; encrypted-media"
          allowFullScreen
        />
        <div className="flex justify-between text-xs text-white">
          <span className="max-w-md truncate">{video.reason}</span>
          <button onClick={onClose} className="underline">
            sluiten
          </button>
        </div>
      </div>
    </div>
  );
}
