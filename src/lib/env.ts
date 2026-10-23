import "server-only";

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing env var ${name} (set it in .env.local)`);
  return value;
}

export const env = {
  socialFetchKey: () => required("SOCIALFETCH_API_KEY"),
  supabaseUrl: () => required("NEXT_PUBLIC_SUPABASE_URL"),
  supabaseServiceKey: () => required("SUPABASE_SERVICE_ROLE_KEY"),
  anthropicKey: () => process.env.ANTHROPIC_API_KEY,
  geminiKey: () => process.env.GEMINI_API_KEY,
  typesafeKey: () => process.env.TYPESAFE_API_KEY,
};

export const config = {
  // Context words combined with the artist name: these surface footage
  // (performances, interviews, fan encounters) rather than random name matches.
  searchModifiers: (
    process.env.SEARCH_MODIFIERS ??
    "live,optreden,concert,show,festival,backstage,interview,podcast,meet and greet,tour"
  )
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean),
  // Max pages per query/hashtag/profile/sound during ingest (overridable per run).
  maxPages: Number(process.env.INGEST_MAX_PAGES ?? 3),
  // Routing thresholds; keep in sync with the video_status view.
  relevantAt: 0.85,
  unrelatedAt: 0.3,
  llmConcurrency: Number(process.env.LLM_CONCURRENCY ?? 8),
  // "jev" (TypeSafe, typed probabilities, cheapest) or "llm" (Claude/Gemini with structured output).
  classifier: (process.env.CLASSIFIER ?? (process.env.TYPESAFE_API_KEY ? "jev" : "llm")) as "jev" | "llm",
  anthropicModel: process.env.ANTHROPIC_MODEL ?? "claude-haiku-5-5",
  geminiModel: process.env.GEMINI_MODEL ?? "gemini-2.5-flash-lite",
  // Frames need a stronger model than text-only triage (Flash-Lite mixes up namesakes).
  geminiVisionModel: process.env.GEMINI_VISION_MODEL ?? "gemini-2.5-flash",
};
