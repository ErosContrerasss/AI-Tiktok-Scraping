-- Playbook: outliers (videos that do much better than their uploader's audience or with
-- unusually high engagement) get a structured breakdown of how they're built; the
-- breakdowns per output format are summarised into a blueprint the production step can
-- follow later.
create table video_breakdowns (
  video_id text primary key references videos(id) on delete cascade,
  artist_id uuid not null references artists(id) on delete cascade,
  format text not null,
  outlier_reason text,
  breakdown jsonb not null,
  model text,
  created_at timestamptz not null default now()
);
create index video_breakdowns_artist_idx on video_breakdowns(artist_id, format);
alter table video_breakdowns enable row level security;

create table playbooks (
  id bigint generated always as identity primary key,
  artist_id uuid not null references artists(id) on delete cascade,
  format text not null,
  blueprint jsonb not null,
  video_ids text[] not null default '{}',
  model text,
  created_at timestamptz not null default now()
);
create index playbooks_artist_idx on playbooks(artist_id, format, created_at desc);
alter table playbooks enable row level security;
