// Public Pulse — rule-based reader reaction for the World and India desks.
// Bluesky is the primary source (search needs one authenticated session from
// an app password; thread reads are public), Mastodon an optional secondary
// signal for World only. Matching is rule-based word overlap (title-side, see
// titleOverlap) — no model, no embeddings — and sentiment is the AFINN-165 lexicon via
// sentimentLexicon.mjs. Every failure degrades to pulse: { found: false };
// nothing here can fail the sweep.
import { PULSE_CONFIG as CFG } from "./pulseConfig.mjs";
import { toneScore } from "./sentimentLexicon.mjs";
import { titleTokens } from "./dedupe.mjs";
import { stripHtml } from "./util.mjs";

const FRAMING_NOTE = "approximation — reply tone vs. headline tone, not a stance classifier";
const THREAD_VIEW = "app.bsky.feed.defs#threadViewPost";

let loggedDisabled = false; // env-missing notice prints once per process, not per desk

// ---------- small fetch helper: status-aware, per-call timeout ----------

async function getJson(url, { method = "GET", headers = {}, body } = {}) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), CFG.fetchTimeoutMs);
  try {
    const res = await fetch(url, { method, headers, body, signal: ctl.signal });
    const data = await res.json().catch(() => null);
    return { status: res.status, data };
  } finally {
    clearTimeout(timer);
  }
}

// ---------- query building & matching (pure, exported for tests) ----------

const STOPWORDS = new Set([
  "the", "a", "an", "to", "of", "in", "on", "for", "and", "as", "at", "with",
  "after", "over", "amid", "by", "is", "are", "was", "were", "says", "say",
  "said", "from", "its", "his", "her", "their", "new", "how", "why", "what",
  "will", "has", "have", "had", "be", "been", "not", "but", "this", "that",
  "into", "out", "up", "down", "about", "against", "between", "during",
]);

/** Top keyword tokens from a headline: skip stopwords, favor proper nouns and
    longer words, keep original order, cap count and length. */
export function buildQuery(title) {
  // apostrophes/hyphens only join word-internal ("Ukraine's", "cease-fire");
  // a leading or trailing quote never rides along into the query
  const raw = String(title ?? "").match(/[\p{L}\p{N}]+(?:[''’'-][\p{L}\p{N}]+)*/gu) ?? [];
  const seen = new Set();
  const cands = [];
  raw.forEach((word, i) => {
    const w = word.replace(/[''’']s?$/u, ""); // possessives narrow an AND search ("Ukraine's" ≠ "Ukraine")
    const lw = w.toLowerCase();
    if (w.length < 3 || STOPWORDS.has(lw) || seen.has(lw)) return;
    seen.add(lw);
    // Sentence-case makes a capitalized first word ambiguous, but headlines
    // lead with their key entity often enough that dropping it costs more
    // ("Ukraine's Zelensky…" losing Ukraine) than an occasional "Badly" keeps.
    cands.push({ w, i, proper: /^\p{Lu}/u.test(w) ? 1 : 0 });
  });
  cands.sort((a, b) => b.proper - a.proper || b.w.length - a.w.length || a.i - b.i);
  return cands
    .slice(0, CFG.maxQueryTokens)
    .sort((a, b) => a.i - b.i)
    .map((c) => c.w)
    .join(" ")
    .slice(0, CFG.maxQueryChars);
}

/** Title-side word overlap: the fraction of the headline's meaningful tokens
    that appear in the post text, gated on a minimum shared-token count.
    Plain Jaccard (inter/union) was tried first and, live, matched ONLY
    verbatim headline-mirror bots — real engaged posts paraphrase and add
    text, which inflates the union and collapses the score below any usable
    threshold. Same rule-based overlap idea, measured against the title. */
export function titleOverlap(tTokens, pTokens) {
  if (!tTokens.size || !pTokens.size) return 0;
  let inter = 0;
  for (const t of tTokens) if (pTokens.has(t)) inter++;
  if (inter < Math.min(CFG.minSharedTokens, tTokens.size)) return 0;
  return inter / tTokens.size;
}

function hasAdultLabel(post) {
  const flagged = (labels) => (labels ?? []).some((l) => CFG.adultLabels.includes(l.val));
  return flagged(post.labels) || flagged(post.author?.labels);
}

const postEngagement = (p) =>
  (p.likeCount ?? 0) + (p.repostCount ?? 0) + (p.replyCount ?? 0) + (p.quoteCount ?? 0);

/** Best search candidate for a story: language + recency + no adult label
    gates, similarity threshold to qualify — then the MOST ENGAGED qualifier
    wins, not the most similar (headline-mirror bots repost titles verbatim
    and would sweep every match on pure similarity), with a minimum-engagement
    floor so a zero-reaction post never counts as reader reaction. */
export function pickCandidate(item, posts, deskCfg, now = Date.now()) {
  const tTokens = titleTokens(item.title);
  const storyTime = item.publishedAt ? Date.parse(item.publishedAt) : now;
  const windowMs = CFG.recencyWindowDays * 86400000;
  let best = null;
  let bestEng = -1;
  for (const p of posts) {
    const rec = p.record ?? {};
    if (hasAdultLabel(p)) continue;
    if (rec.langs?.length && !rec.langs.some((l) => deskCfg.langs.includes(String(l).slice(0, 2)))) continue;
    const created = Date.parse(rec.createdAt ?? p.indexedAt ?? "");
    if (!Number.isFinite(created) || Math.abs(created - storyTime) > windowMs) continue;
    if (titleOverlap(tTokens, titleTokens(rec.text ?? "")) < CFG.similarityThreshold) continue;
    const eng = postEngagement(p);
    if (eng > bestEng) { bestEng = eng; best = p; }
  }
  return bestEng >= CFG.candidateMinEngagement ? best : null;
}

// ---------- sentiment aggregation (pure, exported for tests) ----------

/** Reaction Tone: plain lexicon sentiment across the reply sample. */
export function aggregateTone(texts) {
  const scores = texts.map(toneScore).filter((s) => s !== null);
  const n = scores.length;
  const pos = scores.filter((s) => s > 0).length;
  const neg = scores.filter((s) => s < 0).length;
  const pct = (c) => (n ? Math.round((100 * c) / n) : 0);
  return { positive_pct: pct(pos), negative_pct: pct(neg), neutral_pct: pct(n - pos - neg), sample_size: n };
}

/** Framing Alignment: reply tone sign vs. headline tone sign — an
    approximation, always shipped with its disclosure note. */
export function aggregateFraming(headline, texts) {
  const h = toneScore(headline) ?? 0;
  const scores = texts.map(toneScore).filter((s) => s !== null);
  const n = scores.length;
  let aligned = 0;
  let pushback = 0;
  if (h !== 0) {
    for (const s of scores) {
      if (s === 0) continue;
      if (Math.sign(s) === Math.sign(h)) aligned++;
      else pushback++;
    }
  }
  const pct = (c) => (n ? Math.round((100 * c) / n) : 0);
  return {
    aligned_pct: pct(aligned),
    pushback_pct: pct(pushback),
    neutral_pct: pct(n - aligned - pushback),
    sample_size: n,
    note: FRAMING_NOTE,
  };
}

/** Contested content: split tone, or quote-heavy engagement (Bluesky's quote
    culture skews commentary/pushback over plain approval). */
export function isControversial(tone, likeCount, quoteCount) {
  const split = tone.positive_pct > CFG.controversialSplitPct && tone.negative_pct > CFG.controversialSplitPct;
  const quoteHeavy =
    (quoteCount ?? 0) >= CFG.minQuotesForControversy &&
    quoteCount / Math.max(1, likeCount ?? 0) > CFG.quoteToLikeRatio;
  return split || quoteHeavy;
}

// ---------- Bluesky ----------

async function createSession(handle, appPassword) {
  const { status, data } = await getJson("https://bsky.social/xrpc/com.atproto.server.createSession", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ identifier: handle, password: appPassword }),
  });
  if (status !== 200 || !data?.accessJwt) throw new Error(`createSession HTTP ${status}`);
  return data.accessJwt;
}

function bskyPostUrl(uri, handle) {
  return `https://bsky.app/profile/${handle}/post/${uri.split("/").pop()}`;
}

function threadReplies(thread) {
  return (thread.replies ?? [])
    .filter((r) => r.$type === THREAD_VIEW && r.post?.record?.text)
    .sort((a, b) => (b.post.likeCount ?? 0) - (a.post.likeCount ?? 0))
    .slice(0, CFG.replyCap)
    .map((r) => r.post.record.text);
}

function buildPulse(item, { source, post_uri, post_url, author_handle, post_text, like_count, repost_count, reply_count, quote_count }, replyTexts) {
  const tone = aggregateTone(replyTexts);
  return {
    found: true,
    source,
    post_uri,
    post_url,
    author_handle,
    post_text: String(post_text ?? "").slice(0, 300),
    like_count: like_count ?? 0,
    repost_count: repost_count ?? 0,
    reply_count: reply_count ?? 0,
    quote_count: quote_count ?? 0,
    reaction_tone: tone,
    framing_alignment: aggregateFraming(item.title, replyTexts),
    controversial: isControversial(tone, like_count, quote_count),
    fetched_at: new Date().toISOString(),
  };
}

/** Public getPostThread → { post, replyTexts } or null. Sets ctl.backoff on 429. */
async function fetchThread(uri, ctl) {
  const { status, data } = await getJson(
    `https://public.api.bsky.app/xrpc/app.bsky.feed.getPostThread?uri=${encodeURIComponent(uri)}&depth=1`
  );
  if (status === 429) { ctl.backoff = true; return null; }
  if (status !== 200 || data?.thread?.$type !== THREAD_VIEW) return null;
  if (hasAdultLabel(data.thread.post)) return null;
  return { post: data.thread.post, replyTexts: threadReplies(data.thread) };
}

async function enrichItemBluesky(item, deskCfg, jwt, ctl, prev) {
  // Reuse: a stored URI from the previous sweep re-fetches this exact post
  // for fresh engagement numbers instead of re-searching.
  if (prev?.source === "bluesky" && prev.post_uri && !ctl.backoff) {
    const t = await fetchThread(prev.post_uri, ctl);
    if (t) {
      const p = t.post;
      item.pulse = buildPulse(item, {
        source: "bluesky", post_uri: p.uri, post_url: bskyPostUrl(p.uri, p.author?.handle ?? ""),
        author_handle: p.author?.handle, post_text: p.record?.text,
        like_count: p.likeCount, repost_count: p.repostCount,
        reply_count: p.replyCount, quote_count: p.quoteCount,
      }, t.replyTexts);
      return "reused";
    }
    // stored post gone (deleted, blocked) — fall through to a fresh search
  }
  if (ctl.backoff) return null;

  const q = buildQuery(item.title);
  if (!q) return null;
  const params = new URLSearchParams({ q, sort: "top", limit: String(CFG.searchLimit) });
  // Two languages can't ride one search param (India: en+hi), so multi-lang
  // desks search unfiltered and rely on the client-side langs check instead.
  if (deskCfg.langs.length === 1) params.set("lang", deskCfg.langs[0]);
  const { status, data } = await getJson(`https://bsky.social/xrpc/app.bsky.feed.searchPosts?${params}`, {
    headers: { Authorization: `Bearer ${jwt}` },
  });
  if (status === 429) { ctl.backoff = true; return null; }
  if (status !== 200) return null;

  const best = pickCandidate(item, data?.posts ?? [], deskCfg);
  if (!best || ctl.backoff) return null;

  const t = await fetchThread(best.uri, ctl);
  if (!t) return null;
  const p = t.post;
  item.pulse = buildPulse(item, {
    source: "bluesky", post_uri: p.uri, post_url: bskyPostUrl(p.uri, p.author?.handle ?? ""),
    author_handle: p.author?.handle, post_text: p.record?.text,
    like_count: p.likeCount, repost_count: p.repostCount,
    reply_count: p.replyCount, quote_count: p.quoteCount,
  }, t.replyTexts);
  return "matched";
}

// ---------- Mastodon (optional secondary signal, World only) ----------

async function fetchMastodonPool(ctl) {
  const pools = await Promise.all(
    CFG.mastodon.hashtags.map(async (tag) => {
      if (ctl.backoff) return [];
      const { status, data } = await getJson(
        `${CFG.mastodon.instance}/api/v1/timelines/tag/${encodeURIComponent(tag)}?limit=${CFG.mastodon.perTagLimit}`
      );
      if (status === 429) { ctl.backoff = true; return []; }
      if (status !== 200 || !Array.isArray(data)) return [];
      return data;
    })
  );
  const seen = new Set();
  return pools.flat().filter((s) => {
    if (s.sensitive || seen.has(s.id)) return false; // sensitive = the over_18 analog
    seen.add(s.id);
    return true;
  }).map((s) => ({
    id: s.id,
    uri: s.uri,
    url: s.url,
    acct: s.account?.acct,
    text: stripHtml(s.content ?? ""),
    createdAt: s.created_at,
    likes: s.favourites_count ?? 0,
    reblogs: s.reblogs_count ?? 0,
    replies: s.replies_count ?? 0,
  }));
}

function pickMastodonCandidate(item, pool, now = Date.now()) {
  const tTokens = titleTokens(item.title);
  const storyTime = item.publishedAt ? Date.parse(item.publishedAt) : now;
  const windowMs = CFG.recencyWindowDays * 86400000;
  let best = null;
  let bestEng = -1;
  for (const s of pool) {
    const created = Date.parse(s.createdAt ?? "");
    if (!Number.isFinite(created) || Math.abs(created - storyTime) > windowMs) continue;
    if (titleOverlap(tTokens, titleTokens(s.text)) < CFG.similarityThreshold) continue;
    const eng = s.likes + s.reblogs + s.replies;
    if (eng > bestEng) { bestEng = eng; best = s; }
  }
  return bestEng >= CFG.candidateMinEngagement ? best : null;
}

async function enrichItemMastodon(item, pool, ctl) {
  const best = pickMastodonCandidate(item, pool);
  if (!best || ctl.backoff) return false;
  let replyTexts = [];
  const { status, data } = await getJson(`${CFG.mastodon.instance}/api/v1/statuses/${best.id}/context`);
  if (status === 429) ctl.backoff = true;
  else if (status === 200) {
    replyTexts = (data?.descendants ?? [])
      .filter((d) => d.in_reply_to_id === best.id && d.content)
      .sort((a, b) => (b.favourites_count ?? 0) - (a.favourites_count ?? 0))
      .slice(0, CFG.replyCap)
      .map((d) => stripHtml(d.content));
  }
  item.pulse = buildPulse(item, {
    source: "mastodon", post_uri: best.uri, post_url: best.url,
    author_handle: best.acct, post_text: best.text,
    like_count: best.likes, repost_count: best.reblogs,
    reply_count: best.replies, quote_count: 0,
  }, replyTexts);
  return true;
}

// ---------- orchestration ----------

/**
 * Enrich one desk's already-scored items with pulse data, in place. Only the
 * desks named in PULSE_CONFIG are touched — anything else passes through.
 * `prevPulse` maps item.id → the previous sweep's pulse for URI reuse.
 * Never throws; every failure path ends at pulse: { found: false }.
 */
export async function enrichWithPulse(items, desk, stats = [], prevPulse = new Map()) {
  const deskCfg = CFG.desks[desk];
  if (!deskCfg) return items;
  const ctl = { backoff: false };
  // Commentary and opinion sit outside the news flow — neither gets a pulse.
  const targets = items
    .filter((i) => i.kind !== "commentary" && i.contentType !== "opinion")
    .slice(0, CFG.perDeskCap);

  // --- Bluesky, the primary source ---
  const handle = process.env.BLUESKY_HANDLE;
  const appPassword = process.env.BLUESKY_APP_PASSWORD;
  if (!handle || !appPassword) {
    if (!loggedDisabled) {
      console.log("pulse: BLUESKY_HANDLE / BLUESKY_APP_PASSWORD not set — Bluesky enrichment disabled");
      loggedDisabled = true;
    }
  } else {
    const started = Date.now();
    try {
      const jwt = await createSession(handle, appPassword);
      const results = await Promise.all(
        targets.map((item) => enrichItemBluesky(item, deskCfg, jwt, ctl, prevPulse.get(item.id)).catch(() => null))
      );
      const matched = results.filter(Boolean).length;
      const reused = results.filter((r) => r === "reused").length;
      stats.push({ id: `pulse-bluesky-${desk}`, ok: true, items: matched, reused, ms: Date.now() - started });
    } catch (err) {
      // session failed → skip Bluesky enrichment for this run entirely
      stats.push({ id: `pulse-bluesky-${desk}`, ok: false, error: err.message, ms: Date.now() - started });
    }
  }

  // --- Mastodon, optional secondary signal (never for India) ---
  if (deskCfg.mastodon && process.env.MASTODON_ENABLED === "true") {
    const started = Date.now();
    try {
      const pool = await fetchMastodonPool(ctl);
      const unfound = targets.filter((i) => !i.pulse?.found);
      const hits = await Promise.all(unfound.map((item) => enrichItemMastodon(item, pool, ctl).catch(() => false)));
      stats.push({
        id: `pulse-mastodon-${desk}`, ok: true, items: hits.filter(Boolean).length,
        pool: pool.length, ms: Date.now() - started,
      });
    } catch (err) {
      stats.push({ id: `pulse-mastodon-${desk}`, ok: false, error: err.message, ms: Date.now() - started });
    }
  }

  for (const t of targets) if (!t.pulse) t.pulse = { found: false };
  return items;
}
