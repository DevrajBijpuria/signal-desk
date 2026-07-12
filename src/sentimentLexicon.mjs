// Thin wrapper around the `sentiment` npm package (AFINN-165 word list —
// rule-based, no model) so the scoring method stays swappable later without
// touching pulse.mjs. Note the lexicon is English-only: Hindi replies on the
// India desk score 0 and land in the neutral bucket.
import Sentiment from "sentiment";

const sentiment = new Sentiment();

/**
 * Lexicon score for one piece of text: positive > 0, negative < 0, 0 neutral.
 * Returns null for empty/deleted bodies (the "[removed]" equivalent) so they
 * drop out of the sample instead of counting as neutral.
 */
export function toneScore(text) {
  const cleaned = String(text ?? "")
    .replace(/https?:\/\/\S+/g, " ")      // bare links carry no tone
    .replace(/[*_`>#~|]/g, " ")           // markdown furniture
    .replace(/\s+/g, " ")
    .trim();
  if (!cleaned) return null;
  return sentiment.analyze(cleaned).score;
}
