-- Frames extracted for the vision layer are kept (private), so re-classifying later doesn't
-- need TikTok's expiring video links again. Path: {artist_id}/{video_id}/{nn}_{seconds}.jpg
insert into storage.buckets (id, name, public) values ('frames', 'frames', false)
  on conflict (id) do nothing;
