-- Groundwork for the playbook (later: which videos outperform their uploader, and how are
-- they built). Collected now, because past performance can't be measured afterwards:
-- - saves and the uploader's follower count per video;
-- - video_stats: a snapshot of the numbers at every ingest, so growth over time is visible;
-- - video_performance: engagement rate and views per follower (an outlier signal that
--   doesn't just reward big accounts; +1000 keeps tiny accounts from exploding).
alter table videos add column if not exists saves bigint;
alter table videos add column if not exists author_followers bigint;
update videos set saves = (raw->'stats'->>'saves')::bigint where raw->'stats' ? 'saves';

create table if not exists video_stats (
  video_id text not null references videos(id) on delete cascade,
  captured_at timestamptz not null default now(),
  views bigint,
  likes bigint,
  comments bigint,
  shares bigint,
  saves bigint,
  author_followers bigint,
  primary key (video_id, captured_at)
);
alter table video_stats enable row level security;
insert into video_stats (video_id, captured_at, views, likes, comments, shares, saves)
select id, last_seen_at, views, likes, comments, shares, saves from videos
on conflict do nothing;

create view video_performance with (security_invoker = true) as
select
  v.id,
  v.artist_id,
  v.views, v.likes, v.comments, v.shares, v.saves, v.author_followers,
  greatest(extract(epoch from (v.last_seen_at - v.posted_at)) / 86400, 0.5) as age_days,
  (coalesce(v.likes, 0) + coalesce(v.comments, 0) + coalesce(v.shares, 0) + coalesce(v.saves, 0))::float8 / nullif(v.views, 0) as engagement_rate,
  case when v.author_followers is not null then (coalesce(v.views, 0) + 1)::float8 / (v.author_followers + 1000) end as views_per_follower
from videos v;
