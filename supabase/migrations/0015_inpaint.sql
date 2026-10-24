-- Per video, the best way to get clean footage: as is, cropped (bars or a caption strip at an
-- edge), painted out (small text off the face, segments[].inpaint with its text_box) or cut.
-- usable_seconds counts the fragments that need painting out too; clean_seconds doesn't.
alter table video_segments add column if not exists usable_seconds real not null default 0;
update video_segments set usable_seconds = clean_seconds where usable_seconds = 0;

create or replace view video_library with (security_invoker = true) as
select s.*, g.clean_seconds, g.segments, g.aspect, g.crop, g.is_edit, g.usable_seconds, g.crop_kind
from video_status s join video_segments g on g.video_id = s.id
where s.status = 'relevant' and g.usable_seconds > 0;
