import { toneScore } from "./sentimentLexicon.mjs";

// Cross-source framing: how differently each outlet worded its OWN headline
// for the same story. Scores headline word-choice only (the same AFINN-165
// lexicon wrapper Public Pulse uses for Reaction Tone) — it is a separate
// axis from the legitimacy tier and from Pulse's reader-reaction metrics,
// and never feeds either.
//
// Thresholds kept as data, same spirit as the pulse config. AFINN headline
// sums are small integers — live sweep 2026-07-16 scored 154 headlines in
// [-7, +4], median 0, bulk within ±2 — so ±1 is "near zero" and ±4 is a
// strongly loaded headline. Buckets are ordered; first `score <= max` wins.
export const FRAMING_CONFIG = {
  minSources: 2, // single-source stories get no framing field at all
  buckets: [
    { max: -4, label: "Critical" },   // strongly negative
    { max: -1, label: "Skeptical" },  // mildly negative
    { max: 1, label: "Neutral" },     // near zero
    { max: 3, label: "Measured" },    // mildly positive
    { max: Infinity, label: "Favorable" }, // strongly positive
  ],
};

export function framingLabel(score) {
  return FRAMING_CONFIG.buckets.find((b) => score <= b.max).label;
}

/**
 * Attach `item.framing` = [{ source, label, score }] to every story whose
 * cluster kept >= minSources per-source headlines; the field is omitted
 * entirely (never an empty array) below that. Commentary is never framed.
 * Safe to re-run on an already-framed stored item (manual-discovery path).
 */
export function attachFraming(items) {
  for (const item of items) {
    if (item.kind === "commentary") continue;
    delete item.framing;
    const entries = (item.sources ?? [])
      .filter((s) => s.headline)
      .map((s) => ({ source: s.name || s.domain, score: toneScore(s.headline) }))
      .filter((e) => e.score != null)
      .map((e) => ({ source: e.source, label: framingLabel(e.score), score: e.score }));
    if (entries.length >= FRAMING_CONFIG.minSources) item.framing = entries;
  }
}
