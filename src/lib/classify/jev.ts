import "server-only";
import { choice, image, noul, score, TypeSafeClient } from "@typesafe-ai/sdk";
import type { Artist, ContentType, Verdict } from "../types";
import { truncate } from "../util";
import type { FewShot, LlmInput } from "./llm";

// Layer 1/2 on TypeSafe's Jev (https://docs.typesafe.ai): a System One model that answers
// typed questions with calibrated probabilities instead of generating text. One request per
// video asks three questions in parallel: is the artist on screen (Noul), what kind of
// content (Choice) and how usable (Score). Frames are sent as images (experimental API).

export const JEV_MODEL = process.env.TYPESAFE_MODEL ?? "jev-latest";

let client: TypeSafeClient | null = null;

const CONTENT_CRITERIA = {
  live_concert: "The artist performing (concert, festival, club show), filmed by anyone",
  fan_edit: "An edit or compilation made from footage of the artist",
  interview: "Interview, podcast, TV/radio, backstage or meet & greet with the artist",
  meme: "A meme or trend video in which the artist appears",
  sound_only: "Uses the artist's song or sound, but the artist is not on screen",
  unrelated: "Not about this artist (a namesake, another artist, or unrelated content)",
} satisfies Partial<Record<ContentType, string>>;

const USABILITY_LEVELS = [
  "The artist is not on screen",
  "Artist barely visible: far away, dark, very shaky or mostly blocked",
  "Artist visible but low quality: distant or shaky",
  "Clear footage of the artist, decent quality",
  "Close, sharp, well-lit footage where the artist is prominent",
] as const;

export async function classifyWithJev(
  artist: Artist,
  video: LlmInput,
  examples: FewShot[],
  frames: Buffer[] = [],
): Promise<Verdict & { model: string }> {
  client ??= new TypeSafeClient({ defaultModel: JEV_MODEL });

  const describe = (v: LlmInput) => ({
    author: `@${v.author_handle ?? "?"}`,
    caption: v.caption ? truncate(v.caption, 600) : "",
    hashtags: v.hashtags.map((h) => `#${h}`).join(" "),
    sound: `${v.sound_title ?? "?"} — ${v.sound_author ?? "?"}`,
  });

  const state = {
    artist: {
      name: artist.name,
      aliases: artist.aliases,
      country: artist.region,
      about: artist.notes,
      own_accounts: artist.handles.map((h) => `@${h}`),
      known_fan_accounts: artist.fan_accounts.map((h) => `@${h}`),
      songs: artist.song_titles,
      collaborators: artist.collaborators,
      not_to_confuse_with: artist.negative_terms,
    },
    tiktok_video: {
      ...describe(video),
      ...(video.transcript ? { transcript: truncate(video.transcript, 1500) } : {}),
      ...(video.hints?.length ? { signals: video.hints } : {}),
      ...(frames.length ? { frames_in_order: frames.map((f) => image(f)) } : {}),
    },
    ...(examples.length
      ? {
          videos_judged_by_the_team: examples.map((ex) => ({
            ...describe(ex),
            artist_on_screen: ex.is_about_artist,
          })),
        }
      : {}),
  };

  const response = await client.systemOne(
    {
      state,
      questions: {
        on_screen: noul(
          "Does `tiktok_video` show footage of the artist described in `artist` (performing, interviewed, meeting fans, backstage, or an edit made from footage of them)?",
          {
            true: "The artist themself appears in the video",
            false:
              "Only their song or sound is used, they are only mentioned or tagged, or the video is about someone else with a similar name",
          },
        ),
        content_type: choice("What kind of content is `tiktok_video`, with respect to the artist in `artist`?", CONTENT_CRITERIA),
        usability: score(
          "How usable is `tiktok_video` as footage of the artist in `artist` for the artist's own channels?",
          USABILITY_LEVELS,
        ),
      },
    },
    frames.length ? { headers: { "TypeSafe-Danger-Zone-Images": "true" } } : undefined,
  );

  const { on_screen, content_type, usability } = response.answers;
  let p = on_screen.noul;
  // Contradictory answer (likely on screen but "unrelated"/"sound_only"): send it to review.
  if (content_type.choice === "unrelated" || content_type.choice === "sound_only") p = Math.min(p, 0.6);

  return {
    is_about_artist: p >= 0.5,
    confidence: p >= 0.5 ? p : 1 - p,
    content_type: content_type.choice,
    usability: Math.min(5, Math.max(1, Math.round(usability.score) + 1)),
    reason: `Jev: on screen ${on_screen.noul.toFixed(2)} · ${content_type.choice} ${content_type.confidence.toFixed(2)} · usability ${usability.score.toFixed(1)}/4${frames.length ? ` · ${frames.length} frames` : ""}`,
    model: response.model ?? JEV_MODEL,
  };
}

const VISUAL_CONTENT = {
  live_concert: "The person from `reference_photos` performing on a stage (concert, festival, club show)",
  interview: "The person from `reference_photos` talking: interview, podcast, TV/radio, backstage or meeting fans",
  fan_edit: "An edited compilation or montage that includes footage of the person from `reference_photos`",
  meme: "A meme, trend or skit in which the person from `reference_photos` appears",
  sound_only: "Other people dancing, lip-syncing or filming themselves; the person from `reference_photos` is not shown",
  merch_or_screen: "The person from `reference_photos` only appears as a printed photo, poster, merch, album cover or on a phone/TV screen being shown",
  unrelated: "Anything else without the person from `reference_photos` (text screens, other people, objects, places)",
};

// Overlaid text per frame (not text that is part of the scene, like a stage logo).
const TEXT_LEVELS = [
  "No overlaid text, stickers or emojis",
  "Only a small watermark, username or logo in a corner",
  "A caption or text block, stickers or emojis on part of the image",
  "Text or graphics covering a large part of the image",
] as const;

export type VisualVerdict = Verdict & {
  model: string;
  // Per frame: is the artist visible (p) and how much overlaid text/stickers (text: 0-3, see TEXT_LEVELS).
  frames: { atSeconds: number | null; p: number; text: number }[];
};

// Frames-first: the frames and reference photos are the evidence. Per frame: is the person in
// the reference photos visible (purely visual, gives timestamps)? For the whole video, one
// combined judgment that may also use the post text as secondary context: faces fail on
// sunglasses, distant stages and look-alikes, captions fail on namesakes and song-only use.
export async function classifyFramesWithJev(
  references: { label: string; image: Buffer }[],
  frames: { image: Buffer; atSeconds: number | null }[],
  context?: { artist: Artist; post: LlmInput },
): Promise<VisualVerdict> {
  client ??= new TypeSafeClient({ defaultModel: JEV_MODEL });
  const response = await client.systemOne(
    {
      state: {
        // Labelled photos of the artist (close-up, side, sunglasses, stage, …) and visual traits.
        reference_photos: Object.fromEntries(references.map((r, i) => [`${r.label}_${i + 1}`, image(r.image)])),
        ...(context?.artist.traits ? { artist_traits: context.artist.traits } : {}),
        frames: frames.map((f) => ({ at_seconds: f.atSeconds, image: image(f.image) })),
        ...(context
          ? {
              artist: { name: context.artist.name, aliases: context.artist.aliases, about: context.artist.notes },
              post_text_secondary: {
                author: `@${context.post.author_handle ?? "?"}`,
                caption: context.post.caption ? truncate(context.post.caption, 400) : "",
                hashtags: context.post.hashtags.map((h) => `#${h}`).join(" "),
              },
            }
          : {}),
      },
      questions: {
        ...Object.fromEntries(
          frames.map((_, i) => [
            `in_frame_${i}`,
            noul(`Is the person shown in \`reference_photos\` visible in \`frames[${i}].image\`?`),
          ]),
        ),
        ...Object.fromEntries(
          frames.map((_, i) => [
            `text_${i}`,
            score(`How much text, captions, stickers or emojis are overlaid on top of \`frames[${i}].image\`?`, TEXT_LEVELS),
          ]),
        ),
        on_screen: noul(
          "Do `frames` show the person from `reference_photos` themself, in real footage (not a photo, print or screen of them)? Base this on the frames; use `post_text_secondary`, if present, only to resolve doubt, e.g. a face hidden by sunglasses or a far-away stage.",
        ),
        content_type: choice("Taken together, what do `frames` show?", VISUAL_CONTENT),
        usability: score("How usable is this video as footage of the person in `reference_photos`?", USABILITY_LEVELS),
      },
    },
    { headers: { "TypeSafe-Danger-Zone-Images": "true" } },
  );

  const answers = response.answers as Record<string, { noul?: number; choice?: string; confidence?: number; score?: number }>;
  const perFrame = frames.map((f, i) => ({
    atSeconds: f.atSeconds,
    p: answers[`in_frame_${i}`].noul ?? 0,
    text: answers[`text_${i}`]?.score ?? 0,
  }));
  // Clean = the artist is visible and at most a small watermark is on top.
  const clean = perFrame.filter((f) => f.p >= 0.7 && f.text < 1.5).length;
  const best = perFrame.reduce((a, b) => (b.p > a.p ? b : a));
  const seen = perFrame.filter((f) => f.p >= 0.7).length;
  const choiceLabel = answers.content_type.choice as keyof typeof VISUAL_CONTENT;
  const contentType: ContentType = choiceLabel === "merch_or_screen" ? "unrelated" : choiceLabel;
  const usability = answers.usability.score ?? 0;
  let p = answers.on_screen.noul ?? best.p;
  // A printed photo/merch/screen of the artist is not footage.
  if (choiceLabel === "merch_or_screen") p = Math.min(p, 0.3);

  return {
    is_about_artist: p >= 0.5,
    confidence: p >= 0.5 ? p : 1 - p,
    content_type: contentType,
    usability: Math.min(5, Math.max(1, Math.round(usability) + 1)),
    reason: `Jev frames: ${p.toFixed(2)} · gezicht in ${seen}/${frames.length} frames, ${clean} zonder tekst (beste ${best.p.toFixed(2)}${best.atSeconds != null ? ` op ${best.atSeconds}s` : ""}) · ${choiceLabel} ${(answers.content_type.confidence ?? 0).toFixed(2)}`,
    model: response.model ?? JEV_MODEL,
    frames: perFrame,
  };
}
