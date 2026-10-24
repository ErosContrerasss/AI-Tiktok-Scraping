-- Refining a video's fragments when it's about to be used: the real mp4 at 2 frames per second
-- (instead of 12 frames over the whole video) gives cut points to the half second and catches
-- gaps; the mp4 also tells the real resolution, so a crop that has to be zoomed too far shows.
alter table video_segments add column refined_at timestamptz;
alter table video_segments add column coarse_segments jsonb;   -- the 12-frame estimate, kept for comparison
alter table video_segments add column source_width int;
alter table video_segments add column source_height int;
alter table video_segments add column effective_height int;    -- pixels left for a 1080x1920 vertical after crop + zoom
alter table video_segments add column quality text check (quality in ('hd', 'ok', 'low'));
