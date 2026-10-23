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

**Doel:** zoveel mogelijk **footage waarin de artiest zelf te zien is**, gepost door **andere accounts**: fans die een show filmen, venues, festivals, media, interviews en fanedits. Posts van de artiest zelf (status `own`) en video's die alleen zijn nummer gebruiken vallen erbuiten.

**Ingest** (`src/lib/ingest.ts`, knop "Ingest + classificeer"), search-first:
1. `/v1/tiktok/search` met de `region` van de artist card (bv. `NL`) op:
   - naam en aliassen;
   - naam + contextwoorden (`SEARCH_MODIFIERS`: live, optreden, concert, show, festival, backstage, interview, podcast, meet and greet, tour);
   - naam + songtitel en naam + collaborator;
   - de extra zoekopdrachten van de card;
   - de naam gesorteerd op nieuwste uploads.
2. `/v1/tiktok/search/hashtags` per hashtag (leeg = afgeleid van naam/aliassen)
3. `/v1/tiktok/profiles/{handle}/videos` voor **fanaccounts**: accounts die structureel footage posten. Het dashboard stelt ze voor op basis van eerdere resultaten.
4. Optioneel (standaard uit): het eigen profiel en `/v1/tiktok/music/{clipId}/videos` voor zijn sounds. Sound-video's zijn in de praktijk vooral mensen die op het nummer dansen.

Elke query pagineert tot max N pagina's (`INGEST_MAX_PAGES`, of per run in de UI). Daarna wordt er ontdubbeld op video-id, worden de bronnen gemerged en de thumbnails direct naar Storage gecachet (HEIC wordt naar JPEG omgezet). Credits en statistieken worden per run gelogd in `ingest_runs`.

**Classificatie** (`src/lib/classify/`) is een trechter. Elke laag schrijft rijen naar `classifications`; de view `video_status` kiest het effectieve oordeel (human > rules > llm) en geeft posts van de eigen accounts status `own`:
- **Laag 0 – regels:** geblokkeerd account of negatieve term → unrelated. Al het andere (tags, songtitels, collaborators, eigen sound, bekend fanaccount) gaat als hint naar de LLM.
- **Laag 1 – LLM:** caption, hashtags, auteur en sound gaan via een Zod-schema met structured output naar Claude Haiku (`ANTHROPIC_API_KEY`) of Gemini (`GEMINI_API_KEY`). Het model schat **de kans dat de artiest in beeld is** en geeft daarnaast `content_type`, `usability` en `reason` terug. De duimpjes uit de UI dienen als few-shot voorbeelden.
- **Routing:** kans ≥ 0.85 → relevant (footage), ≤ 0.3 → unrelated, daartussen → review.
- **Een laag toevoegen:** voeg een stap toe in `classifyArtist`, plus de waarde in de check-constraint `layer` en in de prioriteit van de view.

**Dashboard:** tabs relevant/review/unrelated/own, met filters op content_type en periode en sortering. Verder:
- suggesties voor fanaccounts (één klik om toe te voegen);
- een tabel met de opbrengst per zoekopdracht, om zwakke zoektermen te schrappen;
- afspelen via de TikTok-embed, duim omhoog/omlaag als human-classificatie;
- "Download": roept `/v1/tiktok/videos/download` aan (11 credits), zet de mp4 in Storage en geeft een signed link terug. Een tweede klik gebruikt het opgeslagen bestand en kost geen credits.

## Verversen en opslag

- **Verversen (alleen nieuw):** voor de maandelijkse ronde. De zoekopdrachten krijgen een datumfilter vanaf de vorige ingest (`artists.last_ingest_at`: deze week / maand / 3 / 6 maanden). Elke query stopt met pagineren zodra minder dan 20% van een pagina nieuw is. Video's die al beoordeeld zijn worden niet opnieuw gecheckt.
- **Frames:** de frames-check bewaart frames in de privé-bucket `frames` (`{artist}/{video}/…`), zodat herclassificeren geen verlopen TikTok-links meer nodig heeft. Na de beoordeling worden frames van unrelated video's opgeruimd; alleen relevant en review blijven staan. Voor oudere runs: `scripts/prune-frames.ts <artistId>`.
- **Opslag-interface:** alle media (thumbnails, frames, sheet-foto's, downloads) loopt via `src/lib/media.ts` (`media().put/get/list/remove/signedUrl`). Nu is dat Supabase Storage. Een S3-compatibele store zoals Cloudflare R2 (geen egress-kosten) is één extra klasse, gekozen met `MEDIA_STORE`.

## Nieuwe artiest

Plak een TikTok-link bij "Nieuwe artiest" → "Card voorstellen" (`src/lib/bootstrap.ts`, ±5 credits). De tool haalt profiel, eigen posts en één zoekpagina op, en de AI vult naam, aliassen, regio, notitie, songs, collaborators, hashtags, negatieve termen en geblokkeerde accounts in. Controleer de card vóór het opslaan.

## Classifiers

- **Jev (TypeSafe, aanbevolen):** zet `TYPESAFE_API_KEY`. Jev geeft getypeerde, gekalibreerde kansen (Noul/Choice/Score) voor $0,042 per miljoen input-tokens, in ±0,1–0,4 seconde.
  - **Frames-first (laag `vision`):** per video 12 frames (`FRAME_COUNT`) uit de mp4 van TikTok's CDN, vergeleken met **referentiefoto's** van de artiest. Per frame volgt "staat deze persoon erin?" (met tijdstip), plus een eindoordeel waarbij de caption alleen als tweede bewijs telt. Merch, foto's of schermen van de artiest tellen niet. Drempel voor relevant: 0,7.
  - **Artist sheet** (`src/lib/sheet.ts`, ±6–8 credits per artiest): foto's uit TikTok (profielfoto, covers), Instagram (profielfoto, eigen posts, getagde posts), Apple Music en Spotify.
    - Jev labelt elke foto: gezicht (Box), zichtbaarheid, zonnebril, pet of capuchon, hoek en situatie.
    - Eigen Instagram-foto's met één persoon zijn het anker voor wie de artiest is.
    - Vakken: close-up frontaal, schuin/profiel, zonnebril, pet/capuchon, podium, dagelijks. Plus een korte tekst met kenmerken.
    - Je beheert het sheet op de artiestpagina en kunt foute foto's verwijderen.
  - **Meting** (`scripts/eval-vision.ts`, ground truth met de hand gelabeld):

    | Artiest | n | A: caption + 4 frames | B: oude referenties | **C: artist sheet** | V: sheet zonder caption |
    |---|---|---|---|---|---|
    | Russo | 45 | F1 0,93 | F1 0,95 | **F1 0,98** | F1 0,98 |
    | Cristiand | 28 | F1 0,71 (recall 0,56) | F1 0,62 (recall 0,44) | **F1 1,00** | F1 0,90 (2 namesakes) |
- **LLM:** Claude Haiku of Gemini met een Zod-schema (`CLASSIFIER=llm`). Valt automatisch terug op Gemini als Anthropic geen tegoed heeft.
- **Evaluatie:** `scripts/compare-classifiers.ts` en `scripts/compare-frames.ts` vergelijken varianten op een steekproef en bewaren frames voor handmatige controle.

## Onderhoud

TikTok levert veel covers als HEIC aan, en die tonen browsers niet. Bij het cachen worden ze naar JPEG omgezet. Om oude thumbnails om te zetten of opnieuw op te halen:

```bash
NODE_OPTIONS=--conditions=react-server npx tsx --env-file=.env.local scripts/backfill-thumbnails.ts
```

## Niet in v1
Gezichtsherkenning, videoanalyse met Gemini, scheduling en transcripts (het veld bestaat al in de LLM-input).
