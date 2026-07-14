// YouTube commentary layer. Channel RSS is fetched exactly like the other
// feeds (no API key). Everything here is "commentary" — a category apart from
// the four trust tiers: it never gets a legitimacy rating, never merges into a
// story's source list, and never counts toward corroboration. Where a video
// topically matches a news item it rides along on that story
// (item.commentary = [...]); otherwise it runs as its own entry with
// kind: "commentary" and no trust field.
import { fetchFeed } from "./feeds.mjs";
import { titleTokens, similarTitles } from "./dedupe.mjs";
import { COMMENTARY_CHANNELS } from "./commentary-channels.mjs";

const FEED_URL = (id) => `https://www.youtube.com/feeds/videos.xml?channel_id=${id}`;
const MAX_AGE_DAYS = 7; // commentary goes stale fast; older uploads don't print
const PER_CHANNEL = 3;

const slug = (name) => name.toLowerCase().replace(/[^a-z0-9]+/g, "-");
const DESC_MAX = 280;

// sponsor / patreon / call-to-action lines that are noise, not a synopsis
const PROMO =
  /(check out|sign ?up for|use code|promo code|% off|link in (the )?(bio|description)|our sponsor|sponsored by|thanks? to our|our generous|patreon|subscribe to|join our|follow (me|us) on|want to support|the best way is|join as a member|become a member|watch,? like)/i;

/* A YouTube description is a raw block: often a sponsor line, then the real
   synopsis, then hashtags and channel links. Pick the one genuine prose
   paragraph (skipping promo lines) and trim it to a deck-length excerpt. If the
   feed carries no real synopsis — only ads/links — return "" so the feed shows
   the title alone rather than an advertisement. */
function cleanDescription(raw, max = DESC_MAX) {
  const blocks = String(raw ?? "").split(/\n+/).map((b) => b.trim()).filter(Boolean).slice(0, 8);
  const noUrls = (b) => b.replace(/https?:\/\/\S+/g, "").trim();
  // A real synopsis is a SENTENCE: it has terminal punctuation and reads like
  // prose. That single test rejects the contact lines, Patreon credit rolls,
  // social/CTA fragments (which end in a colon or are comma-lists) that
  // keyword lists alone keep missing; PROMO + no-email guard the rest.
  const prose = blocks.filter((b) => {
    const t = noUrls(b);
    return t.length >= 40 && /[a-z]/.test(t) && t.split(/\s+/).length >= 6
      && /[.!?](\s|$)/.test(t) && !/\S+@\S+/.test(t)
      && !t.startsWith("#") && !PROMO.test(t);
  });
  if (!prose.length) return "";
  const rank = (b) => noUrls(b).length; // among real sentences, the fuller synopsis
  let pick = prose.sort((a, b) => rank(b) - rank(a))[0];
  pick = pick.replace(/https?:\/\/\S+/g, "").replace(/#\w+/g, "").replace(/\s+/g, " ").trim();
  if (pick.length > max) {
    const cut = pick.slice(0, max);
    const stop = Math.max(cut.lastIndexOf(". "), cut.lastIndexOf("! "), cut.lastIndexOf("? "));
    pick = stop > 140 ? cut.slice(0, stop + 1).trim() : cut.replace(/\s+\S*$/, "").trim() + "…";
  }
  return pick;
}

async function fetchChannel(ch, stats) {
  const items = await fetchFeed(
    { id: `yt-${slug(ch.name)}`, name: ch.name, url: FEED_URL(ch.id), cap: 10 },
    stats
  );
  const cutoff = Date.now() - MAX_AGE_DAYS * 86400000;
  return items
    .filter((v) => v.publishedAt && new Date(v.publishedAt).getTime() >= cutoff)
    .slice(0, PER_CHANNEL)
    .map((v) => ({
      id: v.id,
      title: v.title,
      url: v.url,
      channel: ch.name,
      description: cleanDescription(v.mediaDescription),
      publishedAt: v.publishedAt,
    }));
}

/** All channel groups in parallel → { tech, geopolitics, india, esportsGlobal, esportsIndia }. */
export async function fetchCommentary(stats) {
  const out = {};
  await Promise.all(
    Object.entries(COMMENTARY_CHANNELS).map(async ([section, channels]) => {
      const results = await Promise.all(channels.map((ch) => fetchChannel(ch, stats)));
      out[section] = results
        .flat()
        .sort((a, b) => (b.publishedAt ?? "").localeCompare(a.publishedAt ?? ""));
    })
  );
  return out;
}

/**
 * Attach videos to a finished (deduped + scored) section. Runs after scoring
 * on purpose: commentary can never enter dedupe/corroboration. Mutates and
 * returns `items`. `extra` adds fields to standalone entries (esports scope).
 */
export function attachCommentary(items, videos, extra = {}) {
  for (const v of videos) {
    const vTokens = titleTokens(v.title);
    const match = items.find(
      (it) => it.kind !== "commentary" && similarTitles(titleTokens(it.title), vTokens)
    );
    if (match) {
      (match.commentary ??= []).push({
        channel: v.channel, title: v.title, url: v.url,
        description: v.description ?? "", publishedAt: v.publishedAt,
      });
    } else {
      items.push({
        id: v.id,
        title: v.title,
        url: v.url,
        summary: v.description ?? "", // the video's own description → renders as the deck
        publishedAt: v.publishedAt,
        kind: "commentary",
        tags: ["Commentary"],
        sources: [{ name: v.channel, domain: "youtube.com", url: v.url }],
        ...extra,
      });
    }
  }
  return items;
}
