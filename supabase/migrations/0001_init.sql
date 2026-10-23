-- Artist Radar: initial schema.
-- All access goes through Next.js server code with the service role key,
-- so RLS is enabled without policies (anon/authenticated get nothing).

create table artists (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  aliases text[] not null default '{}',
  handles text[] not null default '{}',          -- the artist's own TikTok accounts (without @)
  hashtags text[] not null default '{}',         -- hashtags to search (without #)
  song_titles text[] not null default '{}',
  sound_ids text[] not null default '{}',        -- TikTok music clip ids
  collaborators text[] not null default '{}',
  negative_terms text[] not null default '{}',
  blocked_accounts text[] not null default '{}',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table videos (
  id text primary key,                            -- TikTok video id
  artist_id uuid not null references artists(id) on delete cascade,
  url text,
  author_handle text,
  caption text,
  hashtags text[] not null default '{}',
  sound_id text,
  sound_title text,
  sound_author text,
  views bigint,
  likes bigint,
  comments bigint,
  shares bigint,
  duration_ms integer,
  posted_at timestamptz,
  thumbnail_url text,
  thumbnail_cached_path text,
  sources jsonb not null default '[]',            -- [{type: search|hashtag|profile|sound, query}]
  first_seen_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now(),
  raw jsonb
);
create index videos_artist_idx on videos(artist_id);
create index videos_views_idx on videos(artist_id, views desc nulls last);

-- Append-only: every layer writes its own rows. The effective verdict is
-- picked in the video_status view (human > rules > llm, newest first).
create table classifications (
  id bigint generated always as identity primary key,
  video_id text not null references videos(id) on delete cascade,
  layer text not null check (layer in ('rules', 'llm', 'human')),
  is_about_artist boolean not null,
  confidence real not null check (confidence between 0 and 1),
  content_type text check (content_type in
    ('own_post', 'live_concert', 'fan_edit', 'interview', 'meme', 'sound_only', 'unrelated')),
  usability smallint check (usability between 1 and 5),
  reason text,
  model text,
  created_at timestamptz not null default now()
);
create index classifications_video_idx on classifications(video_id, created_at desc);

create table downloads (
  id bigint generated always as identity primary key,
  video_id text not null references videos(id) on delete cascade,
  storage_path text not null,
  credits_used integer not null default 0,
  downloaded_at timestamptz not null default now()
);
create index downloads_video_idx on downloads(video_id);

create table ingest_runs (
  id bigint generated always as identity primary key,
  artist_id uuid not null references artists(id) on delete cascade,
  started_at timestamptz not null default now(),
  finished_at timestamptz,
  credits_used integer not null default 0,
  stats jsonb not null default '{}',
  error text
);
create index ingest_runs_artist_idx on ingest_runs(artist_id, started_at desc);

alter table artists enable row level security;
alter table videos enable row level security;
alter table classifications enable row level security;
alter table downloads enable row level security;
alter table ingest_runs enable row level security;

-- Effective classification per video + routing into relevant/review/unrelated.
-- relevance = probability the video is about the artist.
create view video_status with (security_invoker = true) as
with ranked as (
  select c.*,
    row_number() over (
      partition by c.video_id
      order by case c.layer when 'human' then 0 when 'rules' then 1 else 2 end, c.created_at desc
    ) as rn
  from classifications c
)
select
  v.*,
  r.layer,
  r.is_about_artist,
  r.confidence,
  -- a decisive rules/human verdict may not carry content_type/usability; fall back to the latest LLM row
  coalesce(r.content_type, l.content_type) as content_type,
  coalesce(r.usability, l.usability) as usability,
  r.reason,
  case when r.is_about_artist then r.confidence else 1 - r.confidence end as relevance,
  case
    when r.id is null then 'unclassified'
    when (case when r.is_about_artist then r.confidence else 1 - r.confidence end) >= 0.85 then 'relevant'
    when (case when r.is_about_artist then r.confidence else 1 - r.confidence end) <= 0.3 then 'unrelated'
    else 'review'
  end as status,
  (select h.is_about_artist from classifications h
    where h.video_id = v.id and h.layer = 'human'
    order by h.created_at desc limit 1) as human_vote,
  (select d.storage_path from downloads d
    where d.video_id = v.id order by d.downloaded_at desc limit 1) as download_path
from videos v
left join ranked r on r.video_id = v.id and r.rn = 1
left join lateral (
  select c.content_type, c.usability from classifications c
  where c.video_id = v.id and c.layer = 'llm'
  order by c.created_at desc limit 1
) l on true;

-- Storage: thumbnails are public (cached covers), videos are private (signed URLs).
insert into storage.buckets (id, name, public) values ('thumbnails', 'thumbnails', true)
  on conflict (id) do nothing;
insert into storage.buckets (id, name, public) values ('videos', 'videos', false)
  on conflict (id) do nothing;
