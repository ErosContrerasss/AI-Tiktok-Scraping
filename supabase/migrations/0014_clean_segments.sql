-- Usable fragments per usable video, for redistribution: stretches where the artist is on
-- screen, with no overlaid text (a small corner watermark is allowed) and no black frames.
-- Derived from the per-frame results of the frames check plus a pixel check of the stored
-- frames (black bars, black frames); one row per video, recomputed on demand.
create table video_segments (
  video_id text primary key references videos(id) on delete cascade,
  artist_id uuid not null references artists(id) on delete cascade,
  duration_s real,
  clean_seconds real not null default 0, -- total length of the segments
  segments jsonb not null default '[]',  -- [{start_s, end_s, artist_p}]
  crop jsonb,                            -- content area as fractions {x, y, w, h} when there are black bars
  aspect real,                           -- width / height of the source (0.56 = vertical 9:16, 1 = square, 1.78 = landscape)
  is_edit boolean not null default false, -- already a montage of other footage (fan edit)
  analysed_at timestamptz not null default now()
);
create index video_segments_artist_idx on video_segments(artist_id, clean_seconds desc);
alter table video_segments enable row level security;

-- The dashboard's "alleen schone fragmenten" filter.
create view video_library with (security_invoker = true) as
select s.*, g.clean_seconds, g.segments, g.aspect, g.crop, g.is_edit
from video_status s join video_segments g on g.video_id = s.id
where s.status = 'relevant' and g.clean_seconds > 0;
