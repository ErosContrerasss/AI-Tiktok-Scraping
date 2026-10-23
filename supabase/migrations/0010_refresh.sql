-- Targeted refresh: remember when an artist was last ingested, so a refresh only asks
-- TikTok search for videos posted since then.
alter table artists add column last_ingest_at timestamptz;
update artists a set last_ingest_at = (select max(finished_at) from ingest_runs r where r.artist_id = a.id);
