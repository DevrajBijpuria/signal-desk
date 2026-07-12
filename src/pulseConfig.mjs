// Public Pulse tuning — kept as data, separate from the logic in pulse.mjs,
// same spirit as the scoring tier map. Applies to the World (geopolitics) and
// India desks ONLY; Tech & AI and Esports are out of scope by design.
export const PULSE_CONFIG = {
  // Only these desks are enriched; each names its search language filter.
  // World passes lang=en to Bluesky search; India (en + hi) can't express two
  // languages in one search param, so it searches unfiltered and filters
  // client-side on the post's declared langs instead.
  desks: {
    geopolitics: { langs: ["en"], mastodon: true },
    india: { langs: ["en", "hi"], mastodon: false }, // Mastodon never applies to India
  },

  perDeskCap: 8,             // top N stories enriched per desk per sweep
  searchLimit: 25,           // candidates pulled per search
  // Bluesky search ANDs its terms — more tokens = fewer hits. Four keywords
  // (proper nouns first) finds discussion; six live-tested to near-zero.
  maxQueryTokens: 4,
  maxQueryChars: 100,

  // Similarity = title-side overlap: the share of the headline's meaningful
  // tokens found in the post text, needing at least minSharedTokens in common.
  // (Plain Jaccard was tried first and live-matched ONLY verbatim headline
  // bots — engaged posts paraphrase and add text, which inflates the union
  // and collapses the score. Same rule-based overlap idea, same threshold.)
  similarityThreshold: 0.35,
  minSharedTokens: 3,
  recencyWindowDays: 3,      // post must sit within this window of the story date

  // Among candidates clearing the similarity threshold, the MOST ENGAGED one
  // wins (not the most similar): headline-mirror bots repost titles verbatim
  // and would otherwise beat every real discussion on pure similarity. A match
  // below this total engagement (likes+reposts+replies+quotes) is discarded —
  // zero reaction is not reader reaction.
  candidateMinEngagement: 3,

  replyCap: 18,              // top-level replies sampled for sentiment, by likes

  // Per-call timeout. The Pulse stage runs after the 8–17s pipeline inside the
  // same 30s scheduled function, so calls stay tight; phases run in parallel.
  fetchTimeoutMs: 4000,

  // Bluesky's adult-content moderation labels (the over_18 analog) — any
  // candidate carrying one of these is treated as no match.
  adultLabels: ["porn", "sexual", "nudity", "graphic-media"],

  // Controversial = split tone (both sides above the split) OR quote-heavy
  // engagement (Bluesky quote culture skews commentary/pushback).
  controversialSplitPct: 35,
  quoteToLikeRatio: 0.2,
  minQuotesForControversy: 5,

  // Optional secondary signal, World only, off unless MASTODON_ENABLED=true.
  // Hashtag timelines only — no free-text search exists fediverse-wide.
  mastodon: {
    instance: "https://mastodon.social",
    hashtags: ["worldnews", "geopolitics"],
    perTagLimit: 40,
  },
};
