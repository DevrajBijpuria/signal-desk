import { XMLParser } from "fast-xml-parser";
import { fetchText, hostOf, hashId, toIso, cleanText, decodeEntities, stripEmoji } from "./util.mjs";
import { detectOpinion } from "./opinion.mjs";

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: "@_",
  textNodeName: "#text",
});

const asArray = (x) => (x == null ? [] : Array.isArray(x) ? x : [x]);
const textOf = (v) => (v == null ? "" : typeof v === "object" ? String(v["#text"] ?? "") : String(v));

function atomLink(entry) {
  const links = asArray(entry.link);
  const alt = links.find((l) => l["@_rel"] === "alternate" || !l["@_rel"]);
  return alt ? alt["@_href"] : textOf(entry.link);
}

// Parses RSS 2.0 and Atom into a common raw shape.
export function parseFeed(xml) {
  const doc = parser.parse(xml);
  const out = [];
  if (doc.rss?.channel) {
    for (const item of asArray(doc.rss.channel.item)) {
      const src = item.source;
      out.push({
        title: stripEmoji(decodeEntities(textOf(item.title))),
        link: textOf(item.link).trim(),
        summary: cleanText(textOf(item.description ?? item["content:encoded"] ?? "")),
        publishedAt: toIso(textOf(item.pubDate ?? item["dc:date"] ?? "")),
        sourceName: src ? decodeEntities(textOf(src)).trim() : null,
        sourceUrl: src?.["@_url"] ?? null,
        categories: asArray(item.category).map((c) => decodeEntities(textOf(c)).trim()).filter(Boolean),
      });
    }
  } else if (doc.feed) {
    for (const entry of asArray(doc.feed.entry)) {
      out.push({
        title: stripEmoji(decodeEntities(textOf(entry.title)).replace(/\s+/g, " ")),
        link: atomLink(entry),
        summary: cleanText(textOf(entry.summary ?? entry.content ?? "")),
        publishedAt: toIso(textOf(entry.published ?? entry.updated ?? "")),
        sourceName: null,
        sourceUrl: null,
        authors: asArray(entry.author).map((a) => textOf(a?.name)).filter(Boolean),
        categories: asArray(entry.category).map((c) => textOf(c?.["@_term"] ?? c).trim()).filter(Boolean),
      });
    }
  }
  return out.filter((e) => e.title && e.link);
}

/**
 * Fetch one configured feed into standard items.
 * def: { id, name, url, cap, gnews } — gnews feeds carry the real outlet in
 * <source> and append " - Outlet" to titles, which we strip.
 */
export async function fetchFeed(def, stats) {
  const started = Date.now();
  try {
    const xml = await fetchText(def.url, { timeoutMs: def.timeoutMs ?? 8000 });
    const parsed = parseFeed(xml);
    const cap = def.cap ?? 12;
    // Opinion pieces sit deep in section feeds (below the news of the hour),
    // so a plain head-slice almost never carries one — keep a few flagged
    // entries from beyond the cap; news volume itself stays capped as before.
    const entries = [
      ...parsed.slice(0, cap),
      ...parsed.slice(cap)
        .filter((e) => detectOpinion({ url: e.link, title: e.title, summary: e.summary, categories: e.categories }))
        .slice(0, 3),
    ];
    const items = entries.map((e) => {
      let title = e.title;
      let sourceName = def.name;
      let domain = hostOf(e.link);
      if (def.gnews) {
        title = title.replace(/\s+-\s+[^-]{2,60}$/, "");
        sourceName = e.sourceName || def.name;
        domain = e.sourceUrl ? hostOf(e.sourceUrl) : domain;
      }
      const item = {
        id: hashId(e.link),
        title,
        url: e.link,
        summary: e.summary,
        publishedAt: e.publishedAt,
        sources: [{ name: sourceName, domain, url: e.link }],
      };
      // Opinion/editorial pieces are flagged at the source, while the feed's
      // <category> tags are still in hand — the tags don't travel further.
      if (detectOpinion({ url: e.link, title, summary: e.summary, categories: e.categories })) {
        item.contentType = "opinion";
      }
      return item;
    });
    stats.push({ id: def.id, ok: true, items: items.length, ms: Date.now() - started });
    return items;
  } catch (err) {
    stats.push({ id: def.id, ok: false, error: err.message, ms: Date.now() - started });
    return [];
  }
}
