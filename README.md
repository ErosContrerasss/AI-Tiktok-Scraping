# Artist Radar

Interne testtool: per artiest zoveel mogelijk TikTok-content vinden, ruis eruit filteren en bruikbare video's on demand downloaden.

**Stack:** Next.js (App Router, TS) + Tailwind · Supabase (Postgres + Storage) · [Social Fetch](https://www.socialfetch.dev) voor TikTok-data · Claude Haiku of Gemini Flash-Lite voor classificatie. Alle API-calls gebeuren server-side; keys staan alleen in `.env.local`.

## Setup

```bash
npm install
cp .env.example .env.local   # vul de keys in
npm run dev                  # http://localhost:3000
```

Het schema staat in `supabase/migrations/0001_init.sql` (tabellen, de view `video_status` en de storage-buckets `thumbnails` (publiek) en `videos` (privé, signed URLs)).

## Hoe het werkt

De focus ligt op content van **andere accounts** over de artiest. Eigen posts worden wel opgehaald (voor sound-discovery), maar staan standaard verborgen in het dashboard.

**Ingest** (`src/lib/ingest.ts`, knop "Ingest + classificeer"):
1. `/v1/tiktok/search` voor naam + aliassen en "songtitel + naam" (met `region` van de artist card, bv. `NL`)
2. `/v1/tiktok/search/hashtags` per hashtag (leeg = afgeleid van naam/aliassen)
3. `/v1/tiktok/profiles/{handle}/videos` voor de eigen accounts
4. **Sound-discovery:** de sounds van de artiest zelf (releases waarvan de artiest als auteur staat, en zijn eigen "original sound"s) worden uit de eigen posts gehaald en aan `sound_ids` toegevoegd
5. `/v1/tiktok/music/{clipId}/videos` per sound id: alle andere accounts die zijn nummers gebruiken

Elke query pagineert tot max N pagina's (`INGEST_MAX_PAGES`, of per run in de UI). Daarna wordt er ontdubbeld op video-id, worden de bronnen gemerged en de thumbnails direct naar Storage gecachet. Credits en statistieken worden per run gelogd in `ingest_runs`.

**Classificatie** (`src/lib/classify/`) is een trechter. Elke laag schrijft rijen naar `classifications`; de view `video_status` kiest het effectieve oordeel (human > rules > llm):
- **Laag 0 – regels:** geblokkeerd account of negatieve term → unrelated. Eigen account of eigen sound → relevant (confidence 1). Een getagde handle, songtitel of collaborator in de caption geeft een hint aan de LLM.
- **Laag 1 – LLM:** caption, hashtags, auteur en sound gaan via een Zod-schema met structured output naar Claude Haiku (`ANTHROPIC_API_KEY`) of Gemini (`GEMINI_API_KEY`). Het model geeft `is_about_artist`, `confidence`, `content_type`, `usability` en `reason` terug. De duimpjes uit de UI dienen als few-shot voorbeelden.
- **Routing:** relevance ≥ 0.85 → relevant, ≤ 0.3 → unrelated, daartussen → review.
- **Een laag toevoegen:** voeg een stap toe in `classifyArtist`, plus de waarde in de check-constraint `layer` en in de prioriteit van de view.

**Dashboard:** grid met filters op status, content_type, periode en sortering. De standaardweergave is "alles over de artiest": geen eigen posts en geen `sound_only` (video's waarin zijn nummer alleen als achtergrond dient). Beide kun je aanzetten. Klikken speelt de video af via de TikTok-embed; duim omhoog/omlaag slaat een human-classificatie op. "Download" roept `/v1/tiktok/videos/download` aan (11 credits), zet de mp4 in Storage en geeft een signed link terug. Een tweede klik gebruikt het opgeslagen bestand en kost geen credits.

## Onderhoud

TikTok levert veel covers als HEIC aan, en die tonen browsers niet. Bij het cachen worden ze naar JPEG omgezet. Om oude thumbnails om te zetten of opnieuw op te halen:

```bash
NODE_OPTIONS=--conditions=react-server npx tsx --env-file=.env.local scripts/backfill-thumbnails.ts
```

## Niet in v1
Gezichtsherkenning, videoanalyse met Gemini, scheduling en transcripts (het veld bestaat al in de LLM-input).
