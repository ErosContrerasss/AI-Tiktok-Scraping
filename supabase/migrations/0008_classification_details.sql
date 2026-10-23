-- Per-frame results of the vision layer: [{at_seconds, artist_p, text_level 0-3}], so later steps
-- (picking clean segments) don't need to re-run classification.
alter table classifications add column details jsonb;
