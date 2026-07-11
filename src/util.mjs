const BROWSER_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36";

export async function fetchText(url, { timeoutMs = 8000, headers = {}, ua = BROWSER_UA } = {}) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      headers: { "User-Agent": ua, Accept: "*/*", "Accept-Language": "en-US,en;q=0.9", ...headers },
      signal: ctl.signal,
      redirect: "follow",
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.text();
  } finally {
    clearTimeout(timer);
  }
}

export async function fetchJson(url, opts) {
  return JSON.parse(await fetchText(url, opts));
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export function hostOf(url) {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return "";
  }
}

export function hashId(s) {
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) >>> 0;
  return h.toString(36);
}

export function toIso(d) {
  const t = new Date(d);
  return Number.isNaN(t.getTime()) ? null : t.toISOString();
}

const NAMED_ENTITIES = {
  amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ",
  ndash: "–", mdash: "—", hellip: "…", middot: "·",
  rsquo: "’", lsquo: "‘", rdquo: "”", ldquo: "“", trade: "™",
};

function decodeOnce(s) {
  return String(s)
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
    .replace(/&([a-z]+);/gi, (m, n) => NAMED_ENTITIES[n.toLowerCase()] ?? m);
}

// Feeds routinely double-encode (&amp;#8217;), so decode twice.
export function decodeEntities(s = "") {
  return decodeOnce(decodeOnce(s));
}

export function stripHtml(s = "") {
  return String(s).replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim();
}

// Feeds occasionally embed pictographs (🔴 etc.) in headlines; they read as
// noise on the desk. Keep ©®™, which share the Extended_Pictographic range.
export function stripEmoji(s = "") {
  return String(s).replace(/(?![©®™])\p{Extended_Pictographic}️?/gu, "").replace(/\s{2,}/g, " ").trim();
}

export function clip(s = "", max = 280) {
  if (s.length <= max) return s;
  return s.slice(0, max).replace(/\s+\S*$/, "") + "…";
}

export function cleanText(s, max = 280) {
  return clip(stripEmoji(decodeEntities(stripHtml(s))), max);
}

export function firstSentences(s, n = 2, max = 300) {
  const text = decodeEntities(stripHtml(s));
  const parts = text.match(/[^.!?]+[.!?]+(\s|$)/g);
  const joined = parts ? parts.slice(0, n).join(" ").trim() : text;
  return clip(joined, max);
}
