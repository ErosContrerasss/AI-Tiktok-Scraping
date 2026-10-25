-- Look-alikes, found automatically: people mentioned in videos that the frames check took for
-- the artist, without anything else pointing to the artist. Each gets a small photo sheet; the
-- artist's usable videos are then checked again with both sheets side by side ("artist, the
-- look-alike, both, or someone else?"). status 'rejected' = the team said it isn't one, which
-- undoes its checks and blocks.
create table lookalikes (
  id bigint generated always as identity primary key,
  artist_id uuid not null references artists(id) on delete cascade,
  name text not null,
  tiktok_handle text,
  sheet jsonb not null default '[]',
  traits text not null default '',
  evidence jsonb not null default '{}',   -- tokens, counts, why
  blocked_accounts text[] not null default '{}', -- accounts this look-alike added to the artist's block list
  stats jsonb not null default '{}',      -- checked, rejected, frames removed
  status text not null default 'active' check (status in ('active', 'rejected')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (artist_id, name)
);
alter table lookalikes enable row level security;
