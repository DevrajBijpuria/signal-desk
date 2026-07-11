import { fetchText, hashId, sleep, decodeEntities, toIso, cleanText } from "./util.mjs";
import { fetchFeed } from "./feeds.mjs";

// Liquipedia asks for a descriptive User-Agent with contact info and roughly
// one parse request per two seconds. All Liquipedia calls run through one
// spaced queue with an overall budget so a slow wiki can't blow the 30s
// scheduled-function cap; the rumor/news feeds fetch in parallel outside it.
const LP_UA = "NewsIntelligenceDesk/1.0 (personal news dashboard; dbijpuria@gmail.com)";
const LP = "https://liquipedia.net";
const REQUEST_GAP_MS = 2100;
const BUDGET_MS = 24000;
const FETCH_TIMEOUT_MS = 9000;
// A task may only START while there's room for a worst-case fetch to finish
// inside the budget — a rate-limited request that hangs to its timeout must
// never push the scheduled function past Netlify's 30s kill.
const START_CUTOFF_MS = BUDGET_MS - FETCH_TIMEOUT_MS - 500;

const WIKIS = [
  { id: "valorant", game: "VALORANT", ewc: true },
  { id: "counterstrike", game: "CS2", ewc: true },
  { id: "dota2", game: "Dota 2", ewc: true },
  { id: "pubgmobile", game: "PUBG Mobile", ewc: false }, // its EWC event is PMWC, already on the main page
];

const INDIAN_ORGS = /(global esports|velocity gaming|s8ul|revenant|gods reign|orangutan|godlike|team soul|blind esports|enigma gaming|true rippers|medal esports|reckoning|genesis esports|marcos gaming|gujarat tigers|8bit|entity gaming|the esports club|skyesports|villager esports)/i;

// Main-page tournaments mostly carry coarse region groups (all of "Pacific"
// lists India), so a region only counts as Indian when it's specific.
const isIndiaRegion = (region) => {
  const parts = region.split(",").map((s) => s.trim().toLowerCase()).filter(Boolean);
  return parts.length <= 3 && parts.some((p) => p === "india" || p === "south asia");
};
const INDIA_TITLE = /\bindian?\b|\bbgmi\b|\bbgis\b|\bbmps\b|south asia/i;

const EWC_TITLE = /esports world cup|\bewc\b|\bpmwc\b|pubg mobile world cup/i;

const KEEP_TIERS = new Set(["S-Tier", "A-Tier", "B-Tier"]);

function parseTournaments(html, wiki) {
  const items = [];
  const sections = html.matchAll(
    /tournaments-list-heading">([^<]+)<\/span><ul class="tournaments-list-type-list">([\s\S]*?)<\/ul>/g
  );
  for (const m of sections) {
    const status = m[1]; // Upcoming | Ongoing | Completed
    let kept = 0;
    for (const li of m[2].split(/<li[ >]/).slice(1)) {
      if (kept >= 5) break;
      const region = (li.match(/data-filter-category="([^"]*)"/) || [])[1] || "";
      const tier = (li.match(/tournament-badge(?:&#95;|_){2}text">([^<]+)</) || [])[1] || "";
      const name = li.match(/<span class="tournament-name"><a href="([^"]+)"[^>]*>([^<]+)<\/a>/);
      const dates = (li.match(/tournaments-list-dates[^>]*><a[^>]*>([^<]+)<\/a>/) || [])[1] || "";
      if (!name || !KEEP_TIERS.has(tier)) continue;
      kept++;
      const title = decodeEntities(name[2]);
      const tags = [wiki.game, status === "Completed" ? "Result" : status];
      if (EWC_TITLE.test(title)) tags.push("EWC");
      items.push({
        id: hashId(LP + name[1] + status),
        kind: "tournament",
        status,
        game: wiki.game,
        title:
          status === "Completed" ? `${title} — final results in`
          : status === "Ongoing" ? `${title} — in progress`
          : `${title} — upcoming`,
        url: LP + name[1],
        summary: [tier, dates].filter(Boolean).join(" · "),
        dates,
        tier,
        publishedAt: null,
        scope: isIndiaRegion(region) || INDIA_TITLE.test(title) || INDIAN_ORGS.test(title) ? "india" : "global",
        sources: [{ name: "Liquipedia", domain: "liquipedia.net", url: LP + name[1] }],
        tags,
      });
    }
  }
  return items;
}

// Newer main-page variant (pubgmobile): status lives on toggle areas
// (1=Upcoming, 2=Ongoing, 3=Completed) and items use tournaments-list-item.
// data-filter-category carries the game — "bgmi" is India-only by definition.
function parseTournamentsV2(html, wiki) {
  const items = [];
  const AREA_STATUS = { 1: "Upcoming", 2: "Ongoing", 3: "Completed" };
  const areas = html.matchAll(
    /data-toggle-area-content="(\d)">[\s\S]*?<ul class="tournaments-list-type-list">([\s\S]*?)<\/ul>/g
  );
  for (const m of areas) {
    const status = AREA_STATUS[m[1]];
    if (!status) continue;
    let kept = 0;
    for (const li of m[2].split(/<li[ >]/).slice(1)) {
      if (kept >= 5) break;
      const cats = [...li.matchAll(/data-filter-category="([^"]*)"/g)].map((c) => c[1]);
      const isBgmi = cats.includes("bgmi");
      const tier = (li.match(/tournament-badge(?:&#95;|_){2}text">([^<]+)</) || [])[1] || "";
      const name = li.match(/tournaments-list-item(?:&#95;|_){2}name"><a href="([^"]+)"[^>]*>([^<]+)<\/a>/);
      const dates = (li.match(/tournaments-list-item(?:&#95;|_){2}date">([^<]+)</) || [])[1] || "";
      // BGMI events run lower tiers, so keep C-Tier for them only.
      if (!name || !(KEEP_TIERS.has(tier) || (isBgmi && tier === "C-Tier"))) continue;
      kept++;
      const title = decodeEntities(name[2]);
      const game = isBgmi ? "BGMI" : wiki.game;
      const tags = [game, status === "Completed" ? "Result" : status];
      if (EWC_TITLE.test(title)) tags.push("EWC");
      items.push({
        id: hashId(LP + name[1] + status),
        kind: "tournament",
        status,
        game,
        title:
          status === "Completed" ? `${title} — final results in`
          : status === "Ongoing" ? `${title} — in progress`
          : `${title} — upcoming`,
        url: LP + name[1],
        summary: [tier, dates].filter(Boolean).join(" · "),
        dates,
        tier,
        publishedAt: null,
        scope: isBgmi || INDIA_TITLE.test(title) || INDIAN_ORGS.test(title) ? "india" : "global",
        sources: [{ name: "Liquipedia", domain: "liquipedia.net", url: LP + name[1] }],
        tags,
      });
    }
  }
  return items;
}

function parseTransfers(html, wiki) {
  const items = [];
  const rows = html.split(/<div class="divRow mainpage-transfer-[a-z-]*">/).slice(1);
  for (const raw of rows.slice(0, 8)) {
    const row = raw.slice(0, 5000);
    const date = (row.match(/Date">(\d{4}-\d{2}-\d{2})/) || [])[1];
    const player = row.match(/class="name"[^>]*><a href="([^"]+)"[^>]*>([^<]+)<\/a>/);
    if (!date || !player) continue;
    const flag = (row.match(/<span class="flag"><img alt="([^"]+)"/) || [])[1] || "";
    const playerCount = (row.match(/block-player/g) || []).length;

    const oldIdx = row.indexOf("OldTeam");
    const iconIdx = row.indexOf('divCell Icon');
    const newIdx = row.indexOf("NewTeam");
    const oldSeg = oldIdx > -1 && iconIdx > oldIdx ? row.slice(oldIdx, iconIdx) : "";
    const newSeg = newIdx > -1 ? row.slice(newIdx) : "";
    const oldTeam = (oldSeg.match(/title="([^"]+)"/) || [])[1] || null;
    const newTeam = (newSeg.match(/title="([^"]+)"/) || [])[1] || null;
    const role = (newSeg.match(/\(([^()<>]{2,30})\)<\/span>/) || [])[1] || null;

    const who = decodeEntities(player[2]) + (playerCount > 1 ? ` and ${playerCount - 1} other${playerCount > 2 ? "s" : ""}` : "");
    let title;
    if (newTeam && oldTeam) title = `${who}: ${decodeEntities(oldTeam)} → ${decodeEntities(newTeam)}`;
    else if (newTeam) title = `${who} join${playerCount > 1 ? "" : "s"} ${decodeEntities(newTeam)}${role ? ` (${role})` : ""}`;
    else if (oldTeam) title = `${who} leave${playerCount > 1 ? "" : "s"} ${decodeEntities(oldTeam)}`;
    else continue;

    const teams = `${oldTeam ?? ""} ${newTeam ?? ""}`;
    items.push({
      id: hashId(LP + player[1] + date),
      kind: "roster",
      game: wiki.game,
      title,
      url: LP + player[1],
      summary: `Roster move logged ${date}${role ? ` · ${role}` : ""}`,
      publishedAt: toIso(date),
      scope: flag === "India" || INDIAN_ORGS.test(teams) ? "india" : "global",
      sources: [{ name: "Liquipedia", domain: "liquipedia.net", url: LP + player[1] }],
      tags: [wiki.game, "Roster"],
    });
  }
  return items;
}

// EWC 2026 tournament page per game wiki: one hub item from the infobox
// (dates, prize pool, venue), scoped to India when an Indian org is among
// the participants listed on the page.
function parseEwcPage(html, wiki) {
  const cell = (label) => {
    const m = html.match(new RegExp(`infobox-description">${label}:<\\/div><div[^>]*>([\\s\\S]{0,300}?)<\\/div>`));
    return m ? decodeEntities(m[1].replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim()) : null;
  };
  const start = cell("Start Date");
  const end = cell("End Date");
  const prize = cell("Prize Pool");
  const location = cell("Location");
  const teams = cell("Teams");
  if (!start && !prize) return []; // page exists but isn't a tournament page

  const today = new Date().toISOString().slice(0, 10);
  const status = end && today > end ? "Completed" : start && today >= start ? "Ongoing" : "Upcoming";
  // print like a paper ("Jul 2 – Jul 12, 2026"), not ISO
  const pretty = (iso) => {
    const d = new Date(iso + "T00:00:00Z");
    return Number.isNaN(d.getTime()) ? iso : d.toLocaleDateString("en-GB", { month: "short", day: "numeric", timeZone: "UTC" });
  };
  const year = (start || end || "").slice(0, 4);
  const dates = [start, end].filter(Boolean).map(pretty).join(" – ") + (year ? `, ${year}` : "");
  const url = `${LP}/${wiki.id}/Esports_World_Cup/2026`;
  return [{
    id: hashId(url + status),
    kind: "tournament",
    status,
    game: wiki.game,
    title:
      status === "Completed" ? `Esports World Cup 2026 (${wiki.game}) — final results in`
      : status === "Ongoing" ? `Esports World Cup 2026 (${wiki.game}) — in progress`
      : `Esports World Cup 2026 (${wiki.game}) — upcoming`,
    url,
    summary: [prize, teams ? `${teams} teams` : null, location, dates].filter(Boolean).join(" · "),
    dates,
    tier: "S-Tier",
    publishedAt: null,
    scope: INDIAN_ORGS.test(html) ? "india" : "global",
    sources: [{ name: "Liquipedia", domain: "liquipedia.net", url }],
    tags: [wiki.game, status === "Completed" ? "Result" : status, "EWC"],
  }];
}

// ---------- roster/transfer news + rumors from esports outlets ----------

const NEWS_FEEDS = [
  { id: "dexerto-esports", name: "Dexerto", url: "https://www.dexerto.com/esports/feed/", cap: 25 },
  { id: "dotesports", name: "Dot Esports", url: "https://dotesports.com/feed", cap: 15 },
];

const RUMOR_MARKERS = /(rumou?r|reportedly|sources? (say|claim|suggest)|in talks|linked (to|with)|set to (join|sign|leave)|expected to (join|sign)|allegedly|leak(ed|s)?\b)/i;
const ROSTER_MARKERS = /\b(signs?|re-signs?|signing|joins?|benched|benches|parts ways|roster|lineup|transfers?|departs?|steps down|retires?|acquires?|unveils?)\b/i;
const GAME_CHIP = [
  [/valorant|vct\b/i, "VALORANT"],
  [/counter-?strike|\bcs2?\b|\bcsgo\b/i, "CS2"],
  [/dota/i, "Dota 2"],
  [/\bbgmi\b|battlegrounds mobile/i, "BGMI"],
  [/pubg mobile|\bpmwc\b/i, "PUBG Mobile"],
  [/league of legends|\blol\b|\blec\b|\blck\b/i, "LoL"],
];

async function fetchEsportsNews(stats) {
  const results = await Promise.all(NEWS_FEEDS.map((def) => fetchFeed(def, stats)));
  const out = [];
  for (const item of results.flat()) {
    const text = `${item.title} ${item.summary}`;
    const isEwc = EWC_TITLE.test(text);
    const isRumor = RUMOR_MARKERS.test(text);
    const isRoster = ROSTER_MARKERS.test(text);
    if (!isEwc && !isRumor && !isRoster) continue; // general gaming news — not this desk's beat
    const tags = [];
    const game = GAME_CHIP.find(([re]) => re.test(text));
    if (game) tags.push(game[1]);
    if (isEwc) tags.push("EWC");
    if (isRumor) tags.push("Rumor");
    else if (isRoster) tags.push("Roster");
    out.push({
      ...item,
      kind: "roster",
      rumor: isRumor,
      scope: INDIA_TITLE.test(text) || INDIAN_ORGS.test(text) ? "india" : "global",
      tags,
    });
  }
  // newest first, modest cap so tournament coverage isn't drowned out
  out.sort((a, b) => (b.publishedAt ?? "").localeCompare(a.publishedAt ?? ""));
  return out.slice(0, 12);
}

const STATUS_ORDER = { Ongoing: 0, Completed: 1, roster: 2, Upcoming: 3 };
const TIER_ORDER = { "S-Tier": 0, "A-Tier": 1, "B-Tier": 2 };

export async function fetchEsports(stats) {
  // Liquipedia queue: 4 main pages + 3 EWC pages, spaced, under one budget.
  const queue = [];
  for (const wiki of WIKIS) {
    queue.push({
      id: `liquipedia-${wiki.id}`,
      url: `${LP}/${wiki.id}/api.php?action=parse&page=Main_Page&format=json&prop=text&disablelimitreport=1`,
      parse: (html) => [...parseTournaments(html, wiki), ...parseTournamentsV2(html, wiki), ...parseTransfers(html, wiki)],
    });
  }
  for (const wiki of WIKIS.filter((w) => w.ewc)) {
    queue.push({
      id: `liquipedia-${wiki.id}-ewc`,
      url: `${LP}/${wiki.id}/api.php?action=parse&page=${encodeURIComponent("Esports_World_Cup/2026")}&format=json&prop=text&disablelimitreport=1`,
      parse: (html) => parseEwcPage(html, wiki),
    });
  }

  const runQueue = (async () => {
    const items = [];
    const t0 = Date.now();
    for (let i = 0; i < queue.length; i++) {
      const task = queue[i];
      if (Date.now() - t0 > START_CUTOFF_MS) {
        stats.push({ id: task.id, ok: false, error: "skipped — esports time budget exhausted" });
        continue;
      }
      const started = Date.now();
      try {
        const body = await fetchText(task.url, { timeoutMs: FETCH_TIMEOUT_MS, ua: LP_UA });
        const html = JSON.parse(body)?.parse?.text?.["*"] || "";
        const found = task.parse(html);
        items.push(...found);
        stats.push({ id: task.id, ok: true, items: found.length, ms: Date.now() - started });
      } catch (err) {
        stats.push({ id: task.id, ok: false, error: err.message, ms: Date.now() - started });
      }
      if (i < queue.length - 1) await sleep(REQUEST_GAP_MS);
    }
    return items;
  })();

  const [lpItems, newsItems] = await Promise.all([runQueue, fetchEsportsNews(stats)]);
  const items = [...lpItems, ...newsItems];

  items.sort((a, b) => {
    // EWC coverage leads its bucket — it's the marquee event.
    const sa = STATUS_ORDER[a.kind === "roster" ? "roster" : a.status] ?? 4;
    const sb = STATUS_ORDER[b.kind === "roster" ? "roster" : b.status] ?? 4;
    if (sa !== sb) return sa - sb;
    const ea = a.tags?.includes("EWC") ? 0 : 1;
    const eb = b.tags?.includes("EWC") ? 0 : 1;
    if (ea !== eb) return ea - eb;
    if (a.kind === "roster" && b.kind === "roster") return (b.publishedAt ?? "").localeCompare(a.publishedAt ?? "");
    return (TIER_ORDER[a.tier] ?? 3) - (TIER_ORDER[b.tier] ?? 3);
  });

  // Cap the section, but never at the cost of India-scoped items — they're
  // scarce and the India toggle depends on them.
  const keep = items.slice(0, 56);
  for (const it of items.slice(56)) if (it.scope === "india") keep.push(it);
  return keep;
}
