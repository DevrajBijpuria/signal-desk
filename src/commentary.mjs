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

async function fetchChannel(ch, stats) {
  const items = await fetchFeed(
    { id: `yt-${slug(ch.name)}`, name: ch.name, url: FEED_URL(ch.id), cap: 10 },
    stats
  );
  const cutoff = Date.now() - MAX_AGE_DAYS * 86400000;
  return items
    .filter((v) => v.publishedAt && new Date(v.publishedAt).getTime() >= cutoff)
    .slice(0, PER_CHANNEL)
    .map((v) => ({ id: v.id, title: v.title, url: v.url, channel: ch.name, publishedAt: v.publishedAt }));
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
      (it) => it.kind !== "commentary" && it.contentType !== "opinion" && similarTitles(titleTokens(it.title), vTokens)
    );
    if (match) {
      (match.commentary ??= []).push({
        channel: v.channel, title: v.title, url: v.url, publishedAt: v.publishedAt,
      });
    } else {
      items.push({
        id: v.id,
        title: v.title,
        url: v.url,
        summary: "",
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
