import { tierFor } from "./scoring.mjs";

const STOPWORDS = new Set([
  "the", "a", "an", "to", "of", "in", "on", "for", "and", "as", "at", "with",
  "after", "over", "amid", "by", "is", "are", "was", "were", "says", "say",
  "said", "from", "its", "his", "her", "their", "new", "how", "why", "what",
]);

// Also exported (as titleTokens/similarTitles below) for the Tavily-merge and
// commentary layers, so "same story" means one thing everywhere.
function tokens(title) {
  return new Set(
    title.toLowerCase().replace(/[^a-z0-9\s]/g, " ").split(/\s+/)
      .filter((w) => w.length > 1 && !STOPWORDS.has(w))
  );
}

function canonUrl(url) {
  try {
    const u = new URL(url);
    return (u.hostname.replace(/^www\./, "") + u.pathname.replace(/\/$/, "")).toLowerCase();
  } catch {
    return url;
  }
}

function similar(aTokens, bTokens) {
  if (!aTokens.size || !bTokens.size) return false;
  let inter = 0;
  for (const t of aTokens) if (bTokens.has(t)) inter++;
  const union = aTokens.size + bTokens.size - inter;
  const containment = inter / Math.min(aTokens.size, bTokens.size);
  // Same-story headlines across outlets share ~70% of the shorter title's
  // meaningful tokens but rarely reach high Jaccard, hence the two tests.
  return inter / union >= 0.55 || (containment >= 0.7 && inter >= 4);
}

function bestTier(item) {
  return Math.min(...item.sources.map((s) => tierFor(s.domain)));
}

function merge(kept, dup) {
  for (const s of dup.sources) {
    if (!kept.sources.some((k) => k.domain === s.domain && k.name === s.name)) kept.sources.push(s);
  }
  // Prefer the higher-tier source's headline and link.
  if (bestTier(dup) < bestTier(kept)) {
    kept.title = dup.title;
    kept.url = dup.url;
  }
  if ((dup.summary?.length ?? 0) > (kept.summary?.length ?? 0)) kept.summary = dup.summary;
  if (dup.publishedAt && (!kept.publishedAt || dup.publishedAt < kept.publishedAt)) {
    kept.publishedAt = dup.publishedAt; // keep the earliest report time
  }
}

/** Collapse the same story reported by multiple feeds into one item. */
export function dedupeItems(items) {
  const out = [];
  const seenUrls = new Map();
  for (const item of items) {
    const cu = canonUrl(item.url);
    if (seenUrls.has(cu)) {
      merge(seenUrls.get(cu), item);
      continue;
    }
    item._tokens = tokens(item.title);
    const match = out.find((k) => similar(k._tokens, item._tokens));
    if (match) {
      merge(match, item);
    } else {
      out.push(item);
      seenUrls.set(cu, item);
    }
  }
  for (const item of out) delete item._tokens;
  return out;
}

export { tokens as titleTokens, similar as similarTitles };
