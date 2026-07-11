// Rule-based legitimacy scoring. No model, no API calls — a source-tier map,
// a High/Medium/Low mapping, and a corroboration bump. Every item gets the
// reason attached so the rating is auditable in the UI.

// Tier 1: wire services, PIB/government, official company blogs, peer-reviewed journals.
// Tier 2: single reputable outlets, arXiv preprints, moderated wikis.
// Anything unknown: tier 3.
const TIER1 = [
  "reuters.com", "apnews.com", "afp.com", "bbc.co.uk", "bbc.com",
  "pib.gov.in", "rbi.org.in", "meity.gov.in", "mea.gov.in", "isro.gov.in",
  "whitehouse.gov", "europa.eu", "un.org", "who.int",
  "openai.com", "anthropic.com", "blog.google", "ai.google", "deepmind.google",
  "ai.meta.com", "about.fb.com", "blogs.microsoft.com", "microsoft.com",
  "blogs.nvidia.com", "nvidia.com", "amazon.science", "aws.amazon.com",
  "apple.com", "github.blog", "huggingface.co", "mistral.ai", "x.ai",
  "cohere.com", "stability.ai", "sakana.ai", "deepseek.com", "z.ai",
  "nature.com", "science.org",
];

const TIER2 = [
  "techcrunch.com", "theverge.com", "venturebeat.com", "arstechnica.com",
  "wired.com", "theinformation.com", "bloomberg.com", "ft.com", "wsj.com",
  "nytimes.com", "theguardian.com", "washingtonpost.com", "cnbc.com",
  "cnn.com", "economist.com", "aljazeera.com", "france24.com", "dw.com",
  "npr.org", "politico.com", "axios.com", "semafor.com", "apnorc.org",
  "thehindu.com", "indianexpress.com", "hindustantimes.com",
  "timesofindia.indiatimes.com", "economictimes.indiatimes.com",
  "livemint.com", "ndtv.com", "theprint.in", "thewire.in", "scroll.in",
  "business-standard.com", "moneycontrol.com",
  "arxiv.org", "liquipedia.net", "spectrum.ieee.org", "mit.edu",
  "technologyreview.com", "theregister.com", "dexerto.com", "dotesports.com",
];

function inList(domain, list) {
  return list.some((d) => domain === d || domain.endsWith("." + d));
}

export function tierFor(domain) {
  if (!domain) return 3;
  if (inList(domain, TIER1)) return 1;
  if (inList(domain, TIER2)) return 2;
  return 3;
}

const LEVELS = ["high", "medium", "low"]; // index = tier - 1
const bump = (level) => LEVELS[Math.max(0, LEVELS.indexOf(level) - 1)];

// Special-cased reasons where the generic wording would mislead.
function sourceNote(domain) {
  if (domain === "arxiv.org") return "primary preprint, not yet peer-reviewed";
  if (domain === "liquipedia.net") return "community-maintained wiki, actively moderated";
  return null;
}

/**
 * item.sources: [{ name, domain, url }] (deduped across feeds already).
 * Attaches item.trust = { level, tier, reason }.
 */
export function scoreItem(item) {
  const seen = new Set();
  const scored = [];
  for (const s of item.sources) {
    const key = s.domain || s.name;
    if (seen.has(key)) continue;
    seen.add(key);
    scored.push({ ...s, tier: tierFor(s.domain) });
  }

  const best = Math.min(...scored.map((s) => s.tier));
  const tier1 = scored.filter((s) => s.tier === 1);
  const names = (list) => [...new Set(list.map((s) => s.name || s.domain))];

  let level = LEVELS[best - 1];
  let reason;

  if (tier1.length >= 2) {
    level = bump(level); // already High when tier-1 present; kept for rule completeness
    reason = `Corroborated by ${tier1.length} independent tier-1 sources (${names(tier1).join(", ")}).`;
  } else if (best === 1) {
    const note = sourceNote(tier1[0].domain);
    reason = `Tier-1 source: ${names(tier1)[0]}${note ? ` (${note})` : " (wire/primary source)"}. No second tier-1 confirmation yet.`;
  } else if (best === 2) {
    const t2 = scored.filter((s) => s.tier === 2);
    const note = sourceNote(t2[0].domain);
    if (note) {
      reason = `${names(t2)[0]} — ${note}.`;
    } else if (t2.length >= 2) {
      reason = `Reported by ${names(t2).join(" and ")}; no wire or primary source yet.`;
    } else {
      reason = `Single reputable outlet (${names(t2)[0]}); not yet confirmed by a wire or primary source.`;
    }
  } else {
    const d = scored[0]?.domain || "unknown source";
    reason = `Single unrecognized source (${d}). Treat as unconfirmed.`;
  }

  item.sources = scored;
  item.trust = { level, tier: best, reason };
  return item;
}
