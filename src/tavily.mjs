// Tavily discovery search — one broad topical query per section per run,
// basic search depth. Strictly optional: if TAVILY_API_KEY is unset, or the
// Netlify Blobs budget ledger is unreachable (e.g. plain `npm run pipeline`
// outside a Netlify context), the whole layer skips cleanly and the desk runs
// on RSS/API/YouTube alone. Results feed the existing rule-based tier scoring;
// nothing here scores anything itself.
//
// Budget lock: TAVILY_MONTHLY_CREDITS (also env-only) is the plan ceiling.
// Actual spend is capped at 90% of it. Usage lives in Blobs as
// { month: "YYYY-MM", creditsUsed }, reset when the month rolls over. Each
// run may spend (cappedCeiling - creditsUsed) / daysLeftInMonth, so a skipped
// or failed run rolls its unused budget forward. Queries run in priority
// order (the array order below) and stop when the allowance is spent; every
// attempted request is counted as spent, success or failure — the safe side
// of the ledger. Usage is persisted back at the end of every run.
import { getStore } from "@netlify/blobs";
import { hostOf, hashId, toIso, cleanText } from "./util.mjs";

// Priority order: a tight allowance funds the top of this list first.
export const TAVILY_QUERIES = [
  { id: "tavily-tech", section: "tech", query: "latest AI model releases and research this week" },
  { id: "tavily-geo", section: "geopolitics", query: "major geopolitical developments today" },
  { id: "tavily-india", section: "india", query: "India state government news today" },
  { id: "tavily-esports-global", section: "esportsGlobal", query: "esports tournament results roster moves this week" },
  { id: "tavily-esports-india", section: "esportsIndia", query: "BGMI Valorant India esports news this week" },
];

const USAGE_KEY = "tavily-usage";
const SAFETY_MARGIN = 0.9;
const CREDITS_PER_QUERY = 1; // Tavily bills basic-depth search at 1 credit per request

// Reader-triggered "search the wire" fetches share this daily pool across all
// sections; it resets each UTC day. Manual spend also counts against the same
// monthly ledger, so the 90% cap holds no matter who clicks how often.
export const MANUAL_DAILY_CAP = 20;

const monthKey = (d) => d.toISOString().slice(0, 7);
const dayKey = (d) => d.toISOString().slice(0, 10);

/**
 * Read the ledger and roll it forward: a new month resets creditsUsed and
 * manualUsed; a new day resets manualUsed only. Always returns the full
 * normalized shape { month, creditsUsed, day, manualUsed }.
 */
export async function readLedger(store, now = new Date()) {
  const stored = await store.get(USAGE_KEY, { type: "json" });
  const month = monthKey(now);
  const day = dayKey(now);
  if (!stored || stored.month !== month) return { month, creditsUsed: 0, day, manualUsed: 0 };
  return {
    month,
    creditsUsed: stored.creditsUsed ?? 0,
    day,
    manualUsed: stored.day === day ? stored.manualUsed ?? 0 : 0,
  };
}

/** Manual fetches left today: the daily pool, never past the monthly cap. */
export function manualRemaining(ledger, ceiling) {
  const monthlyLeft = Math.floor(ceiling * SAFETY_MARGIN) - ledger.creditsUsed;
  return Math.max(0, Math.min(MANUAL_DAILY_CAP - ledger.manualUsed, monthlyLeft));
}

export function daysLeftInMonth(now = new Date()) {
  const lastDay = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 0)).getUTCDate();
  return lastDay - now.getUTCDate() + 1; // today counts — this run is spending it
}

// Pure budget math, exported for tests: how many credits this run may spend.
export function runAllowance(ceiling, creditsUsed, now = new Date()) {
  const capped = Math.floor(ceiling * SAFETY_MARGIN);
  return Math.max(0, capped - creditsUsed) / daysLeftInMonth(now);
}

async function searchTavily(apiKey, query) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), 8000);
  try {
    const res = await fetch("https://api.tavily.com/search", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({ query, search_depth: "basic", topic: "news", days: 7, max_results: 8 }),
      signal: ctl.signal,
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

function toItem(r) {
  const domain = hostOf(r.url);
  return {
    id: hashId(r.url),
    title: cleanText(r.title ?? "", 200),
    url: r.url,
    summary: cleanText(r.content ?? "", 280),
    publishedAt: r.published_date ? toIso(r.published_date) : null,
    sources: [{ name: domain, domain, url: r.url }],
  };
}

/** One section's fixed query, on demand (the reader-triggered path). */
export async function runSectionQuery(apiKey, section) {
  const q = TAVILY_QUERIES.find((x) => x.section === section);
  if (!q) throw new Error(`unknown section: ${section}`);
  const data = await searchTavily(apiKey, q.query);
  return (data.results ?? []).map(toItem).filter((i) => i.title && i.url);
}

/**
 * Runs the affordable slice of TAVILY_QUERIES and returns items keyed by
 * section: { tech, geopolitics, india, esportsGlobal, esportsIndia }.
 * Every skip/failure degrades to an empty section, never throws.
 */
export async function fetchTavilyDiscovery(stats) {
  const empty = Object.fromEntries(TAVILY_QUERIES.map((q) => [q.section, []]));

  const apiKey = process.env.TAVILY_API_KEY;
  if (!apiKey) return empty; // feature off — not a wire failure, no stat noise

  const ceiling = Number(process.env.TAVILY_MONTHLY_CREDITS);
  if (!Number.isFinite(ceiling) || ceiling <= 0) {
    stats.push({ id: "tavily", ok: false, error: "skipped — TAVILY_MONTHLY_CREDITS not set" });
    return empty;
  }

  // No reachable ledger ⇒ no spend. The budget lock is only as good as the
  // store behind it, so an unreadable ledger disables the layer for the run.
  let store, ledger;
  try {
    store = getStore("news-desk");
    ledger = await readLedger(store);
  } catch (err) {
    stats.push({ id: "tavily", ok: false, error: `skipped — budget store unavailable (${err.message})` });
    return empty;
  }

  const allowance = runAllowance(ceiling, ledger.creditsUsed);
  const affordable = Math.min(TAVILY_QUERIES.length, Math.floor(allowance / CREDITS_PER_QUERY));
  const run = TAVILY_QUERIES.slice(0, affordable);
  for (const q of TAVILY_QUERIES.slice(affordable)) {
    stats.push({ id: q.id, ok: false, error: "skipped — Tavily monthly budget spent" });
  }

  // Preserves the day/manualUsed fields — the scheduled run never resets the
  // reader's daily search pool.
  const usage = { ...ledger, creditsUsed: ledger.creditsUsed + run.length * CREDITS_PER_QUERY };

  const out = { ...empty };
  await Promise.all(
    run.map(async (q) => {
      const started = Date.now();
      try {
        const data = await searchTavily(apiKey, q.query);
        out[q.section] = (data.results ?? []).map(toItem).filter((i) => i.title && i.url);
        stats.push({ id: q.id, ok: true, items: out[q.section].length, ms: Date.now() - started });
      } catch (err) {
        stats.push({ id: q.id, ok: false, error: err.message, ms: Date.now() - started });
      }
    })
  );

  try {
    await store.setJSON(USAGE_KEY, usage);
  } catch (err) {
    stats.push({ id: "tavily-usage", ok: false, error: `usage not persisted: ${err.message}` });
  }
  return out;
}
