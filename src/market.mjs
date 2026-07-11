// Rule-based market-impact notes for geopolitics items. A note is only
// attached when a rule matches with a clear mechanism; otherwise we return
// null rather than inventing a link. Wording stays probabilistic ("tends
// to", "likely") because these are heuristics, not forecasts.

const COUNTRY_INDEX = [
  [/\bindia\b/i, "Nifty 50 / INR"],
  [/\bjapan\b/i, "Nikkei 225"],
  [/\bchina\b/i, "CSI 300 / Hang Seng"],
  [/\b(uk|britain|united kingdom)\b/i, "FTSE 100"],
  [/\bgermany\b/i, "DAX"],
  [/\bfrance\b/i, "CAC 40"],
  [/\b(us|u\.s\.|united states|america)\b/i, "S&P 500"],
  [/\btaiwan\b/i, "TAIEX"],
  [/\b(south korea|korea)\b/i, "KOSPI"],
  [/\bbrazil\b/i, "Bovespa"],
];

function countryIndex(text) {
  for (const [re, idx] of COUNTRY_INDEX) if (re.test(text)) return idx;
  return null;
}

const RULES = [
  {
    topic: /(crude|\boil\b|opec|strait of hormuz|refinery|pipeline|lng|natural gas)/i,
    up: /(attack|strike|sanction|blockade|disrupt|halt|explos|seiz|embargo|cuts? (output|production))/i,
    down: /(output (hike|increase)|boosts? (production|output)|production increase|raises? output|oversupply|demand slump)/i,
    note: (dir) =>
      dir === "up"
        ? { assets: "Crude (Brent/WTI), energy majors, XLE", direction: "up", note: "Supply-risk event — crude and energy equities tend to rise on disruption threats." }
        : { assets: "Crude (Brent/WTI), energy majors, XLE", direction: "down", note: "Supply-increase signal — more barrels tends to pressure crude prices and energy equities." },
  },
  {
    topic: /(semiconductor|chipmaker|chip (export|ban|curb)|tsmc|asml|foundry|gpu export)/i,
    up: null,
    down: /(ban|restrict|curb|control|tariff|blacklist|block)/i,
    note: () => ({ assets: "Semis: NVDA, TSMC, ASML, SOX index", direction: "down", note: "Export restrictions compress semiconductor revenue expectations." }),
  },
  {
    topic: /(missile|air ?strike|invasion|offensive|drone attack|escalat|shelling|artillery|declares? war)/i,
    up: /./,
    down: null,
    note: (_dir, text) => ({
      assets: `Defense (RTX, LMT, BAE${/\bindia\b/i.test(text) ? ", HAL" : ""}); broad indices risk-off`,
      direction: "mixed",
      note: "Escalation tends to lift defense names and pressure broad indices (risk-off).",
    }),
  },
  {
    topic: /(ceasefire|truce|peace (deal|agreement|accord))/i,
    up: /(sign|agree|reach|announc|holds|takes effect)/i,
    down: null,
    note: () => ({ assets: "Defense stocks; crude; broad indices", direction: "mixed", note: "De-escalation tends to soften defense names and crude while supporting risk assets." }),
  },
  {
    topic: /sanction/i,
    up: /(russia|iran|venezuela)/i,
    down: null,
    note: () => ({ assets: "Crude, sanctioned-country exporters", direction: "up", note: "Sanctions on a major exporter tend to tighten supply and lift crude." }),
  },
  {
    topic: /(federal reserve|\bfed\b|rate (cut|hike)|interest rates?|monetary policy|\brbi\b|\becb\b)/i,
    up: /(cut|lower|ease|dovish)/i,
    down: /(hike|raise|tighten|hawkish)/i,
    note: (dir, text) => ({
      assets: countryIndex(text) || "Rate-sensitive equities, bonds",
      direction: dir,
      note: dir === "up" ? "Easing signal — lower rates tend to support equities and bonds." : "Tightening signal — higher rates tend to pressure equities and lift yields.",
    }),
  },
  {
    topic: /(tariff|trade (war|deal|pact|agreement))/i,
    up: /(deal|pact|agreement|truce|suspend)/i,
    down: /(tariff|war|retaliat|impose)/i,
    note: (dir, text) => ({
      assets: countryIndex(text) || "Exporters and trade-exposed sectors",
      direction: dir,
      note: dir === "up" ? "Trade détente tends to support exporters and trade-exposed indices." : "New trade barriers tend to pressure exporters and trade-exposed indices.",
    }),
  },
  {
    topic: /(red sea|suez|shipping lane|houthi|container ship|strait of malacca)/i,
    up: /(attack|strike|disrupt|divert|seiz|target)/i,
    down: null,
    note: () => ({ assets: "Container freight rates; Maersk, Hapag-Lloyd", direction: "up", note: "Route disruption tends to lift freight rates and squeeze import-heavy retail margins." }),
  },
  {
    topic: /(election result|wins? election|coup|government (collapse|falls)|no-confidence|impeach|snap election)/i,
    up: /./,
    down: null,
    note: (_dir, text) => {
      const idx = countryIndex(text);
      return idx
        ? { assets: idx, direction: "mixed", note: "Political transition — expect index and currency volatility until policy direction is clear." }
        : null;
    },
  },
];

export function marketNote(text) {
  for (const rule of RULES) {
    if (!rule.topic.test(text)) continue;
    if (rule.up && rule.up.test(text)) {
      const n = rule.note("up", text);
      if (n) return n;
    }
    if (rule.down && rule.down.test(text)) {
      const n = rule.note("down", text);
      if (n) return n;
    }
  }
  return null;
}
