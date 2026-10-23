-- Extra context on the artist card:
-- notes  : free text for the LLM (who the artist is, genre, city, what is NOT them)
-- region : ISO country code sent to Social Fetch search for localized results
alter table artists add column notes text not null default '';
alter table artists add column region text;
