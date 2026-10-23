-- Artist sheet: labelled reference photos (close-up, side, sunglasses, headwear, stage,
-- everyday) collected from TikTok, Instagram, Apple Music and Spotify, plus a short
-- description of visual traits. reference_images (single anchor + covers) stays for now,
-- so both approaches can be compared on the same test set.
alter table artists add column instagram_handle text;
alter table artists add column spotify_url text;
alter table artists add column artist_sheet jsonb not null default '[]';
alter table artists add column traits text not null default '';
