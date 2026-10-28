# Handgelabelde testsets

Per set: de vraag, hoe de steekproef gekozen is, wanneer gelabeld, en per TikTok-video-id het label: `true` (de artiest is in beeld), `false` (niet), `null` (onzeker, telt niet mee). Labels zijn op beeld gezet (12 frames per video, contactsheets), niet op de caption.

| Set | Artiest | Ja / nee / onzeker | Waarvoor |
|---|---|---|---|
| `vision_russo_v1`, `vision_cristiand_v1` | Russo, Cristiand | 23/22/14, 9/19/13 | Artist sheet tegenover andere referenties (`scripts/eval-vision.ts`, met de frames op schijf) |
| `vision_russo_hard_v2`, `vision_cristiand_hard_v2` | Russo, Cristiand | 14/37/5, 10/39/6 | Gestratificeerd op de score van de frames-check, met nadruk op twijfelgevallen; drempels van de frames-laag. `meta` bevat de score op het moment van labelen. |
| `lookalikes_russo_v1`, `lookalikes_cristiand_v1` | Russo, Cristiand | 6/4/7, 1/3/2 | Video's die een look-alike noemen (Mart Hoogkamer, Josylvio) |

Doorrekenen tegen de huidige stand van de database:

```
NODE_OPTIONS=--conditions=react-server npx tsx --env-file=.env.local scripts/eval-labels.ts eval/vision_russo_hard_v2.json --list
```

`--footage` telt een video alleen als "ja" voorspeld als er ook bruikbare fragmenten zijn; `--list` toont de fouten.

Let op:
- De sets zijn klein (n = 10–50 per set). Behandel verschillen van één of twee video's niet als bewijs.
- De v2-sets zijn gestratificeerd, dus precision en recall daarop zijn niet hetzelfde als over alle video's. Weeg met de aantallen per stratum als je dat wilt schatten.
- Video's die niet meer in de database staan worden overgeslagen; dat meldt het script.
- Nieuwe sets: zelfde formaat, blind labelen op beeld, en `null` gebruiken als je het niet zeker weet.
