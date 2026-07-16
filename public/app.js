/* Signal Desk — the broadsheet edition. Reads the stored sweep and sets it
   like a front page: importance decides footprint (lead well, secondary row,
   ruled columns, briefs rail), every story hand-stamped. No feed fetches
   here — /api/news is a blob read; /data/seed.json is the fallback edition. */

import * as THREE from "/vendor/three.module.min.js";
import { domToCanvas } from "/vendor/modern-screenshot.mjs";

const state = {
  data: null,
  fromSeed: false,
  tab: "tech",
  esportsScope: "global",
  // reader-triggered Tavily search: daily pool, counted server-side
  wire: { enabled: false, remaining: 0, busy: false },
};

const SECTION_META = {
  tech: {
    banner: "TECH & AI",
    desk: "The lead desk: launches, research, funding, and the tooling underneath.",
  },
  geopolitics: {
    banner: "WORLD",
    desk: "What moved since the last press run, and what it may move in the markets.",
  },
  india: {
    banner: "INDIA",
    desk: "The national wire and the states, government releases included.",
  },
  esports: {
    banner: "ESPORTS",
    desk: "Results, rosters, and the rumor mill — rumors run stamped, never as settled fact.",
  },
};

const board = document.getElementById("board");
const folioNo = document.getElementById("folio-no");
const folioDate = document.getElementById("folio-date");
const folioPress = document.getElementById("folio-press");
const staleBanner = document.getElementById("stale-banner");
const refreshBtn = document.getElementById("refresh");
const scopeBar = document.getElementById("esports-scope");
const sectionBanner = document.getElementById("section-banner");
const deskLine = document.getElementById("desk-line");
const mastheadEl = document.querySelector(".masthead-banner");
const sectionEl = document.querySelector(".section");
const STALE_AFTER_MS = 8 * 60 * 60 * 1000;
const REDUCED_MOTION = window.matchMedia("(prefers-reduced-motion: reduce)");

const esc = (s) =>
  String(s ?? "").replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

// Feeds occasionally embed pictographs in headlines; a broadsheet prints none.
const deEmoji = (s) =>
  String(s ?? "").replace(/(?![©®™])\p{Extended_Pictographic}️?/gu, "").replace(/\s{2,}/g, " ").trim();

// Feed URLs come from 30+ third parties — only http(s) gets a live link.
const safeUrl = (u) => (/^https?:/i.test(String(u ?? "")) ? u : "#");

const norm = (s) => String(s ?? "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();

// Some feeds ship the headline again as the description; a paper never sets
// the same sentence as both headline and deck.
function deckFor(item) {
  const summary = deEmoji(item.summary ?? "");
  if (!summary) return "";
  const ns = norm(summary), nt = norm(deEmoji(item.title));
  if (nt && (ns === nt || ns.startsWith(nt))) return "";
  return summary;
}

function relTime(iso) {
  if (!iso) return "";
  const mins = Math.round((Date.now() - new Date(iso).getTime()) / 60000);
  if (!Number.isFinite(mins)) return "";
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.round(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  return `${Math.round(hrs / 24)}d ago`;
}

function localStamp(iso) {
  const d = new Date(iso);
  const tz = new Intl.DateTimeFormat(undefined, { timeZoneName: "short" })
    .formatToParts(d).find((p) => p.type === "timeZoneName")?.value ?? "";
  return `${d.toLocaleString(undefined, { hour: "2-digit", minute: "2-digit", day: "2-digit", month: "short" })} ${tz}`;
}

/* ---------- importance: existing signals decide the footprint ----------
   No new scoring model — legitimacy tier, corroboration count, market
   relevance, EWC/live status, recency, and whether the wire sent real copy. */
function importance(item) {
  let s = { high: 5, medium: 2.5, low: 0.5 }[item.trust?.level] ?? 0;
  s += Math.min((item.sources?.length ?? 1) - 1, 3) * 2;   // independent corroboration
  if (item.market) s += 1.5;                                // market-moving
  const tags = item.tags ?? [];
  if (tags.includes("EWC")) s += 1;                         // the marquee event
  if (item.status === "Ongoing") s += 2;                    // live > finished > fixtures
  else if (item.status === "Completed") s += 1;
  if (item.publishedAt) {
    const hrs = (Date.now() - new Date(item.publishedAt).getTime()) / 3.6e6;
    if (Number.isFinite(hrs)) s += Math.max(0, 3 - hrs / 8); // fresh within ~24h
  }
  if ((item.summary ?? "").length >= 80) s += 1;            // the wire sent real copy
  if (item.rumor) s -= 1;                                   // rumors never lead
  // Public Pulse: a small, capped nudge for genuinely discussed stories —
  // legitimacy stays dominant (high trust alone is worth 5), so a Low item
  // can never outrank a Verified one just for being talked about.
  const discussed = pulseEntries(item).some((p) => {
    const engaged = p.source === "youtube"
      ? (p.like_count ?? 0) + (p.comment_count ?? 0)
      : (p.like_count ?? 0) + (p.reply_count ?? 0);
    return engaged >= 50 || p.controversial;
  });
  if (discussed) s += 1;
  return s;
}

/* pulse is an array of provider entries; older stored sweeps carried a single
   object — normalize so both render. */
function pulseEntries(item) {
  const p = item.pulse;
  if (Array.isArray(p)) return p.filter((e) => e && e.found !== false);
  return p?.found ? [p] : [];
}

/* ---------- data loading ---------- */

async function fetchData() {
  try {
    const res = await fetch("/api/news", { cache: "no-cache" });
    if (res.ok) return { data: await res.json(), fromSeed: false };
  } catch { /* fall through to the deploy-time edition */ }
  const seed = await fetch("/data/seed.json", { cache: "no-cache" });
  if (!seed.ok) throw new Error("no stored sweep and no seed");
  return { data: await seed.json(), fromSeed: true };
}

async function load({ sweep = false } = {}) {
  refreshBtn.disabled = true;
  if (sweep) board.classList.add("refreshing");
  const minSweep = sweep ? new Promise((r) => setTimeout(r, 700)) : Promise.resolve();
  try {
    const [result] = await Promise.all([fetchData(), minSweep]);
    state.data = result.data;
    state.fromSeed = result.fromSeed;
    renderMasthead();
    renderBoard();
  } catch {
    renderMasthead();
    renderErrorState();
  } finally {
    board.classList.remove("refreshing");
    refreshBtn.disabled = false;
  }
}

/* ---------- dateline / stale edition ---------- */

function dayOfYear(d) {
  return Math.floor((d - new Date(d.getFullYear(), 0, 0)) / 86400000);
}

function renderMasthead() {
  const now = new Date();
  folioNo.textContent = `No. ${dayOfYear(now)} · Free edition`;
  folioDate.textContent = now.toLocaleDateString(undefined, {
    weekday: "long", day: "numeric", month: "long", year: "numeric",
  });

  if (!state.data) {
    folioPress.textContent = "The wire did not answer";
    staleBanner.hidden = true;
    return;
  }
  const { generatedAt, sourceStats = [] } = state.data;
  const ok = sourceStats.filter((s) => s.ok).length;
  folioPress.textContent =
    `Last press run ${localStamp(generatedAt)} · ${ok}/${sourceStats.length} wires` +
    (state.fromSeed ? " · deploy edition" : "");

  const age = Date.now() - new Date(generatedAt).getTime();
  if (age > STALE_AFTER_MS) {
    staleBanner.textContent =
      `Stale edition — the presses last ran ${relTime(generatedAt)} (${localStamp(generatedAt)}). ` +
      `The scheduled run may have failed; this is the most recent edition on the stand.`;
    staleBanner.hidden = false;
  } else {
    staleBanner.hidden = true;
  }
}

/* ---------- the circular rubber stamp ---------- */

const STAMP_TEXT = {
  high: { arc: "WIRE CONFIRMED", word: "VERIFIED", filter: "stamp-rough-1" },
  medium: { arc: "SINGLE SOURCE", word: "REPORTED", filter: "stamp-rough-2" },
  low: { arc: "UNVERIFIED", word: "UNVERIFIED", filter: "stamp-rough-3" },
  // Not a trust tier — YouTube commentary never carries a legitimacy rating.
  commentary: { arc: "OPINION DESK", word: "COMMENTARY", filter: "stamp-rough-2" },
};

let stampSeq = 0;

function injectStampDefs() {
  const defs = `
    <svg width="0" height="0" style="position:absolute" aria-hidden="true" focusable="false">
      <filter id="stamp-rough-1" x="-20%" y="-20%" width="140%" height="140%">
        <feTurbulence type="fractalNoise" baseFrequency="0.55" numOctaves="2" seed="7" result="n"/>
        <feDisplacementMap in="SourceGraphic" in2="n" scale="1.8"/>
      </filter>
      <filter id="stamp-rough-2" x="-20%" y="-20%" width="140%" height="140%">
        <feTurbulence type="fractalNoise" baseFrequency="0.6" numOctaves="2" seed="3" result="n"/>
        <feDisplacementMap in="SourceGraphic" in2="n" scale="2.6"/>
      </filter>
      <filter id="stamp-rough-3" x="-25%" y="-25%" width="150%" height="150%">
        <feTurbulence type="fractalNoise" baseFrequency="0.5" numOctaves="3" seed="11" result="n"/>
        <feDisplacementMap in="SourceGraphic" in2="n" scale="4.2"/>
      </filter>
    </svg>`;
  document.body.insertAdjacentHTML("afterbegin", defs);
}

function stampHtml(item) {
  const isCommentary = item.kind === "commentary";
  const level = isCommentary ? "commentary" : item.trust?.level ?? "low";
  const t = STAMP_TEXT[level] ?? STAMP_TEXT.low;
  const word = level === "low" && item.rumor ? "RUMOR" : t.word;
  const reason = isCommentary
    ? `Commentary from ${item.sources?.[0]?.name ?? "an independent channel"} — opinion and analysis, outside the legitimacy tiers; never counted as corroboration.`
    : item.trust?.reason ?? "";
  const wordSize = word.length > 8 ? 10.5 : 13;
  const id = `stamp-arc-${++stampSeq}`;
  // the smudged UNVERIFIED stamp gets a double-struck ring and a strike line
  const struck = level === "low"
    ? `<circle cx="50" cy="50" r="46" fill="none" stroke="currentColor" stroke-width="2.5" opacity="0.5" transform="rotate(7 50 50)"/>
       <line x1="16" y1="76" x2="84" y2="30" stroke="currentColor" stroke-width="3.5" opacity="0.8"/>`
    : "";
  return `<span class="stampc stampc--${esc(level)}" role="img"
      aria-label="${isCommentary ? "Commentary" : "Legitimacy"}: ${esc(word)} — ${esc(t.arc)}. ${esc(reason)}"
      title="${esc(reason)}">
    <svg viewBox="0 0 100 100" aria-hidden="true">
      <g filter="url(#${t.filter})">
        <circle cx="50" cy="50" r="46" fill="none" stroke="currentColor" stroke-width="5"/>
        <circle cx="50" cy="50" r="38.5" fill="none" stroke="currentColor" stroke-width="1.4"/>
        ${struck}
        <path id="${id}" d="M 50,50 m -32,0 a 32,32 0 1,1 64,0 a 32,32 0 1,1 -64,0" fill="none"/>
        <text class="stamp-arc-text">
          <textPath href="#${id}" startOffset="25%" text-anchor="middle">${esc(t.arc)}</textPath>
          <textPath href="#${id}" startOffset="75%" text-anchor="middle">SIGNAL DESK</textPath>
        </text>
        <g class="stamp-stars">
          <path d="M50 30.5 l1.6 3.4 3.6.4 -2.7 2.5 .7 3.6 -3.2-1.8 -3.2 1.8 .7-3.6 -2.7-2.5 3.6-.4z" transform="translate(0,-1.5) scale(0.9)" transform-origin="50 34"/>
        </g>
        <rect x="8" y="41" width="84" height="18" fill="none" stroke="currentColor" stroke-width="2.2" rx="1.5"/>
        <text x="50" y="54.5" text-anchor="middle" class="stamp-word" font-size="${wordSize}">${esc(word)}</text>
        <g class="stamp-stars">
          <path d="M50 63 l1.6 3.4 3.6.4 -2.7 2.5 .7 3.6 -3.2-1.8 -3.2 1.8 .7-3.6 -2.7-2.5 3.6-.4z" transform="scale(0.9)" transform-origin="50 66.5"/>
        </g>
      </g>
    </svg>
  </span>`;
}

/* ---------- story furniture ---------- */

function bylineHtml(item) {
  const links = (item.sources ?? []).slice(0, 4)
    .map((s) => `<a href="${esc(safeUrl(s.url))}" target="_blank" rel="noopener">${esc(s.name || s.domain)}</a>`);
  if (item.extraLink) {
    links.push(`<a href="${esc(safeUrl(item.extraLink.url))}" target="_blank" rel="noopener">${esc(item.extraLink.label)}</a>`);
  }
  const time = item.publishedAt
    ? `<span title="${esc(new Date(item.publishedAt).toLocaleString())}">${relTime(item.publishedAt)}</span>`
    : "";
  const label = item.kind === "commentary" ? "From the opinion desk" : "From the wire";
  return `<p class="byline">${label}: ${links.join(" · ")}${time ? " · " + time : ""}</p>`;
}

const DIR_SVG = {
  up: `<svg viewBox="0 0 10 10" aria-hidden="true"><polygon points="5,1 9.5,9 0.5,9"/></svg>`,
  down: `<svg viewBox="0 0 10 10" aria-hidden="true"><polygon points="5,9 9.5,1 0.5,1"/></svg>`,
  mixed: `<svg viewBox="0 0 10 10" aria-hidden="true"><polygon points="5,0.5 9.5,5 5,9.5 0.5,5"/></svg>`,
};

function marketHtml(item) {
  if (!item.market) return "";
  const dir = esc(item.market.direction);
  return `<aside class="market-wire">
      <div class="market-wire-head">${DIR_SVG[item.market.direction] ?? DIR_SVG.mixed}Market wire · ${dir.toUpperCase()}</div>
      <span class="market-assets">${esc(item.market.assets)}</span>
      ${esc(item.market.note)}
    </aside>`;
}

function kickerText(item) {
  const tags = (item.tags ?? []).filter((t) => t && t !== "Update");
  return tags.length ? tags.map(esc).join(" · ") : "";
}

function reasonHtml(item) {
  return item.trust ? `<p class="reason">${esc(item.trust.reason)}</p>` : "";
}

/* Commentary that topically matches the story rides along under the byline —
   linked, named, and never part of the source list or the stamp. */
function commentaryHtml(item) {
  if (!Array.isArray(item.commentary) || !item.commentary.length) return "";
  const links = item.commentary.slice(0, 3).map((c) =>
    `<a href="${esc(safeUrl(c.url))}" target="_blank" rel="noopener">${esc(c.channel)} — “${esc(deEmoji(c.title))}”</a>`);
  return `<p class="commentary-links">Commentary: ${links.join(" · ")}</p>`;
}

/* ---------- Public Pulse: the letters/marginalia clipping ----------
   Reader reaction from Bluesky (World + India) or Mastodon (World only),
   pinned to the story like a clipped letter to the editor. Renders ONLY when
   pulse.found — no match, no mark, same "omitted rather than invented"
   philosophy as the market wire. Tone and framing stay two separately
   labeled lines, never one number; framing always carries its disclosure. */

function pulseNoteHtml(p) {
  const tone = p.reaction_tone;
  const fr = p.framing_alignment;
  const note = fr?.note ?? "approximation — not a stance classifier";
  const isYt = p.source === "youtube";
  const srcName = isYt ? "YouTube" : p.source === "mastodon" ? "Mastodon" : "Bluesky";
  const sampleWord = isYt ? "comments" : "replies";
  const engLine = isYt
    ? `${p.view_count ?? 0} views · ${p.like_count ?? 0} likes · ${p.comment_count ?? 0} comments on the matched video`
    : `${p.like_count ?? 0} likes · ${p.reply_count ?? 0} replies on the matched post`;
  const linkText = isYt
    ? `Discussed on YouTube — “${esc(deEmoji(p.video_title ?? ""))}” →`
    : `Discussed on ${srcName} →`;
  return `<aside class="pulse" aria-label="Public Pulse — reader reaction via ${srcName}, not a legitimacy rating">
      <div class="pulse-head">Public Pulse · ${srcName}
        ${p.controversial ? `<span class="pulse-contested" title="Split reaction — readers are divided">Contested</span>` : ""}
      </div>
      <p class="pulse-line">${engLine}</p>
      ${tone?.sample_size ? `<p class="pulse-line">Reaction Tone: ${tone.positive_pct}% positive · ${tone.negative_pct}% negative · ${tone.neutral_pct}% neutral <span class="pulse-n">(${tone.sample_size} ${sampleWord})</span></p>` : ""}
      ${fr?.sample_size ? `<p class="pulse-line">Framing Alignment: ${fr.aligned_pct}% aligned · ${fr.pushback_pct}% pushback (approx.)
        <span class="pulse-info" tabindex="0" role="note" aria-label="${esc(note)}" title="${esc(note)}">ⓘ</span></p>` : ""}
      <a class="pulse-link" href="${esc(safeUrl(isYt ? p.video_url : p.post_url))}" target="_blank" rel="noopener">${linkText}</a>
    </aside>`;
}

// One marginalia note per provider that matched — two independent reactions
// are a richer signal, stacked like letters in the margin (capped at 2).
function pulseHtml(item) {
  return pulseEntries(item).slice(0, 2).map(pulseNoteHtml).join("");
}

/* ---------- the per-story OPINION card flip (World + India) ----------
   Stories whose pulse entries retained reaction samples carry an OPINION
   button; pressing it turns that one card over — the same tilted-axis
   page-turn as a section switch, scoped to the card's own bounds — to a
   For/Against split of real Bluesky/YouTube excerpts. No samples, no
   button: omitted rather than invented. */

function hasSamples(item) {
  return pulseEntries(item).some(
    (e) => e.samples?.positive?.length || e.samples?.negative?.length
  );
}

// merge each bucket across providers, tagged by source, best engagement first
function mergedSamples(item) {
  const bucket = (k) =>
    pulseEntries(item)
      .flatMap((e) => (e.samples?.[k] ?? []).map((x) => ({ ...x, source: e.source })))
      .sort((a, b) => (b.engagement ?? 0) - (a.engagement ?? 0));
  return { positive: bucket("positive"), negative: bucket("negative") };
}

const SOURCE_MARK = { bluesky: "BSKY", youtube: "YT", mastodon: "MSTDN" };

function sampleRowHtml(x) {
  const quote = `“${esc(deEmoji(x.text))}”`;
  return `<p class="op-sample">
      <span class="op-src">${SOURCE_MARK[x.source] ?? esc(x.source)}</span>
      ${x.permalink ? `<a href="${esc(safeUrl(x.permalink))}" target="_blank" rel="noopener">${quote}</a>` : quote}
      <span class="op-author">— ${esc(x.author)}</span>
    </p>`;
}

// one outbound "More on X →" per provider that matched this story
function moreLinksHtml(item) {
  return pulseEntries(item)
    .map((e) => {
      const url = e.source === "youtube" ? e.video_url : e.post_url;
      const name = e.source === "youtube" ? "YouTube" : e.source === "mastodon" ? "Mastodon" : "Bluesky";
      return url ? `<a class="op-more" href="${esc(safeUrl(url))}" target="_blank" rel="noopener">More on ${name} →</a>` : "";
    })
    .join("");
}

function opinionBackHtml(item) {
  const m = mergedSamples(item);
  const col = (label, cls, rows) => `
    <div class="opinion-col">
      <p class="opinion-col-head opinion-col-head--${cls}">${label}</p>
      ${rows.length ? rows.map(sampleRowHtml).join("") : `<p class="op-empty">No ${cls === "for" ? "positive" : "negative"} reactions in the sample.</p>`}
      <div class="op-links">${moreLinksHtml(item)}</div>
    </div>`;
  return `
    <div class="card-back-head">
      <span class="card-back-title">Reader Opinion</span>
      <button type="button" class="flip-btn" aria-expanded="true">Back</button>
    </div>
    <p class="flip-disclosure">Based on comment tone, not a verified stance.</p>
    <div class="opinion-cols">
      ${col("For", "for", m.positive)}
      ${col("Against", "against", m.negative)}
    </div>`;
}

/* Wraps a card's inner HTML in flip faces when it has reaction samples;
   otherwise the card renders exactly as before, no button. */
function flippableCard(cls, inner, item) {
  if (!hasSamples(item)) return `<article class="${cls}">${inner}</article>`;
  return `
    <article class="${cls} card-flippable">
      <div class="card-leaf">
        <div class="card-face card-face--front">
          ${inner}
          <button type="button" class="flip-btn flip-btn--open" aria-expanded="false">Opinion</button>
        </div>
        <div class="card-face card-face--back">${opinionBackHtml(item)}</div>
      </div>
    </article>`;
}

// Rasterize one card face flat (transform neutralized, offscreen) to a canvas.
async function rasterizeFace(faceEl, w, h, bg) {
  const clone = faceEl.cloneNode(true);
  Object.assign(clone.style, {
    transform: "none", backfaceVisibility: "visible", position: "fixed",
    left: "-99999px", top: "0", width: `${w}px`, height: `${h}px`, background: bg, margin: "0",
  });
  document.body.appendChild(clone);
  try { return await rasterize(clone, { width: w, height: h }); }
  finally { clone.remove(); }
}

// one delegated listener survives every board re-render
board.addEventListener("click", async (e) => {
  const btn = e.target.closest(".flip-btn");
  if (!btn) return;
  const card = btn.closest("article");
  if (!card || card.dataset.pfFlipping) return;

  const applyState = (flipped) => {
    card.classList.toggle("is-flipped", flipped);
    card.querySelectorAll(".flip-btn").forEach((b) => b.setAttribute("aria-expanded", String(flipped)));
  };
  const willFlip = !card.classList.contains("is-flipped");

  // Reduced motion / no WebGL: swap faces instantly.
  if (REDUCED_MOTION.matches || !WEBGL_OK) { applyState(willFlip); return; }

  // Curl the card over on the shared WebGL engine, scoped to its own bounds
  // (never the viewport). The currently-visible face becomes the curling
  // texture; the target face is set live underneath and revealed as it rolls.
  const visibleFace = card.querySelector(willFlip ? ".card-face--front" : ".card-face--back");
  const r = card.getBoundingClientRect();
  const bg = getComputedStyle(card).backgroundColor;

  card.dataset.pfFlipping = "1";
  let shot;
  try {
    shot = await rasterizeFace(visibleFace, r.width, r.height, bg);
  } catch {
    applyState(willFlip);
    delete card.dataset.pfFlipping;
    return;
  }
  applyState(willFlip); // target face live underneath; the synchronous first curl render covers it (no flash)
  curlFlip({
    left: r.left, top: r.top, width: r.width, height: r.height, texCanvas: shot,
    settleTarget: card, dir: willFlip ? 1 : -1, // open curls forward, close curls back
    onDone: () => { delete card.dataset.pfFlipping; },
  });
});

/* Pull quote only when the story actually contains one — a real quotation
   in the wire copy, not manufactured emphasis. */
function pullQuote(summary) {
  const m = String(summary ?? "").match(/[“"]([^”"]{40,200})[”"]/);
  return m ? `<blockquote class="pullquote">“${esc(m[1])}”</blockquote>` : "";
}

/* ---------- the fold + columns ---------- */

function leadHtml(item) {
  const kicker = kickerText(item);
  const deck = deckFor(item);
  // standfirst = the first sentence; the rest runs as justified body copy
  let standfirst = deck, body = "";
  const cut = deck.match(/^.{60,220}?[.!?](\s|$)/);
  if (cut && deck.length - cut[0].length > 60) {
    standfirst = cut[0].trim();
    body = deck.slice(cut[0].length).trim();
  }
  const prose = /^[A-Za-z“"]/.test(body || standfirst);
  const inner = `
      ${stampHtml(item)}
      ${kicker ? `<p class="kicker">${kicker}</p>` : ""}
      <h2 class="lead-headline"><a href="${esc(safeUrl(item.url))}" target="_blank" rel="noopener">${esc(deEmoji(item.title))}</a></h2>
      <div class="lead-body">
        <div>
          ${standfirst ? `<p class="lead-standfirst">${esc(standfirst)}</p>` : ""}
          ${body ? `<p class="lead-summary ${prose ? "lead-summary--prose" : ""}">${esc(body)}</p>` : ""}
          ${pullQuote(deck)}
        </div>
        <div class="lead-rail">
          ${bylineHtml(item)}
          ${reasonHtml(item)}
          ${commentaryHtml(item)}
          ${marketHtml(item)}
          ${pulseHtml(item)}
        </div>
      </div>`;
  return flippableCard("lead", inner, item);
}

function storyHtml(item, { brief = false, secondary = false } = {}) {
  const kicker = kickerText(item);
  const deck = brief ? "" : deckFor(item);
  const showReason = item.trust?.level === "low";
  const cls = brief ? "brief" : secondary ? "story story--secondary" : "story";
  const inner = `
      ${stampHtml(item)}
      ${kicker ? `<p class="kicker">${kicker}</p>` : ""}
      <h3 class="headline"><a href="${esc(safeUrl(item.url))}" target="_blank" rel="noopener">${esc(deEmoji(item.title))}</a></h3>
      ${deck ? `<p class="story-summary">${esc(deck)}</p>` : ""}
      ${marketHtml(item)}
      ${bylineHtml(item)}
      ${commentaryHtml(item)}
      ${showReason ? reasonHtml(item) : ""}
      ${brief ? "" : pulseHtml(item)}`;
  // briefs stay flat — the rail is too tight for a card turn
  if (brief) return `<article class="${cls}">${inner}</article>`;
  return flippableCard(cls, inner, item);
}

const INDIA_BRIEF_TAG = (item) =>
  (item.tags ?? []).some((t) => t !== "Government") && (item.tags ?? []).length > 0;

/* The latest videos from the reader's followed YouTube channels get their own
   labelled block high on the page — otherwise, ranked lowest, they sink to the
   bottom of the wire columns and go unseen. Channel · title · short description,
   newest first. */
const PLAY_SVG =
  `<svg class="channel-play" viewBox="0 0 12 12" aria-hidden="true"><polygon points="2,1.5 10.5,6 2,10.5"/></svg>`;
function channelsHtml(videos) {
  if (!videos.length) return "";
  const sorted = [...videos].sort((a, b) => (b.publishedAt ?? "").localeCompare(a.publishedAt ?? ""));
  const cards = sorted.map((v) => {
    const desc = deckFor(v);
    const chan = v.sources?.[0]?.name ?? "Channel";
    const time = v.publishedAt ? relTime(v.publishedAt) : "";
    return `<article class="channel-card">
        <p class="channel-src">${esc(chan)}${time ? ` · <span>${esc(time)}</span>` : ""}</p>
        <h3 class="channel-title">${PLAY_SVG}<a href="${esc(safeUrl(v.url))}" target="_blank" rel="noopener">${esc(deEmoji(v.title))}</a></h3>
        ${desc ? `<p class="channel-desc">${esc(desc)}</p>` : ""}
      </article>`;
  }).join("");
  return `<section class="channels" aria-label="Latest from the channels">
      <p class="channels-head">On the channels · latest video</p>
      <div class="channels-grid">${cards}</div>
    </section>`;
}

function renderBoard() {
  const meta = SECTION_META[state.tab];
  sectionBanner.textContent = meta.banner;
  deskLine.textContent = meta.desk;
  scopeBar.hidden = state.tab !== "esports";
  fitBanner(sectionBanner);

  let items = state.data?.sections?.[state.tab] ?? [];
  if (state.tab === "esports" && state.esportsScope === "india") {
    items = items.filter((i) => i.scope === "india");
  }
  if (!items.length) {
    const copy = state.tab === "esports" && state.esportsScope === "india"
      ? "No India-edition sports signals in the stored sweep. Turn to the Global edition, or wait for the next press run."
      : "Nothing cleared the filters this press run. The desk sweeps a few times a day — the next edition will fill this page.";
    board.innerHTML = `
      <div class="state">
        <div class="state-title">Quiet Presses</div>
        <p>${copy}</p>
      </div>`;
    return;
  }

  // Channel videos render in their own prominent block (below), never mixed into
  // the news placement — ranked lowest, they would otherwise sink to the bottom
  // of the wire columns and never be seen.
  const videos = items.filter((i) => i.kind === "commentary");
  const news = items.filter((i) => i.kind !== "commentary");

  // Importance decides the slot: lead well, secondary row, columns, briefs.
  const scored = news.map((item, i) => ({ item, i, score: importance(item) }))
    .sort((a, b) => b.score - a.score || a.i - b.i);

  // A section can (rarely) carry only channel videos this run — show just those.
  if (!scored.length) {
    board.innerHTML =
      `<div class="front front--no-rail"><div class="main-well">${channelsHtml(videos)}</div></div>`;
    return;
  }

  const leadEntry = scored.slice(0, 3).find((e) => deckFor(e.item).length >= 60) ?? scored[0];
  const pool = scored.filter((e) => e !== leadEntry);

  const secondary = [];
  for (const e of pool) {
    if (secondary.length >= 2) break;
    if (deckFor(e.item)) secondary.push(e);
  }
  let rest = pool.filter((e) => !secondary.includes(e));

  // Briefs rail: on the National desk, the states; elsewhere the thinnest items.
  let briefs;
  if (state.tab === "india") {
    briefs = rest.filter((e) => INDIA_BRIEF_TAG(e.item)).slice(0, 8);
  } else {
    const thin = rest.filter((e) => !deckFor(e.item) || e.score < 3);
    briefs = thin.slice(-8); // lowest-importance first out of the columns
  }
  rest = rest.filter((e) => !briefs.includes(e));

  const briefsHead = state.tab === "india" ? "From the states" : "In brief";
  const railHtml = briefs.length
    ? `<aside class="briefs" aria-label="${briefsHead}">
         <p class="briefs-head">${briefsHead}</p>
         ${briefs.map((e) => storyHtml(e.item, { brief: true })).join("")}
       </aside>`
    : "";

  // Below the fold: every story is a cell in one aligned grid (CSS lays out
  // the 3 → 2 → 1 columns and the hairline rules), so rows line up across all
  // columns and the whole section reads clean. Row-major flow puts the
  // highest-importance items along the top row. The last row is padded with
  // blank parchment cells so the grid's ink backing never shows through an
  // empty trailing cell.
  const cols = columnCount();
  const pad = rest.length ? (cols - (rest.length % cols)) % cols : 0;
  const fillers = '<div class="story story--filler" aria-hidden="true"></div>'.repeat(pad);
  const columnsHtml = rest.length
    ? `<div class="fold-rule" role="presentation"></div>
       <div class="columns">${rest.map((e) => storyHtml(e.item)).join("")}${fillers}</div>`
    : "";

  board.innerHTML = `
    <div class="front ${railHtml ? "" : "front--no-rail"}">
      <div class="main-well">
        ${leadHtml(leadEntry.item)}
        ${secondary.length ? `<div class="secondary-row">${secondary.map((e) => storyHtml(e.item, { secondary: true })).join("")}</div>` : ""}
        ${channelsHtml(videos)}
        ${columnsHtml}
      </div>
      ${railHtml}
    </div>`;
}

/* active column count — matches the CSS grid breakpoints; used only to pad
   the last grid row so no empty cell exposes the ink backing. CSS still owns
   layout and overflow, so a stale count after an un-reloaded resize is at
   worst a cosmetic blank cell, never a broken layout. */
const mq1024 = window.matchMedia("(max-width: 1024px)");
const mq640 = window.matchMedia("(max-width: 640px)");
function columnCount() {
  return mq640.matches ? 1 : mq1024.matches ? 2 : 3;
}
for (const mq of [mq1024, mq640]) {
  mq.addEventListener("change", () => { if (state.data) renderBoard(); });
}

function renderErrorState() {
  const meta = SECTION_META[state.tab];
  sectionBanner.textContent = meta.banner;
  deskLine.textContent = meta.desk;
  fitBanner(sectionBanner);
  board.innerHTML = `
    <div class="state">
      <div class="state-title">Press Stopped</div>
      <p>The archive did not answer — neither the stored sweep nor the deploy edition came off the wire.
         Resync, or check the Netlify function logs if the presses stay quiet.</p>
      <button type="button" class="resync" id="retry">Resync the presses</button>
    </div>`;
  document.getElementById("retry")?.addEventListener("click", () => load({ sweep: true }));
}

/* ---------- banner fitting: the name never clips, at any width ---------- */

function fitBanner(el) {
  if (!el) return;
  el.style.fontSize = "";
  let size = parseFloat(getComputedStyle(el).fontSize);
  for (let pass = 0; pass < 2 && el.scrollWidth > el.clientWidth; pass++) {
    size = Math.floor(size * (el.clientWidth / el.scrollWidth) * 0.97);
    el.style.fontSize = `${size}px`;
  }
}

const fitBanners = () => { fitBanner(mastheadEl); fitBanner(sectionBanner); };

let fitTimer;
function onViewportChange() {
  clearTimeout(fitTimer);
  fitTimer = setTimeout(fitBanners, 150); // banners re-fit; CSS handles columns
}
if (window.ResizeObserver) {
  new ResizeObserver(onViewportChange).observe(document.documentElement);
} else {
  window.addEventListener("resize", onViewportChange);
}
document.fonts?.ready?.then(fitBanners);

/* ---------- the page flip: a WebGL Apple-Books page curl (Three.js) ----------
   The realistic cylindrical curl the storyboard/guide call for can't be done
   by transforming a rectangle in CSS, so both flips — the section switch and
   the per-story Opinion card — run a real 3D mesh curl. The outgoing face is
   rasterized once (modern-screenshot, browser-native) into a texture on a
   finely subdivided plane;
   a custom shader wraps every vertex past a moving curl line around a cylinder
   (guide's math: θ = dist/R, x' = curl + R·sinθ, z' = R·(1−cosθ)) whose radius
   GROWS through the turn (tight corner curl → loose roll), biases the curl line
   by y so a corner lifts first, and shades the sheet from its post-deform normal
   with a specular ridge, fold AO, and a darker/warmer back face. Direction is
   signed: a forward turn peels the top-right corner off the left edge; a
   backward turn (flipping back to an earlier section) mirrors it — top-left off
   the right edge. A soft shadow band tracks the curl across the page beneath,
   and a short CSS settle adds the 2–3px landing flex. The new content is live in
   the DOM underneath; the transparent WebGL overlay reveals it as it rolls. */

const FLIP_MS = 820;            // phase-2 arc reads clearly at ~0.8s
const RASTER_SCALE = 1;         // snapshot scale for the page texture
const CURL_TILT = 90;           // px of curl-line lead at the top edge vs bottom → top-right lifts first
const PAPER_BG =
  getComputedStyle(document.documentElement).getPropertyValue("--color-parchment").trim() || "#e2dedb";
const WEBGL_OK = (() => {
  try { return !!document.createElement("canvas").getContext("webgl"); } catch { return false; }
})();

// uDir = +1 forward turn (top-RIGHT corner lifts, sheet peels off the LEFT);
// uDir = −1 backward turn — the whole curl is mirrored across the page so the
// top-LEFT corner lifts and the sheet peels off the RIGHT (flipping back a page).
// The cylinder math runs in a single "forward" space (px); for a backward turn
// x is mirrored in and back out, and the screen-space normal x is flipped so a
// fixed light shades the mirrored ridge correctly.
const CURL_VERT = `
  uniform float uCurlX, uR, uTilt, uH, uW, uDir;
  varying vec2 vUv; varying vec3 vNormal; varying float vArc;
  void main() {
    vUv = uv;
    vec3 p = position;                 // x in [0,W], y in [0,-H]
    float px = (uDir > 0.0) ? p.x : (uW - p.x);  // mirror into forward space for a backward turn
    float curl = uCurlX + uTilt * (-p.y) / uH;   // top (y~0) reaches the line first
    float d = px - curl;
    vec3 nrm = vec3(0.0, 0.0, 1.0);
    float arc = 0.0;                   // how far this vertex has wrapped (for AO/spec)
    if (d > 0.0) {
      float theta = d / uR;
      px = curl + uR * sin(theta);
      p.z = uR * (1.0 - cos(theta));
      nrm = vec3(-sin(theta), 0.0, cos(theta));
      arc = theta;
    }
    p.x = (uDir > 0.0) ? px : (uW - px);         // mirror back out
    if (uDir < 0.0) nrm.x = -nrm.x;              // screen-space normal follows the mirror
    vArc = arc;
    vNormal = nrm;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(p, 1.0);
  }`;
const CURL_FRAG = `
  precision mediump float;
  uniform sampler2D uTex; uniform vec3 uLight;
  varying vec2 vUv; varying vec3 vNormal; varying float vArc;
  void main() {
    vec4 c = texture2D(uTex, vUv);
    vec3 n = normalize(vNormal);
    vec3 L = normalize(uLight);
    float diff = clamp(dot(n, L) * 0.45 + 0.62, 0.4, 1.05);
    // specular glint riding the curved ridge (guide #3)
    vec3 H = normalize(L + vec3(0.0, 0.0, 1.0));
    float spec = pow(max(dot(n, H), 0.0), 22.0) * 0.32;
    // soft ambient occlusion where the sheet lifts off the flat page (guide #3/#4)
    float ao = 1.0 - 0.26 * exp(-vArc * 2.4) * step(0.0005, vArc);
    vec3 col = c.rgb;
    if (!gl_FrontFacing) { col = col * 0.66 + vec3(0.06, 0.04, 0.01); spec *= 0.4; } // verso: darker + warmer
    gl_FragColor = vec4(col * diff * ao + spec, c.a);
  }`;

const easeInOutCubic = (t) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);
const lerp = (a, b, t) => a + (b - a) * t;

// Rasterize a DOM node to a canvas via the browser's own renderer (SVG
// foreignObject, with fonts embedded) — unlike html2canvas it handles the
// project's modern CSS (color-mix / color()) and web fonts.
async function rasterize(el, { width, height } = {}) {
  return domToCanvas(el, { width, height, backgroundColor: PAPER_BG, scale: RASTER_SCALE });
}

/* Snapshot ONLY the visible viewport slice of the page. A full section can be
   ~5000px / ~1600 nodes tall; foreignObject rasterization is node-bound, so
   capturing all of it costs seconds. Cloning `.paper` and dropping every node
   outside the visible band (decided from the live geometry, removed from the
   clone by index) leaves ~60 nodes and rasterizes in well under 200ms. */
async function snapshotViewport() {
  const paper = document.querySelector(".paper");
  const vw = document.documentElement.clientWidth;
  const vh = document.documentElement.clientHeight;
  const scrollY = window.scrollY;
  const clone = paper.cloneNode(true);
  const orig = paper.querySelectorAll("*");
  const cl = clone.querySelectorAll("*");
  for (let i = orig.length - 1; i >= 0; i--) {
    const r = orig[i].getBoundingClientRect();
    if ((r.top > vh + 60 || r.bottom < -60) && cl[i] && cl[i].parentNode) cl[i].remove();
  }
  clone.querySelectorAll("[id]").forEach((el) => el.removeAttribute("id"));
  clone.style.transform = `translateY(${-scrollY}px)`; // pin to what the reader sees
  clone.style.margin = "0";
  const wrap = document.createElement("div");
  wrap.style.cssText = `position:fixed;left:-99999px;top:0;width:${vw}px;height:${vh}px;overflow:hidden;background:${PAPER_BG}`;
  wrap.appendChild(clone);
  document.body.appendChild(wrap);
  try { return { canvas: await rasterize(wrap, { width: vw, height: vh }), vw, vh }; }
  finally { wrap.remove(); }
}

/* Run one cylindrical curl over a transparent WebGL overlay at the given
   bounds, texturing `texCanvas` (the outgoing snapshot). The incoming content
   is already live underneath. Resolves after the turn + settle. */
function curlFlip({ left, top, width, height, texCanvas, settleTarget, onDone, dir = 1 }) {
  dir = dir < 0 ? -1 : 1;
  const stage = document.createElement("div");
  stage.className = "curl-stage";
  Object.assign(stage.style, { left: `${left}px`, top: `${top}px`, width: `${width}px`, height: `${height}px` });
  const shadow = document.createElement("div");
  shadow.className = "curl-shadow";
  if (dir < 0) {
    // mirror the cast shadow to the right edge for a backward turn
    shadow.style.left = "auto";
    shadow.style.right = "0";
    shadow.style.background =
      "linear-gradient(270deg, rgba(29,29,27,0) 0%, rgba(29,29,27,0.12) 62%, rgba(29,29,27,0.34) 100%)";
  }
  stage.appendChild(shadow);
  document.body.appendChild(stage);

  const renderer = new THREE.WebGLRenderer({ alpha: true, antialias: true, premultipliedAlpha: false });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
  renderer.setSize(width, height, false);
  renderer.setClearColor(0x000000, 0);
  const gl = renderer.domElement;
  gl.style.width = "100%"; gl.style.height = "100%";
  stage.appendChild(gl);

  const camera = new THREE.OrthographicCamera(0, width, 0, -height, -3000, 3000);
  camera.position.z = 1500;
  const scene = new THREE.Scene();

  const tex = new THREE.CanvasTexture(texCanvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.minFilter = THREE.LinearFilter;
  tex.magFilter = THREE.LinearFilter;

  // Curl radius GROWS through the turn (guide #1/#2): a tight corner curl early,
  // widening into a loose cylinder as the sheet rolls fully over.
  const minDim = Math.min(width, height);
  const R0 = Math.max(15, minDim * 0.045); // tiny initial corner curl
  const R1 = Math.max(30, minDim * 0.11);  // loose final roll
  const geo = new THREE.PlaneGeometry(width, height, 120, 50);
  geo.translate(width / 2, -height / 2, 0); // top-left at origin, spanning x∈[0,W], y∈[0,−H]
  const mat = new THREE.ShaderMaterial({
    uniforms: {
      uTex: { value: tex },
      uCurlX: { value: width + R1 * 2 },
      uR: { value: R0 },
      uTilt: { value: CURL_TILT },
      uH: { value: height },
      uW: { value: width },
      uDir: { value: dir },
      uLight: { value: new THREE.Vector3(0.35, 0.55, 0.78) },
    },
    vertexShader: CURL_VERT,
    fragmentShader: CURL_FRAG,
    side: THREE.DoubleSide,
    transparent: true,
  });
  const mesh = new THREE.Mesh(geo, mat);
  scene.add(mesh);

  const startX = width + R1 * 2;             // fully flat at t=0 (widest radius clears the page)
  const endX = -R1 * Math.PI - width * 0.18; // sweep the curl fully off the edge at t=1
  let done = false;
  const t0 = performance.now();

  const finish = () => {
    if (done) return;
    done = true;
    cancelAnimationFrame(raf);
    geo.dispose(); mat.dispose(); tex.dispose();
    try { renderer.forceContextLoss(); } catch { /* not supported */ } // free the GL context now, not at GC
    renderer.dispose();
    stage.remove();
    if (settleTarget && settleTarget.isConnected) {
      settleTarget.classList.add("pf-settle");
      setTimeout(() => settleTarget.classList.remove("pf-settle"), 260);
    }
    onDone && onDone();
  };

  let raf = 0;
  const frame = (now) => {
    const t = Math.min(1, (now - t0) / FLIP_MS);
    const e = easeInOutCubic(t);           // accelerate in, decelerate before landing (guide #6)
    const curlX = lerp(startX, endX, e);
    mat.uniforms.uCurlX.value = curlX;
    mat.uniforms.uR.value = lerp(R0, R1, e); // radius grows as the sheet rolls (guide #1/#2)
    // soft shadow tracks the curl across the underlying page, peaking mid-turn;
    // mirrored to the opposite edge on a backward turn
    const sx = Math.max(0, Math.min(width, curlX));
    const off = dir > 0 ? sx - width : width - sx;
    shadow.style.transform = `translateX(${off}px)`;
    shadow.style.opacity = String(Math.sin(Math.PI * t) * 0.5);
    renderer.render(scene, camera);
    if (t < 1) raf = requestAnimationFrame(frame);
    else finish();
  };
  renderer.render(scene, camera); // synchronous frame 0 fully covers the bounds → no flash of the swapped content underneath
  raf = requestAnimationFrame(frame);
  setTimeout(finish, FLIP_MS + 900); // safety net incl. rasterize slack
}

let flipping = false;

async function flipToNewPage(renderNew, dir = 1) {
  // Reduced motion / no WebGL: skip the curl, swap straight to the new page —
  // the project's established fallback.
  if (!state.data || REDUCED_MOTION.matches || flipping || !WEBGL_OK) {
    renderNew();
    return;
  }
  flipping = true;
  let shot, vw, vh;
  try {
    // snapshot exactly what the reader sees BEFORE swapping content
    ({ canvas: shot, vw, vh } = await snapshotViewport());
  } catch (err) {
    console.warn("curl: snapshot failed, cutting straight to the new page", err);
    renderNew();
    flipping = false;
    return;
  }
  document.body.classList.add("flipping");
  renderNew();          // the new section is live in the DOM underneath
  window.scrollTo(0, 0);
  curlFlip({
    left: 0, top: 0, width: vw, height: vh, texCanvas: shot, dir,
    settleTarget: document.querySelector(".paper"),
    onDone: () => { document.body.classList.remove("flipping"); flipping = false; },
  });
}

/* ---------- interactions ---------- */

const tabs = [...document.querySelectorAll('[role="tab"]')];
tabs.forEach((tab, i) => {
  tab.addEventListener("click", () => selectTab(tab));
  tab.addEventListener("keydown", (e) => {
    if (e.key !== "ArrowRight" && e.key !== "ArrowLeft") return;
    const next = tabs[(i + (e.key === "ArrowRight" ? 1 : tabs.length - 1)) % tabs.length];
    next.focus();
    selectTab(next);
  });
});

function selectTab(tab) {
  if (tab.dataset.tab === state.tab) return;
  // Moving to an EARLIER section curls backward, like flipping back a page
  // (e.g. World → Tech); a later section curls forward.
  const fromIdx = tabs.findIndex((t) => t.dataset.tab === state.tab);
  const dir = tabs.indexOf(tab) < fromIdx ? -1 : 1;
  tabs.forEach((t) => {
    t.setAttribute("aria-selected", String(t === tab));
    t.tabIndex = t === tab ? 0 : -1;
  });
  board.setAttribute("aria-labelledby", tab.id);
  flipToNewPage(() => {
    state.tab = tab.dataset.tab;
    renderBoard();
  }, dir);
}

scopeBar.querySelectorAll("button").forEach((btn) => {
  btn.addEventListener("click", () => {
    if (btn.dataset.scope === state.esportsScope) return;
    scopeBar.querySelectorAll("button").forEach((b) => {
      b.classList.toggle("active", b === btn);
      b.setAttribute("aria-pressed", String(b === btn));
    });
    flipToNewPage(() => {
      state.esportsScope = btn.dataset.scope;
      renderBoard();
    });
  });
});

refreshBtn.addEventListener("click", () => load({ sweep: true }));

/* ---------- search the wire: reader-triggered Tavily fetch ----------
   One click = one basic search for the open section (the Esports page searches
   its current edition). The key lives server-side; the count is a shared
   daily pool that resets each UTC day and still draws down the same monthly
   budget ledger as the scheduled sweeps. Button hidden when the layer is off. */

const wireBtn = document.getElementById("tavily-fetch");

function renderWireBtn(text) {
  if (!state.wire.enabled) return;
  const n = state.wire.remaining;
  wireBtn.disabled = state.wire.busy || n <= 0;
  wireBtn.textContent =
    text ?? (n > 0 ? `Search the wire · ${n} left today` : "Wire searches spent — fresh pool tomorrow");
}

async function initWireSearch() {
  try {
    const res = await fetch("/api/tavily-fetch");
    if (!res.ok) return;
    const info = await res.json();
    if (!info.enabled) return;
    state.wire.enabled = true;
    state.wire.remaining = info.remaining;
    wireBtn.hidden = false;
    renderWireBtn();
  } catch { /* endpoint unreachable — the button stays hidden */ }
}

async function wireSearch() {
  if (state.wire.busy || state.wire.remaining <= 0 || !state.data) return;
  const section = state.tab === "esports"
    ? (state.esportsScope === "india" ? "esportsIndia" : "esportsGlobal")
    : state.tab;
  state.wire.busy = true;
  renderWireBtn("Searching the wire…");
  let note = "The wire did not answer";
  try {
    const res = await fetch(`/api/tavily-fetch?section=${section}`, { method: "POST" });
    const out = await res.json().catch(() => ({}));
    if (typeof out.remaining === "number") state.wire.remaining = out.remaining;
    if (res.ok && out.items) {
      state.data.sections[out.sectionKey] = out.items;
      renderBoard();
      note = out.added || out.corroborated
        ? `Wire answered: ${out.added} new · ${out.corroborated} corroborated`
        : "Wire answered: nothing new for this page";
    } else if (out.error) {
      note = `The wire: ${out.error}`;
    }
  } catch { /* note stays "did not answer" */ }
  state.wire.busy = false;
  renderWireBtn(note);
  setTimeout(() => renderWireBtn(), 2800);
}

wireBtn.addEventListener("click", wireSearch);

injectStampDefs();
load();
initWireSearch();
