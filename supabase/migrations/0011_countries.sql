-- Countries of the artist's audience (uploader country, e.g. {NL,BE}). Videos posted from
-- other countries get status 'out_of_region' and skip the paid checks; empty = all countries.
-- A human vote or a "relevant" vision verdict always wins. Videos without a region count as
-- in-region.
--
-- Also: the vision layer routes to unrelated at <= 0.5 (was 0.3). Measured on 111
-- hand-labelled videos: 0 of 22 between 0.3 and 0.5 showed the artist.
alter table artists add column countries text[] not null default '{}';

create or replace view video_status with (security_invoker = true) as
with ranked as (
  select c.*,
    row_number() over (
      partition by c.video_id
      order by case c.layer when 'human' then 0 when 'rules' then 1 when 'vision' then 2 else 3 end, c.created_at desc
    ) as rn
  from classifications c
)
select
  v.*,
  r.layer,
  r.is_about_artist,
  r.confidence,
  coalesce(r.content_type, l.content_type) as content_type,
  coalesce(r.usability, l.usability) as usability,
  r.reason,
  case when r.is_about_artist then r.confidence else 1 - r.confidence end as relevance,
  case
    when v.author_handle = any(a.handles) then 'own'
    when cardinality(a.countries) > 0
      and coalesce(v.raw->>'region', '') <> ''
      and not (upper(v.raw->>'region') = any(a.countries))
      and r.layer is distinct from 'human'
      and not (r.layer = 'vision' and (case when r.is_about_artist then r.confidence else 1 - r.confidence end) >= 0.7)
      then 'out_of_region'
    when r.id is null then 'unclassified'
    when (case when r.is_about_artist then r.confidence else 1 - r.confidence end) >= (case when r.layer = 'vision' then 0.7 else 0.85 end) then 'relevant'
    when (case when r.is_about_artist then r.confidence else 1 - r.confidence end) <= (case when r.layer = 'vision' then 0.5 else 0.3 end) then 'unrelated'
    else 'review'
  end as status,
  (select h.is_about_artist from classifications h
    where h.video_id = v.id and h.layer = 'human'
    order by h.created_at desc limit 1) as human_vote,
  (select d.storage_path from downloads d
    where d.video_id = v.id order by d.downloaded_at desc limit 1) as download_path,
  v.raw->>'region' as uploader_region
from videos v
join artists a on a.id = v.artist_id
left join ranked r on r.video_id = v.id and r.rn = 1
left join lateral (
  select c.content_type, c.usability from classifications c
  where c.video_id = v.id and c.layer in ('vision', 'llm')
  order by case c.layer when 'vision' then 0 else 1 end, c.created_at desc limit 1
) l on true;
