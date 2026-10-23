-- Reference photos of the artist (picked from covers of their own posts), used by the
-- vision layer to check whether this person is on screen.
alter table artists add column reference_images text[] not null default '{}';
insert into storage.buckets (id, name, public) values ('references', 'references', false)
  on conflict (id) do nothing;
