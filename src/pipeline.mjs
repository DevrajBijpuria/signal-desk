import { fetchJson, fetchText, hostOf, hashId, toIso, firstSentences, cleanText } from "./util.mjs";
import { fetchFeed, parseFeed } from "./feeds.mjs";
import { dedupeItems, titleTokens, similarTitles } from "./dedupe.mjs";
import { scoreItem } from "./scoring.mjs";
import { marketNote } from "./market.mjs";
import { fetchEsports } from "./esports.mjs";
import { fetchTavilyDiscovery } from "./tavily.mjs";
import { fetchCommentary, attachCommentary } from "./commentary.mjs";

const FEEDS = {
  tech: [
    { id: "techcrunch", name: "TechCrunch", url: "https://techcrunch.com/feed/", cap: 10 },
    { id: "theverge", name: "The Verge", url: "https://www.theverge.com/rss/index.xml", cap: 10 },
    { id: "venturebeat", name: "VentureBeat", url: "https://venturebeat.com/feed/", cap: 10 },
    { id: "ars-technica", name: "Ars Technica", url: "https://feeds.arstechnica.com/arstechnica/index", cap: 8 },
    { id: "wired", name: "Wired", url: "https://www.wired.com/feed/rss", cap: 8 },
    { id: "mit-tech-review", name: "MIT Tech Review", url: "https://www.technologyreview.com/feed/", cap: 6 },
    { id: "ieee-spectrum", name: "IEEE Spectrum", url: "https://spectrum.ieee.org/feeds/feed.rss", cap: 6 },
    { id: "the-register", name: "The Register", url: "https://www.theregister.com/headlines.atom", cap: 8 },
  ],
  geo: [
    { id: "bbc-world", name: "BBC World", url: "https://feeds.bbci.co.uk/news/world/rss.xml", cap: 15 },
    // Reuters and AP retired their public RSS; Google News RSS scoped to each
    // domain still carries the original outlet in <source>, which is what the
    // tier scoring keys on.
    { id: "reuters", name: "Reuters", gnews: true, cap: 12,
      url: "https://news.google.com/rss/search?q=" + encodeURIComponent('site:reuters.com/world when:2d') + "&hl=en-US&gl=US&ceid=US:en" },
    { id: "ap", name: "AP", gnews: true, cap: 12,
      url: "https://news.google.com/rss/search?q=" + encodeURIComponent('site:apnews.com "world news" when:2d') + "&hl=en-US&gl=US&ceid=US:en" },
    { id: "aljazeera", name: "Al Jazeera", url: "https://www.aljazeera.com/xml/rss/all.xml", cap: 10 },
    { id: "guardian-world", name: "The Guardian", url: "https://www.theguardian.com/world/rss", cap: 10 },
    { id: "dw-world", name: "DW", url: "https://rss.dw.com/xml/rss-en-world", cap: 8 },
    { id: "france24", name: "France 24", url: "https://www.france24.com/en/rss", cap: 8 },
    { id: "npr-world", name: "NPR World", url: "https://feeds.npr.org/1004/rss.xml", cap: 8 },
    { id: "un-news", name: "UN News", url: "https://news.un.org/feed/subscribe/en/news/all/rss.xml", cap: 8 },
  ],
  india: [
    // PIB's own RSS currently serves Hindi titles with no dates regardless of
    // the Lang param; Google News scoped to pib.gov.in gives English + dates
    // and still attributes pib.gov.in, which is what tier-1 scoring keys on.
    { id: "pib", name: "PIB", gnews: true, cap: 8,
      url: "https://news.google.com/rss/search?q=" + encodeURIComponent("site:pib.gov.in when:2d") + "&hl=en-IN&gl=IN&ceid=IN:en" },
    { id: "the-hindu", name: "The Hindu", url: "https://www.thehindu.com/news/national/feeder/default.rss", cap: 12 },
    { id: "hindu-states", name: "The Hindu (States)", url: "https://www.thehindu.com/news/national/other-states/feeder/default.rss", cap: 10 },
    { id: "indian-express", name: "Indian Express", url: "https://indianexpress.com/section/india/feed/", cap: 12 },
    { id: "hindustan-times", name: "Hindustan Times", url: "https://www.hindustantimes.com/feeds/rss/india-news/rssfeed.xml", cap: 10 },
    { id: "ndtv", name: "NDTV", url: "https://feeds.feedburner.com/ndtvnews-india-news", cap: 8 },
    { id: "toi", name: "Times of India", url: "https://timesofindia.indiatimes.com/rssfeeds/-2128936835.cms", cap: 8 },
  ],
};

// ---------- Tech & AI extras: Hacker News + arXiv ----------

async function fetchHackerNews(stats) {
  const started = Date.now();
  try {
    const data = await fetchJson("https://hn.algolia.com/api/v1/search?tags=front_page&hitsPerPage=30", { timeoutMs: 8000 });
    const items = (data.hits ?? [])
      .sort((a, b) => (b.points ?? 0) - (a.points ?? 0))
      .slice(0, 12)
      .map((h) => {
        const hnUrl = `https://news.ycombinator.com/item?id=${h.objectID}`;
        const url = h.url || hnUrl;
        const domain = hostOf(url);
        return {
          id: hashId(url),
          title: cleanText(h.title, 200),
          url,
          summary: `${h.points ?? 0} points · ${h.num_comments ?? 0} comments on Hacker News`,
          publishedAt: toIso(h.created_at),
          sources: [{ name: domain, domain, url }],
          extraLink: { label: "HN discussion", url: hnUrl },
        };
      });
    stats.push({ id: "hacker-news", ok: true, items: items.length, ms: Date.now() - started });
    return items;
  } catch (err) {
    stats.push({ id: "hacker-news", ok: false, error: err.message, ms: Date.now() - started });
    return [];
  }
}

async function fetchArxiv(stats) {
  const started = Date.now();
  try {
    const xml = await fetchText(
      "https://export.arxiv.org/api/query?search_query=cat:cs.LG+OR+cat:cs.AI+OR+cat:cs.CL&sortBy=submittedDate&sortOrder=descending&max_results=8",
      { timeoutMs: 8000 }
    );
    const items = parseFeed(xml).map((e) => {
      const authors = e.authors?.slice(0, 3).join(", ") + (e.authors?.length > 3 ? " et al." : "");
      return {
        id: hashId(e.link),
        title: e.title,
        url: e.link,
        summary: `${firstSentences(e.summary, 2, 260)}${authors ? ` — ${authors}` : ""}`,
        publishedAt: e.publishedAt,
        sources: [{ name: "arXiv", domain: "arxiv.org", url: e.link }],
        tags: ["Research"],
      };
    });
    stats.push({ id: "arxiv", ok: true, items: items.length, ms: Date.now() - started });
    return items;
  } catch (err) {
    stats.push({ id: "arxiv", ok: false, error: err.message, ms: Date.now() - started });
    return [];
  }
}

// ---------- Geopolitics extra: GDELT ----------

async function fetchGdelt(stats) {
  const started = Date.now();
  try {
    const q = encodeURIComponent("(ceasefire OR sanctions OR summit OR election OR coup OR treaty OR conflict) sourcelang:english");
    const data = await fetchJson(
      `https://api.gdeltproject.org/api/v2/doc/doc?query=${q}&mode=artlist&maxrecords=25&format=json&timespan=1d&sort=hybridrel`,
      { timeoutMs: 8000 }
    );
    const items = (data.articles ?? []).slice(0, 15).map((a) => {
      // seendate looks like "20260709T121500Z"
      const iso = toIso(String(a.seendate ?? "").replace(
        /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/, "$1-$2-$3T$4:$5:$6Z"
      ));
      const domain = a.domain || hostOf(a.url);
      return {
        id: hashId(a.url),
        title: cleanText(a.title, 200),
        url: a.url,
        summary: "",
        publishedAt: iso,
        sources: [{ name: domain, domain, url: a.url }],
      };
    });
    stats.push({ id: "gdelt", ok: true, items: items.length, ms: Date.now() - started });
    return items;
  } catch (err) {
    stats.push({ id: "gdelt", ok: false, error: err.message, ms: Date.now() - started });
    return [];
  }
}

// ---------- Rule-based tagging ----------

function classifyTech(item) {
  if (item.tags?.length) return item;
  const text = `${item.title} ${item.summary}`;
  const tag =
    /(raises|funding round|series [a-e]\b|seed round|valuation|acquires|acquisition)/i.test(text) ? "Funding"
    : /(paper|study|benchmark|researchers|breakthrough|state[- ]of[- ]the[- ]art)/i.test(text) ? "Research"
    : /(lawsuit|regulat|antitrust|copyright|court|senate|ai act|executive order)/i.test(text) ? "Policy"
    : /(open[- ]?source|sdk|\bapi\b|framework|library|developer|\bcli\b)/i.test(text) ? "Tooling"
    : /(launch|unveil|release|debut|introduc|announc|ships|rolls out|now available)/i.test(text) ? "Launch"
    : "Update";
  item.tags = [tag];
  return item;
}

const INDIAN_STATES = [
  "Andhra Pradesh", "Arunachal Pradesh", "Assam", "Bihar", "Chhattisgarh", "Goa",
  "Gujarat", "Haryana", "Himachal Pradesh", "Jharkhand", "Karnataka", "Kerala",
  "Madhya Pradesh", "Maharashtra", "Manipur", "Meghalaya", "Mizoram", "Nagaland",
  "Odisha", "Punjab", "Rajasthan", "Sikkim", "Tamil Nadu", "Telangana", "Tripura",
  "Uttar Pradesh", "Uttarakhand", "West Bengal", "Delhi", "Jammu", "Kashmir",
  "Ladakh", "Puducherry", "Bengaluru", "Mumbai", "Chennai", "Hyderabad", "Kolkata",
];

function tagIndia(item) {
  const tags = [];
  if (item.sources.some((s) => s.domain === "pib.gov.in")) tags.push("Government");
  const text = `${item.title} ${item.summary}`;
  for (const state of INDIAN_STATES) {
    if (tags.length >= 3) break;
    if (new RegExp(`\\b${state}\\b`, "i").test(text)) tags.push(state);
  }
  item.tags = tags;
  return item;
}

// ---------- Section builders ----------

function finish(items, { cap = 30, sort = true } = {}) {
  const deduped = dedupeItems(items).map(scoreItem);
  if (sort) {
    deduped.sort((a, b) => (b.publishedAt ?? "").localeCompare(a.publishedAt ?? ""));
  }
  return deduped.slice(0, cap);
}

// Tavily discovery items enter each section BEFORE dedupe + scoring, so a
// result matching an existing story merges as a corroborating source (the
// normal dedupe merge) and a new result is scored through the same tier map
// as everything else. tavilyP is one shared promise across all builders.
async function buildTech(stats, tavilyP) {
  const [results, tavily] = await Promise.all([
    Promise.all([
      fetchHackerNews(stats),
      fetchArxiv(stats),
      ...FEEDS.tech.map((def) => fetchFeed(def, stats)),
    ]),
    tavilyP,
  ]);
  return finish([...results.flat(), ...tavily.tech], { cap: 36 }).map(classifyTech);
}

// Sports and entertainment leak into world-news feeds; they aren't geopolitics.
const NOT_GEOPOLITICS =
  /(world cup|olympic|fifa|football|soccer|tennis|cricket|golf|grand slam|premier league|formula (one|1)|grand prix|\bnba\b|\bnfl\b|\bmlb\b|singer|actor|actress|film|movie|museum|festival|celebrity|box office)/i;

async function buildGeopolitics(stats, tavilyP) {
  const [results, tavily] = await Promise.all([
    Promise.all([
      ...FEEDS.geo.map((def) => fetchFeed(def, stats)),
      fetchGdelt(stats),
    ]),
    tavilyP,
  ]);
  const newsOnly = [...results.flat(), ...tavily.geopolitics]
    .filter((i) => !NOT_GEOPOLITICS.test(i.title));
  return finish(newsOnly, { cap: 30 }).map((item) => {
    const m = marketNote(`${item.title} ${item.summary}`);
    if (m) item.market = m;
    return item;
  });
}

async function buildIndia(stats, tavilyP) {
  const [results, tavily] = await Promise.all([
    Promise.all(FEEDS.india.map((def) => fetchFeed(def, stats))),
    tavilyP,
  ]);
  const deduped = finish([...results.flat(), ...tavily.india], { cap: 999 });
  // PIB publishes less often than the dailies, so pure recency would squeeze
  // government releases out entirely. Reserve up to 5 seats, then re-sort.
  const pib = deduped.filter((i) => i.sources.some((s) => s.domain === "pib.gov.in")).slice(0, 5);
  const rest = deduped.filter((i) => !pib.includes(i)).slice(0, 30 - pib.length);
  return [...pib, ...rest]
    .sort((a, b) => (b.publishedAt ?? "").localeCompare(a.publishedAt ?? ""))
    .map(tagIndia);
}

async function buildEsports(stats, tavilyP) {
  // Items arrive pre-sorted (ongoing → results → roster → upcoming); keep that order.
  const [items, tavily] = await Promise.all([fetchEsports(stats), tavilyP]);
  // Esports skips dedupeItems (order is meaningful), so Tavily merges by hand:
  // a title match adds a corroborating source; anything else appends, scored
  // by the same scoreItem pass below as the rest of the section.
  for (const [scope, discovered] of [["global", tavily.esportsGlobal], ["india", tavily.esportsIndia]]) {
    for (const d of discovered) {
      const dTokens = titleTokens(d.title);
      const match = items.find((it) => similarTitles(titleTokens(it.title), dTokens));
      if (match) {
        const s = d.sources[0];
        if (!match.sources.some((k) => k.domain === s.domain)) match.sources.push(s);
      } else {
        items.push({ ...d, scope, tags: [] });
      }
    }
  }
  return items.map(scoreItem).map(applyRumorRule);
}

// Rumors never present as settled fact: force Low unless a tier-1 source
// (org channel, confirmed Liquipedia entry) corroborates the story.
function applyRumorRule(item) {
  if (item.rumor && item.trust.tier > 1) {
    const outlet = item.sources[0]?.name ?? "a single outlet";
    item.trust = {
      level: "low",
      tier: item.trust.tier,
      reason: `Transfer rumor — single unconfirmed report (${outlet}). Not corroborated by an official channel or a confirmed Liquipedia entry.`,
    };
  }
  return item;
}

/**
 * Reader-triggered Tavily merge into an ALREADY-SCORED stored sweep (the
 * scheduled path merges pre-scoring via finish() instead). Same semantics:
 * a title match gains a corroborating source and is re-scored; anything new
 * is scored through the tier map and section-tagged. Commentary items are
 * never match candidates. Mutates `sections`; returns { added, corroborated }.
 */
export function mergeManualDiscovery(sections, querySection, discovered) {
  const TARGET = {
    tech: { key: "tech" },
    geopolitics: { key: "geopolitics" },
    india: { key: "india" },
    esportsGlobal: { key: "esports", scope: "global" },
    esportsIndia: { key: "esports", scope: "india" },
  };
  const { key, scope } = TARGET[querySection];
  const items = sections[key];
  let added = 0, corroborated = 0;
  for (const d of discovered) {
    if (key === "geopolitics" && NOT_GEOPOLITICS.test(d.title)) continue;
    const dTokens = titleTokens(d.title);
    const match = items.find(
      (it) => it.kind !== "commentary" && similarTitles(titleTokens(it.title), dTokens)
    );
    if (match) {
      const s = d.sources[0];
      if (match.sources.some((k) => k.domain === s.domain)) continue; // already on the story
      match.sources.push(s);
      scoreItem(match);
      if (key === "esports") applyRumorRule(match);
      corroborated++;
    } else {
      scoreItem(d);
      if (key === "tech") classifyTech(d);
      else if (key === "india") tagIndia(d);
      else if (key === "geopolitics") {
        const m = marketNote(`${d.title} ${d.summary}`);
        if (m) d.market = m;
      } else if (key === "esports") {
        d.scope = scope;
        d.tags = [];
      }
      items.push(d);
      added++;
    }
  }
  return { added, corroborated };
}

export async function runPipeline() {
  const started = Date.now();
  const stats = [];
  // Tavily and YouTube commentary fetch in parallel with the feed builders —
  // run serially they'd stack on the esports time budget and threaten the
  // 30s scheduled-function cap.
  const tavilyP = fetchTavilyDiscovery(stats);
  const [commentary, tech, geopolitics, india, esports] = await Promise.all([
    fetchCommentary(stats),
    buildTech(stats, tavilyP),
    buildGeopolitics(stats, tavilyP),
    buildIndia(stats, tavilyP),
    buildEsports(stats, tavilyP),
  ]);
  // Commentary attaches after dedupe + scoring so it can never merge into a
  // source list or bump a legitimacy rating.
  attachCommentary(tech, commentary.tech);
  attachCommentary(geopolitics, commentary.geopolitics);
  attachCommentary(india, commentary.india);
  attachCommentary(esports, commentary.esportsGlobal, { scope: "global" });
  attachCommentary(esports, commentary.esportsIndia, { scope: "india" });
  return {
    generatedAt: new Date().toISOString(),
    durationMs: Date.now() - started,
    sourceStats: stats,
    sections: { tech, geopolitics, india, esports },
  };
}
