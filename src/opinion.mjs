// Opinion/editorial detection — free signals already present in fetched data,
// no model. An item that matches gets contentType: "opinion" and is pulled out
// of the High/Medium/Low legitimacy pipeline entirely: never tier-scored,
// never merged into a news story's sources, never counted as corroboration.
// Applies to all four sections.

// URL path segments that outlets use for opinion sections. Plural forms are
// the same words (Al Jazeera files under /opinions/, many US papers under
// /editorials/); nothing beyond the spec'd families.
const OPINION_PATH =
  /\/(opinion|opinions|op-ed|perspectives?|commentary|editorial|editorials|voices|columns?)(\/|$)/i;

// RSS <category> tags — most major outlets tag opinion content explicitly.
// Whole-tag match, not substring: a news piece categorized "Media commentary
// row" must not trip it.
const OPINION_CATEGORY =
  /^(opinion|opinions|op-eds?|editorial|editorials|commentary|columns?|columnists?|voices|perspectives?|comment)$/i;

// Byline patterns in the title or summary copy.
const OPINION_TEXT =
  /^opinion\s*[:|—-]|\|\s*opinion\s*$|\bopinion by\b|\bop-ed\b|contributing columnist|guest column|\beditorial board\b/i;

/**
 * True when an item reads as opinion/editorial content.
 * Accepts { url, title, summary, categories } — categories optional
 * (only feed-sourced items carry them).
 */
export function detectOpinion({ url, title, summary, categories }) {
  try {
    if (OPINION_PATH.test(new URL(url ?? "").pathname)) return true;
  } catch { /* unparseable URL — fall through to the text signals */ }
  if ((categories ?? []).some((c) => OPINION_CATEGORY.test(String(c).trim()))) return true;
  return OPINION_TEXT.test(String(title ?? "")) || OPINION_TEXT.test(String(summary ?? "").slice(0, 160));
}
