-- Layer 2 "vision": the same question as the LLM layer, judged with frames sampled
-- from the video. Priority: human > rules > vision > llm.
alter table classifications drop constraint classifications_layer_check;
alter table classifications add constraint classifications_layer_check
  check (layer in ('rules', 'llm', 'vision', 'human'));

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
join artists a on a.id = v.artist_id
left join ranked r on r.video_id = v.id and r.rn = 1
left join lateral (
  select c.content_type, c.usability from classifications c
  where c.video_id = v.id and c.layer in ('vision', 'llm')
  order by case c.layer when 'vision' then 0 else 1 end, c.created_at desc limit 1
) l on true;
