// Public Pulse — rule-based reader reaction for the World and India desks.
// item.pulse is an ARRAY of provider entries (source: "bluesky" | "youtube" |
// "mastodon"), one per provider that found a qualifying match; [] when none
// did. Bluesky is the primary source (search needs one authenticated session
// from an app password; thread reads are public), YouTube comments the second
// provider (YOUTUBE_API_KEY, self-serve), Mastodon an optional secondary
// signal for World only. Matching is rule-based word overlap (title-side, see
// titleOverlap) — no model, no embeddings — and sentiment is the AFINN-165
// lexicon via sentimentLexicon.mjs, shared by every provider. Every failure
// degrades to a missing entry; nothing here can fail the sweep.
import { PULSE_CONFIG as CFG } from "./pulseConfig.mjs";
import { toneScore } from "./sentimentLexicon.mjs";
import { titleTokens } from "./dedupe.mjs";
import { stripHtml } from "./util.mjs";

const FRAMING_NOTE = "approximation — reply tone vs. headline tone, not a stance classifier";
const THREAD_VIEW = "app.bsky.feed.defs#threadViewPost";

let loggedDisabled = false; // env-missing notice prints once per process, not per desk
let ytLoggedDisabled = false;

// A previous sweep may have stored the old single-object pulse shape; both
// shapes normalize to an entry array so stored-ID reuse survives the migration.
const prevEntries = (prev) => (Array.isArray(prev) ? prev : prev?.found ? [prev] : []);
const prevOf = (prev, source) => prevEntries(prev).find((e) => e.source === source);

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

/** Real reader voices, separated For / Against by reply tone sign (positive →
    for, negative → against) — the same lexicon as everything else, no model.
    An approximation by nature; the disclosure ships in the object and the UI.
    Neutral replies belong to neither side. Top-liked first, capped per side. */
export function buildVoices(replies) {
  const pick = (sign) =>
    replies
      .filter((r) => Math.sign(toneScore(r.text) ?? 0) === sign)
      .sort((a, b) => (b.likes ?? 0) - (a.likes ?? 0))
      .slice(0, CFG.voicesPerSide)
      .map((r) => ({ text: String(r.text).slice(0, 280), author: r.author ?? "", likes: r.likes ?? 0 }));
  return {
    for: pick(1),
    against: pick(-1),
    note: "real replies from the matched thread, grouped by reply tone — an approximation, not a stance classifier",
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
    .map((r) => ({
      text: r.post.record.text,
      author: r.post.author?.handle ?? "",
      likes: r.post.likeCount ?? 0,
    }));
}

// `replies` are { text, author, likes } objects; the aggregates read the
// texts, the voices keep the real messages.
function buildPulse(item, { source, post_uri, post_url, author_handle, post_text, like_count, repost_count, reply_count, quote_count }, replies) {
  const texts = replies.map((r) => r.text);
  const tone = aggregateTone(texts);
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
    framing_alignment: aggregateFraming(item.title, texts),
    voices: buildVoices(replies),
    controversial: isControversial(tone, like_count, quote_count),
    fetched_at: new Date().toISOString(),
  };
}

/** Public getPostThread → { post, replies } or null. Sets ctl.backoff on 429. */
async function fetchThread(uri, ctl) {
  const { status, data } = await getJson(
    `https://public.api.bsky.app/xrpc/app.bsky.feed.getPostThread?uri=${encodeURIComponent(uri)}&depth=1`
  );
  if (status === 429) { ctl.backoff = true; return null; }
  if (status !== 200 || data?.thread?.$type !== THREAD_VIEW) return null;
  if (hasAdultLabel(data.thread.post)) return null;
  return { post: data.thread.post, replies: threadReplies(data.thread) };
}

async function enrichItemBluesky(item, deskCfg, jwt, ctl, prev) {
  // Reuse: a stored URI from the previous sweep re-fetches this exact post
  // for fresh engagement numbers instead of re-searching.
  if (prev?.source === "bluesky" && prev.post_uri && !ctl.backoff) {
    const t = await fetchThread(prev.post_uri, ctl);
    if (t) {
      const p = t.post;
      item.pulse.push(buildPulse(item, {
        source: "bluesky", post_uri: p.uri, post_url: bskyPostUrl(p.uri, p.author?.handle ?? ""),
        author_handle: p.author?.handle, post_text: p.record?.text,
        like_count: p.likeCount, repost_count: p.repostCount,
        reply_count: p.replyCount, quote_count: p.quoteCount,
      }, t.replies));
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
  item.pulse.push(buildPulse(item, {
    source: "bluesky", post_uri: p.uri, post_url: bskyPostUrl(p.uri, p.author?.handle ?? ""),
    author_handle: p.author?.handle, post_text: p.record?.text,
    like_count: p.likeCount, repost_count: p.repostCount,
    reply_count: p.replyCount, quote_count: p.quoteCount,
  }, t.replies));
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
  let replies = [];
  const { status, data } = await getJson(`${CFG.mastodon.instance}/api/v1/statuses/${best.id}/context`);
  if (status === 429) ctl.backoff = true;
  else if (status === 200) {
    replies = (data?.descendants ?? [])
      .filter((d) => d.in_reply_to_id === best.id && d.content)
      .sort((a, b) => (b.favourites_count ?? 0) - (a.favourites_count ?? 0))
      .slice(0, CFG.replyCap)
      .map((d) => ({
        text: stripHtml(d.content),
        author: d.account?.acct ?? "",
        likes: d.favourites_count ?? 0,
      }));
  }
  item.pulse.push(buildPulse(item, {
    source: "mastodon", post_uri: best.uri, post_url: best.url,
    author_handle: best.acct, post_text: best.text,
    like_count: best.likes, repost_count: best.reblogs,
    reply_count: best.replies, quote_count: 0,
  }, replies));
  return true;
}

// ---------- YouTube (second provider, World + India) ----------

const YT = "https://www.googleapis.com/youtube/v3";
const YT_FRAMING_NOTE = "approximation — comment tone vs. headline tone, not a stance classifier";

const ytErrorReason = (data) => data?.error?.errors?.[0]?.reason;

/** Top-level comments for a video → array | "disabled" | null.
    commentsDisabled is a NORMAL outcome on news videos, not a failure. */
async function ytComments(key, videoId, ctl) {
  const { status, data } = await getJson(
    `${YT}/commentThreads?part=snippet&videoId=${videoId}&order=relevance&maxResults=${CFG.replyCap}&textFormat=plainText&key=${key}`
  );
  if (status === 403 && ytErrorReason(data) === "commentsDisabled") return "disabled";
  if (status === 403 && ytErrorReason(data) === "quotaExceeded") { ctl.ytQuota = true; return null; }
  if (status !== 200) return null;
  return (data.items ?? [])
    .map((t) => {
      const s = t.snippet?.topLevelComment?.snippet ?? {};
      return { text: s.textDisplay ?? "", author: s.authorDisplayName ?? "", likes: s.likeCount ?? 0 };
    })
    .filter((c) => c.text);
}

/** Stats + comments for one candidate → entry | "disabled" | null.
    Stats and comment reads are cheap main-pool units, not search budget. */
async function ytVideoEntry(item, key, video, ctl) {
  const { status, data } = await getJson(`${YT}/videos?part=statistics&id=${video.id}&key=${key}`);
  if (status !== 200) {
    if (ytErrorReason(data) === "quotaExceeded") ctl.ytQuota = true;
    return null;
  }
  const stats = data.items?.[0]?.statistics;
  if (!stats) return null; // video deleted/private since it was stored
  const comments = await ytComments(key, video.id, ctl);
  if (comments === "disabled") return "disabled";
  const replies = comments ?? []; // transient comment failure → entry keeps the native numbers
  const texts = replies.map((r) => r.text);
  const tone = aggregateTone(texts);
  const framing = aggregateFraming(item.title, texts);
  framing.note = YT_FRAMING_NOTE; // comments, not replies — the wording follows the source
  const likeCount = Number(stats.likeCount ?? 0);
  return {
    source: "youtube",
    found: true,
    video_id: video.id,
    video_url: `https://www.youtube.com/watch?v=${video.id}`,
    video_title: video.title,
    channel_title: video.channel,
    view_count: Number(stats.viewCount ?? 0),
    like_count: likeCount,
    comment_count: Number(stats.commentCount ?? 0),
    reaction_tone: tone,
    framing_alignment: framing,
    voices: buildVoices(replies),
    // the shared base rule only (split tone) — YouTube has no quote analog
    controversial: isControversial(tone, likeCount, 0),
    fetched_at: new Date().toISOString(),
  };
}

async function enrichItemYouTube(item, key, ctl, prev) {
  // Stored-ID reuse first — it spends ZERO search budget, the scarce resource.
  if (prev?.video_id) {
    const r = await ytVideoEntry(
      item, key,
      { id: prev.video_id, title: prev.video_title ?? "", channel: prev.channel_title ?? "" },
      ctl
    );
    if (r && r !== "disabled") { item.pulse.push(r); return "reused"; }
    // stored video gone or comments now off — do NOT burn a search on it;
    // fresher stories deserve the budget more than a re-match does
    return null;
  }
  if (ctl.ytQuota) return null;

  const q = buildQuery(item.title);
  if (!q) return null;
  const storyTime = item.publishedAt ? Date.parse(item.publishedAt) : Date.now();
  const win = CFG.youtube.windowDays * 86400000;
  const params = new URLSearchParams({
    part: "snippet",
    type: "video",
    q,
    maxResults: String(CFG.youtube.searchMaxResults),
    publishedAfter: new Date(storyTime - win).toISOString(),
    publishedBefore: new Date(storyTime + win).toISOString(),
    key,
  });
  const { status, data } = await getJson(`${YT}/search?${params}`);
  if (status === 403 && ytErrorReason(data) === "quotaExceeded") { ctl.ytQuota = true; return null; }
  if (status !== 200) return null;

  // Best similarity first (title + description vs. headline, same overlap
  // function as Bluesky, same 0.35 threshold); the next-best candidates are
  // fallbacks for comments-disabled videos.
  const tTokens = titleTokens(item.title);
  const candidates = (data.items ?? [])
    .map((v) => ({
      id: v.id?.videoId,
      title: v.snippet?.title ?? "",
      channel: v.snippet?.channelTitle ?? "",
      sim: titleOverlap(tTokens, titleTokens(`${v.snippet?.title ?? ""} ${v.snippet?.description ?? ""}`)),
    }))
    .filter((v) => v.id && v.sim >= CFG.similarityThreshold)
    .sort((a, b) => b.sim - a.sim)
    .slice(0, CFG.youtube.disabledCommentFallbacks);

  for (const cand of candidates) {
    if (ctl.ytQuota) return null;
    const r = await ytVideoEntry(item, key, cand, ctl);
    if (r === "disabled") continue; // normal on news videos — try the next qualifier
    if (r) { item.pulse.push(r); return "matched"; }
    return null;
  }
  return null;
}

/**
 * Reader-triggered pulse for ONE story (the per-story Opinion button):
 * fresh session, same search → match → thread → voices path as the sweep.
 * Bluesky only, deliberately — reader clicks are unbounded and must never
 * drain YouTube's scarce daily search bucket; YouTube entries arrive with the
 * scheduled sweeps. Returns the story's pulse entry array ([] when nothing
 * qualifies); throws only when the layer itself can't run (no env vars,
 * auth failure).
 */
export async function fetchPulseForItem(item, desk) {
  const deskCfg = CFG.desks[desk];
  if (!deskCfg) throw new Error(`not a pulse desk: ${desk}`);
  const handle = process.env.BLUESKY_HANDLE;
  const appPassword = process.env.BLUESKY_APP_PASSWORD;
  if (!handle || !appPassword) throw new Error("Bluesky credentials not configured");
  const jwt = await createSession(handle, appPassword);
  const ctl = { backoff: false };
  const prev = prevOf(item.pulse, "bluesky");
  item.pulse = prevEntries(item.pulse).filter((e) => e.source !== "bluesky");
  await enrichItemBluesky(item, deskCfg, jwt, ctl, prev);
  return item.pulse;
}

// ---------- orchestration ----------

/**
 * Enrich one desk's already-scored items with pulse data, in place. Only the
 * desks named in PULSE_CONFIG are touched — anything else passes through.
 * `prevPulse` maps item.id → the previous sweep's pulse for URI/ID reuse.
 * Never throws; item.pulse is always an array (possibly empty) on targets.
 */
export async function enrichWithPulse(items, desk, stats = [], prevPulse = new Map()) {
  const deskCfg = CFG.desks[desk];
  if (!deskCfg) return items;
  const ctl = { backoff: false, ytQuota: false };
  // Commentary and opinion sit outside the news flow — neither gets a pulse.
  const targets = items
    .filter((i) => i.kind !== "commentary" && i.contentType !== "opinion")
    .slice(0, CFG.perDeskCap);
  for (const t of targets) t.pulse = []; // providers push entries into this

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
        targets.map((item) =>
          enrichItemBluesky(item, deskCfg, jwt, ctl, prevOf(prevPulse.get(item.id), "bluesky")).catch(() => null)
        )
      );
      const matched = results.filter(Boolean).length;
      const reused = results.filter((r) => r === "reused").length;
      stats.push({ id: `pulse-bluesky-${desk}`, ok: true, items: matched, reused, ms: Date.now() - started });
    } catch (err) {
      // session failed → skip Bluesky enrichment for this run entirely
      stats.push({ id: `pulse-bluesky-${desk}`, ok: false, error: err.message, ms: Date.now() - started });
    }
  }

  // --- YouTube, the second provider ---
  // Its own smaller top-N: search.list draws from a scarce daily bucket
  // (~100/day), so only the head of the desk gets fresh searches; stored-ID
  // reuse costs no search budget at all.
  const ytKey = process.env.YOUTUBE_API_KEY;
  if (!ytKey) {
    if (!ytLoggedDisabled) {
      console.log("pulse: YOUTUBE_API_KEY not set — YouTube provider disabled");
      ytLoggedDisabled = true;
    }
  } else {
    const started = Date.now();
    const ytTargets = targets.slice(0, CFG.youtube.perDeskCap);
    const results = await Promise.all(
      ytTargets.map((item) =>
        enrichItemYouTube(item, ytKey, ctl, prevOf(prevPulse.get(item.id), "youtube")).catch(() => null)
      )
    );
    const matched = results.filter(Boolean).length;
    const reused = results.filter((r) => r === "reused").length;
    const stat = { id: `pulse-youtube-${desk}`, ok: true, items: matched, reused, ms: Date.now() - started };
    if (ctl.ytQuota) stat.error = "search quota exhausted — remaining searches skipped, matches kept";
    stats.push(stat);
  }

  // --- Mastodon, optional secondary signal (never for India) ---
  if (deskCfg.mastodon && process.env.MASTODON_ENABLED === "true") {
    const started = Date.now();
    try {
      const pool = await fetchMastodonPool(ctl);
      // still Bluesky's understudy: only stories Bluesky didn't match
      const unfound = targets.filter((i) => !i.pulse.some((e) => e.source === "bluesky"));
      const hits = await Promise.all(unfound.map((item) => enrichItemMastodon(item, pool, ctl).catch(() => false)));
      stats.push({
        id: `pulse-mastodon-${desk}`, ok: true, items: hits.filter(Boolean).length,
        pool: pool.length, ms: Date.now() - started,
      });
    } catch (err) {
      stats.push({ id: `pulse-mastodon-${desk}`, ok: false, error: err.message, ms: Date.now() - started });
    }
  }

  return items; // every target carries its entry array, [] when no provider matched
}
