# AGENTS.md – overdracht voor AI-agents (Codex, Claude Code, …)

Lees dit vóór je iets verandert. Het beschrijft **waar we naartoe bouwen**, **in welke fase we zitten**, **hoe we werken** en **wat we al geleerd hebben**. De README beschrijft hoe de onderdelen technisch werken; dit document is het waarom en het hoe-verder.

---

## 1. De stip op de horizon

Artist Radar wordt een **content-finder en clip-library per artiest**, waarmee we in bulk unieke video's maken (fan edits, lyricvideo's, live-compilaties) voor TikTok en Instagram, zonder duplicate content.

De volledige pijplijn, in zeven stappen:

1. **Sourcing**: zoveel mogelijk video's vinden waarin de artiest te zien is, **gepost door andere accounts**. Niet het eigen account van de artiest, en niet random mensen die alleen zijn sound gebruiken.
2. **Verificatie**: per video vaststellen of de artiest echt in beeld is, op basis van de beelden zelf en niet de caption. Ook look-alikes en namesakes eruit halen.
3. **Segmenteren**: per video de bruikbare fragmenten: tijdvakken met de artiest in beeld en zonder tekst of overlays. Per fragment wordt de beste behandeling gekozen: schoon, bijsnijden, inpainten of knippen.
4. **Downloaden en opschonen**: de echte clips binnenhalen, tekst wegpoetsen (inpainting met LaMa/STTN/ProPainter, bijvoorbeeld via `YaoFANGUK/video-subtitle-remover`, op een GPU-machine) en bijsnijden.
5. **Clipbibliotheek per artiest**: een groeiende, gelabelde verzameling schone footage. Op termijn terabytes, op Cloudflare R2.
6. **Playbook**: leren wat werkt. Uitschieters (veel views ten opzichte van het aantal volgers van de uploader, of veel engagement) worden ontleed tot een blauwdruk per format.
7. **Produceren en publiceren**: in bulk unieke video's maken volgens de blauwdrukken, met een mens die tussendoor kan bijsturen. Dit gaat naar verwachting via **Runfeeds** (de eigen tool van de eigenaar, met werkruimtes, een video-wizard, review en publicatie). Artist Radar blijft dan de motor voor sourcing en verificatie, en levert clips en blauwdrukken aan. Zie §6.

### Waar we nu zijn

We zitten in **fase 1: sourcing en verificatie perfectioneren** (stap 1–3, plus de voorbereiding van stap 6). De eigenaar wil uitdrukkelijk **niet te hard van stapel lopen**: eerst moeten sourcing en verificatie aantoonbaar goed zijn, pas daarna volgen downloaden, opschonen en produceren. Begin niet op eigen houtje aan stap 4–7, en bouw geen editor.

---

## 2. Werkafspraken (belangrijk)

- **Meten vóór uitrollen.** Elke verbetering aan verificatie of segmentatie wordt getest op een steekproef die met de hand gelabeld is. Bekijk de frames zelf (contactsheets), en rapporteer precision en recall, vóór en na. Rol pas uit als het aantoonbaar beter is. Testsets bevatten bewust **moeilijke gevallen** (twijfelgevallen, look-alikes) en worden blind gelabeld.
- **Kosten bewaken.** Zeg vooraf wat iets kost, en vraag het eerst als het boven een paar tientjes aan credits uitkomt. Zie §5. Draai geen force-runs over oude video's zonder te weten hoeveel TikTok-links verlopen zijn: één keer kostte dat onverwacht 2.193 credits.
- **Eerlijk rapporteren.** Wat tegenvalt of niet gelukt is, wordt genoemd. Schattingen worden als schatting gemarkeerd.
- **Generiek blijven.** Alles moet voor elke artiest werken, niet alleen voor de twee testartiesten. Geen speciale gevallen in de code; artiestspecifieke kennis hoort in de artist card (database).
- **Geen handwerk vragen dat de tool zelf kan doen.** De eigenaar wil bijvoorbeeld uitdrukkelijk niet zelf look-alikes toevoegen; die worden automatisch gevonden, met een knop om het terug te draaien.
- **Secrets** staan alleen in `.env.local` (door git genegeerd). Nooit committen, loggen of naar een andere dienst sturen.
- **Taal:** UI-teksten, README en rapportages aan de eigenaar in het **Nederlands**; code en commentaar in het **Engels**.
- **Juridisch:** gezichtsherkenning is een bijzondere persoonsgegevens-categorie (AVG), en fan-footage heeft rechthebbenden. Vóór stap 7 (publiceren) moet uitgezocht zijn wat mag (credit, toestemming). Kaart dit aan als het relevant wordt.

---

## 3. Stand van zaken

**Testartiesten:** Russo (`@russo_nl`, NL; look-alike: Mart Hoogkamer) en Cristiand (`@cristiand_04`, BE/NL; look-alike: Josylvio). Er is bewust nog geen derde artiest toegevoegd.

### Stap 1 – Sourcing (werkt)

- **Zoekbronnen** via Social Fetch: zoeken op naam plus context ("live", "optreden", songs, collega-artiesten), hashtags, profielen van fanaccounts, en optioneel het eigen profiel en sounds (die staan standaard uit).
- **Landen per artiest** (`artists.countries`): video's van uploaders uit andere landen krijgen de status `out_of_region` en worden niet gecontroleerd. Dat scheelt veel ruis.
- **Verversen (alleen nieuw):** werkt met een datumfilter en stopt vroeg zodra een pagina vooral bekende video's bevat. Het is nog nooit echt maandelijks gedraaid; de kosten per ronde zijn geschat op 30–40 credits per artiest. **Open.**
- **Playbook-data:** aantal volgers van de uploader, saves en een momentopname van de cijfers per ingest (`video_stats`).
- **Open:** de zoekopdrachten opschonen (de opbrengst-tabel staat in het dashboard), een derde (lastige) artiest toevoegen, en de maandelijkse verversing echt draaien om de kosten te meten.

### Stap 2 – Verificatie (werkt, wordt verbeterd)

- **Frames-first met Jev (TypeSafe):** per video 12 frames, vergeleken met het **artist sheet**. Dat is een set echte foto's van de artiest uit TikTok, Instagram, Apple Music en Spotify, verdeeld over vakken: frontaal, zijkant, zonnebril, pet, podium, dagelijks.
- **Gemeten met de hand:** het sheet verbeterde F1 van 0,93 naar 0,98 (Russo) en van 0,71 naar 1,00 (Cristiand). Op een grotere steekproef met moeilijke gevallen was "bruikbaar" 100% (Russo) en 83% (Cristiand) correct.
- **Drempels voor de frames-laag:** ≥0,7 is relevant, ≤0,5 is unrelated, daartussen review. Tussen 0,3 en 0,5 zat geen enkele echte video.
- **Look-alikes (automatisch):** zie de README. Op een testset zakte "onterecht bruikbaar" van 7/7 naar 2/7. **Open:** een strengere regel staat in de code, maar is nog niet gedraaid, omdat het Jev-tegoed op was. Eerst de oude rijen weghalen (`delete from classifications where model like 'jev-lookalike:%'`), dan `scripts/lookalikes.ts` opnieuw draaien en meten met de testset.
- **Open:** het sheet van Russo bevat een foute foto ("pet/capuchon", geen gezicht). Verder komen ±26 Russo-video's niet door de frames-check (rare formaten), en worden duimpjes van de gebruiker nog niet gebruikt om de beeldcheck te verbeteren.

### Stap 3 – Segmenteren (werkt)

- **Fragmenten per bruikbare video** in `video_segments`, met per fragment de beste behandeling:
  - **schoon** (geen tekst; een klein watermerk mag);
  - **bijsnijden**: vaste zwarte balken, of een tekststrook boven of onder (12/18/25% van de hoogte, daarna opnieuw gecontroleerd op tekst, artiest en een afgesneden gezicht);
  - **inpainten**: tekst ≤10% van het beeld (≤5% bij een drukke achtergrond) en niet over het gezicht; het tekstvak wordt opgeslagen;
  - **knippen**: grote tekst of tekst over het gezicht; alleen de schone stukken tellen.
- **Resultaat:** Russo ±327 min bruikbare footage (176 direct schoon, 69 na bijsnijden, 82 na inpainten), Cristiand ±49 min.
- **Verfijnen bij gebruik** (`refine.ts`): de echte mp4 op 2 frames per seconde, met knippunten op halve seconden en een kwaliteitslabel. Draait per video, niet in bulk.
- **Open:** het echte inpainten (stap 4), en verfijnen in bulk zodra er gedownload wordt.

### Stap 6 – Playbook (eerste versie werkt)

Uitschieters worden door Gemini (video plus audio) ontleed tot blauwdrukken per format, in het Engels: die zijn bedoeld als input voor de latere auto-edit. Zodra de volgersdata gevuld is, moet de playbook opnieuw gebouwd worden ("Bijwerken").

---

## 4. Architectuur in het kort

- **Stack:** Next.js (App Router, TypeScript) en Tailwind; Supabase (Postgres en Storage, service-role, RLS aan zonder policies); Social Fetch voor TikTok/Instagram-data; TypeSafe **Jev** voor beeld en tekst (goedkoop, gekalibreerde kansen); Gemini of Claude voor gestructureerde LLM-taken (`llm-client.ts`, met automatische fallback naar Gemini); ffmpeg-static voor frames en pixelchecks.
- **Media** loopt via `src/lib/media.ts` (`MediaStore`). Nu is dat Supabase Storage; Cloudflare R2 wordt later één extra klasse. Gebruik altijd `media()` en nooit direct `storage.from()`.
- **Database:** tabellen `artists`, `videos`, `classifications` (append-only, één rij per laag per run; de laatste rij per laag telt), `video_segments`, `video_stats`, `video_breakdowns`, `playbooks`, `lookalikes`. Views: `video_status` (het effectieve oordeel: human > rules > vision > llm, plus `own` en `out_of_region`), `video_performance`, `video_library`.
- **Verwerkingsvolgorde na een ingest:** regels → tekstlaag → frames-check → frames opruimen → look-alikes → fragmenten (`classifyArtist` in `src/lib/classify/index.ts`). Draai de frames-check **direct na de ingest**, want TikTok-videolinks verlopen binnen uren tot dagen.
- **Scripts** in `scripts/`, voor lange runs zonder HTTP-timeouts. Bijvoorbeeld:
  ```
  NODE_OPTIONS=--conditions=react-server npx tsx --env-file=.env.local scripts/<script>.ts <artistId> [flags]
  ```
  Beschikbaar: `ingest`, `classify` (`--vision`, `--force-vision`), `segments`, `refine`, `lookalikes`, `playbook`, `store-frames`, `prune-frames`, plus de meetscripts `eval-vision`, `compare-*`.
- **Migraties** in `supabase/migrations/` worden **niet automatisch** toegepast. Pas ze handmatig toe op het Supabase-project. Let op: een view met `v.*` kun je niet `create or replace`-en als er kolommen bij komen, en het weggooien en opnieuw maken van `video_status` liep vast. Maak daarom liever een nieuwe view.
- **Controle vóór commit:** `npx tsc --noEmit -p .` en `npx eslint src scripts`.

---

## 5. Kosten (vuistregels)

| Wat | Kosten |
|---|---|
| Volledige ingest per artiest | ±75–100 Social Fetch-credits (1 credit per pagina) |
| Verversen | geschat ±30–40 credits per artiest (nog niet gemeten) |
| Verlopen TikTok-link verversen | 1 credit per video |
| Artist sheet of look-alike-sheet | ±4–9 credits per persoon |
| Betaalde download (`/videos/download`) | 11 credits. **Niet gebruiken voor kwaliteit:** levert dezelfde 576×1024 als de gratis CDN-link. |
| Jev | ±$0,0005 per video (12 frames); een extra check per frame is een fractie daarvan |
| Gemini-ontleding (playbook) | ±$0,003 per video van 30 s |

TypeSafe (Jev) heeft een tegoed dat op kan raken. Bij een `402 billing_error` stopt de verificatie: meld dat aan de eigenaar.

---

## 6. Koppeling met Runfeeds (later, stap 7)

Het advies is **koppelen, niet samenvoegen**. Artist Radar blijft een aparte motor: zwaar achtergrondwerk en veel opslag. Runfeeds is de plek om te maken, te reviewen en te publiceren. De koppeling:

1. **Clips naar Runfeeds:** per artiest een werkruimte; schone clips met tijdstempels en uitsnede als bronmateriaal, bijvoorbeeld als "Artiest-radar" in de Inbox.
2. **Blauwdrukken naar de bibliotheek:** de playbook per format wordt een edit/video-stijl in Runfeeds.
3. **Resultaten terug:** prestaties van gepubliceerde video's gaan terug naar de playbook. Dat is de enige echte bron van "wat werkt".

In Runfeeds moet dan nog een format komen voor een montage van echte footage (op de beat, zonder voice-over). Bouw hier niets aan zonder opdracht.

---

## 7. Geleerde lessen en valkuilen

- **Jev:**
  - Kansen zijn gekalibreerd; 0,7 is de "ja"-drempel.
  - Beelden moeten minstens 280 px per zijde zijn; schaal op de kortste zijde (zie `toJevImage`).
  - Header `TypeSafe-Danger-Zone-Images: true` is verplicht.
  - Box-vragen werken alleen met `jev-preview` en **één beeld per request**; bij meerdere beelden landen de vakken op het verkeerde beeld.
  - Jev is zwak in absolute gezichtsvergelijking, maar goed in **kiezen tussen opties**. Daarom gebruiken de look-alikes een contrastvraag.
  - Bij meerdere tekstblokken trekt Box één groot vak om alles heen. Dat is de veilige kant: liever knippen dan een slechte inpaint.
- **Tekstniveau** is een verwachte waarde van 0 tot 3: <1,25 is schoon of watermerk, <0,75 is echt leeg na bijsnijden.
- **Balkendetectie:** ffmpeg `cropdetect` ziet donkere podia en gekleurde captions op de balk als beeld. Echte balken staan in elk frame op dezelfde plek, en het videovlak is wat beweegt tussen frames.
- **TikTok-resolutie** is meestal 576×1024. Bijsnijden en inzoomen tot 9:16 wordt beoordeeld ten opzichte van die bron.
- **Supabase** geeft maximaal 1000 rijen per query: altijd pagineren met een stabiele `order` (zie `selectAll`).
- **Look-alikes zijn vaak collega-artiesten** (Mart Hoogkamer is een collega van Russo). Voor de detectie telt alleen de eigen naam, aliassen, handles en hashtags van de artiest als signaal dat de post over de artiest gaat, niet de collega's.
- **Afgewezen ideeën:**
  - gegenereerde referentiebeelden (Higgsfield-stijl): echte foto's werken beter;
  - zelf look-alikes laten toevoegen door de gebruiker;
  - de betaalde download voor kwaliteit;
  - bulk-verfijnen van alle video's: te duur aan verlopen links.

---

## 8. Eerstvolgende stappen (volgorde van de eigenaar)

1. Jev-tegoed bijladen. Daarna de strengere look-alike-regel draaien en opnieuw meten (§3, stap 2).
2. De foute foto uit Russo's sheet halen (de eigenaar kan dat in de UI).
3. De zoekopdrachten opschonen en de maandelijkse verversing één keer echt draaien om de kosten te meten.
4. Pas als de eigenaar het zegt: een derde (lastige) artiest, en daarna stap 4 (downloaden en inpainten).
