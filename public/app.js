/* Signal Desk — the broadsheet edition. Reads the stored sweep and sets it
   like a front page: importance decides footprint (lead well, secondary row,
   ruled columns, briefs rail), every story hand-stamped. No feed fetches
   here — /api/news is a blob read; /data/seed.json is the fallback edition. */

const state = {
  data: null,
  fromSeed: false,
  tab: "tech",
  esportsScope: "global",
  view: "news", // "news" | "opinion" — the in-section flip view
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
    banner: "SPORTS",
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
  if (item.pulse?.found) {
    const engaged = (item.pulse.like_count ?? 0) + (item.pulse.reply_count ?? 0);
    if (engaged >= 50 || item.pulse.controversial) s += 1;
  }
  return s;
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
  // Not a trust tier either — opinion/editorial items are pulled out of the
  // legitimacy pipeline; the stamp is neutral grayscale, never High/Med/Low.
  opinion: { arc: "EDITORIAL DESK", word: "OPINION", filter: "stamp-rough-2" },
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
  const isOpinion = item.contentType === "opinion";
  const level = isCommentary ? "commentary" : isOpinion ? "opinion" : item.trust?.level ?? "low";
  const t = STAMP_TEXT[level] ?? STAMP_TEXT.low;
  const word = level === "low" && item.rumor ? "RUMOR" : t.word;
  const reason = isCommentary
    ? `Commentary from ${item.sources?.[0]?.name ?? "an independent channel"} — opinion and analysis, outside the legitimacy tiers; never counted as corroboration.`
    : isOpinion
    ? `Opinion/editorial from ${item.sources?.[0]?.name ?? "the wire"} — a viewpoint, not a claim: pulled out of the legitimacy tiers, never counted as corroboration.`
    : item.trust?.reason ?? "";
  const wordSize = word.length > 8 ? 10.5 : 13;
  const id = `stamp-arc-${++stampSeq}`;
  // the smudged UNVERIFIED stamp gets a double-struck ring and a strike line
  const struck = level === "low"
    ? `<circle cx="50" cy="50" r="46" fill="none" stroke="currentColor" stroke-width="2.5" opacity="0.5" transform="rotate(7 50 50)"/>
       <line x1="16" y1="76" x2="84" y2="30" stroke="currentColor" stroke-width="3.5" opacity="0.8"/>`
    : "";
  return `<span class="stampc stampc--${esc(level)}" role="img"
      aria-label="${isCommentary ? "Commentary" : isOpinion ? "Opinion" : "Legitimacy"}: ${esc(word)} — ${esc(t.arc)}. ${esc(reason)}"
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

function pulseHtml(item) {
  const p = item.pulse;
  if (!p?.found) return "";
  const likes = p.like_count ?? 0;
  const replies = p.reply_count ?? 0;
  const tone = p.reaction_tone;
  const fr = p.framing_alignment;
  const srcName = p.source === "mastodon" ? "Mastodon" : "Bluesky";
  const note = fr?.note ?? "approximation — reply tone vs. headline tone, not a stance classifier";
  return `<aside class="pulse" aria-label="Public Pulse — reader reaction, not a legitimacy rating">
      <div class="pulse-head">Public Pulse
        ${p.controversial ? `<span class="pulse-contested" title="Split or quote-heavy reaction — readers are divided">Contested</span>` : ""}
      </div>
      <p class="pulse-line">${likes} likes · ${replies} replies on the matched post</p>
      ${tone?.sample_size ? `<p class="pulse-line">Reaction Tone: ${tone.positive_pct}% positive · ${tone.negative_pct}% negative · ${tone.neutral_pct}% neutral <span class="pulse-n">(${tone.sample_size} replies)</span></p>` : ""}
      ${fr?.sample_size ? `<p class="pulse-line">Framing Alignment: ${fr.aligned_pct}% aligned · ${fr.pushback_pct}% pushback (approx.)
        <span class="pulse-info" tabindex="0" role="note" aria-label="${esc(note)}" title="${esc(note)}">ⓘ</span></p>` : ""}
      <a class="pulse-link" href="${esc(safeUrl(p.post_url))}" target="_blank" rel="noopener">Discussed on ${srcName} →</a>
    </aside>`;
}

/* ---------- per-story opinion (World + India) ----------
   Two kinds of voices fold out of a story's own OPINION button:
   1. Columns that topically match the story (story.opinions[]) — pointers
      only, never sources, never scored.
   2. Real reader replies from the story's matched Pulse thread
      (pulse.voices), separated FOR / AGAINST by reply tone — the same
      lexicon as the pulse aggregates, disclosed as an approximation.
   Stories with neither show nothing. The full desk-wide column list stays
   behind the header's OPINION flip. */

function voicesSideHtml(label, cls, messages) {
  if (!messages?.length) return "";
  const rows = messages.map((m) =>
    `<p class="voice">“${esc(deEmoji(m.text))}”<span class="voice-author"> — @${esc(m.author)}${m.likes ? ` · ${m.likes} likes` : ""}</span></p>`).join("");
  return `<p class="voices-head voices-head--${cls}">${label}</p>${rows}`;
}

function storyOpinionsHtml(item) {
  const ops = item.opinions ?? [];
  const v = item.pulse?.voices;
  const voiceCount = (v?.for?.length ?? 0) + (v?.against?.length ?? 0);
  if (!ops.length && !voiceCount) return "";
  const colRows = ops.slice(0, 3).map((o) =>
    `<p class="story-opinion-row"><a href="${esc(safeUrl(o.url))}" target="_blank" rel="noopener">${esc(o.source)} — “${esc(deEmoji(o.title))}”</a></p>`).join("");
  const voices = voiceCount
    ? `<div class="story-voices">
        ${voicesSideHtml("Readers for", "for", v.for)}
        ${voicesSideHtml("Readers against", "against", v.against)}
        <p class="voices-note">${esc(v.note ?? "grouped by reply tone — an approximation, not a stance classifier")}</p>
      </div>`
    : "";
  return `<div class="story-opinions">
      <button type="button" class="opinion-btn" aria-expanded="false">Opinion on this story (${ops.length + voiceCount})</button>
      <div class="story-opinion-list" hidden>${colRows}${voices}</div>
    </div>`;
}

// one delegated listener survives every board re-render
board.addEventListener("click", (e) => {
  const btn = e.target.closest(".opinion-btn");
  if (!btn) return;
  const list = btn.parentElement.querySelector(".story-opinion-list");
  const open = list.hidden;
  list.hidden = !open;
  btn.setAttribute("aria-expanded", String(open));
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
  return `
    <article class="lead">
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
          ${storyOpinionsHtml(item)}
          ${marketHtml(item)}
          ${pulseHtml(item)}
        </div>
      </div>
    </article>`;
}

function storyHtml(item, { brief = false, secondary = false } = {}) {
  const kicker = kickerText(item);
  const deck = brief ? "" : deckFor(item);
  const showReason = item.trust?.level === "low";
  const cls = brief ? "brief" : secondary ? "story story--secondary" : "story";
  return `
    <article class="${cls}">
      ${stampHtml(item)}
      ${kicker ? `<p class="kicker">${kicker}</p>` : ""}
      <h3 class="headline"><a href="${esc(safeUrl(item.url))}" target="_blank" rel="noopener">${esc(deEmoji(item.title))}</a></h3>
      ${deck ? `<p class="story-summary">${esc(deck)}</p>` : ""}
      ${marketHtml(item)}
      ${bylineHtml(item)}
      ${commentaryHtml(item)}
      ${showReason ? reasonHtml(item) : ""}
      ${brief ? "" : storyOpinionsHtml(item)}
      ${brief ? "" : pulseHtml(item)}
    </article>`;
}

const INDIA_BRIEF_TAG = (item) =>
  (item.tags ?? []).some((t) => t !== "Government") && (item.tags ?? []).length > 0;

/* ---------- the OPINION flip view ----------
   Same section, other side of the sheet: every item stamped OPINION (neutral
   grayscale — these were pulled out of the trust tiers on purpose), set as
   brief-style entries in the shared aligned column grid: headline, one-line
   excerpt, source byline. Importance ranking doesn't apply; recency order. */

function opinionEntryHtml(item) {
  const excerpt = deckFor(item);
  return `
    <article class="story story--opinion">
      ${stampHtml(item)}
      <h3 class="headline"><a href="${esc(safeUrl(item.url))}" target="_blank" rel="noopener">${esc(deEmoji(item.title))}</a></h3>
      ${excerpt ? `<p class="story-summary opinion-excerpt">${esc(excerpt)}</p>` : ""}
      ${bylineHtml(item)}
    </article>`;
}

function renderOpinionBoard(items) {
  if (!items.length) {
    board.innerHTML = `
      <div class="state">
        <div class="state-title">No Opinion Pieces</div>
        <p>Nothing on this desk carried an opinion or editorial marking this press run.
           The desk sweeps a few times a day — columns print here when the wires carry them.</p>
      </div>`;
    return;
  }
  const cols = columnCount();
  const pad = (cols - (items.length % cols)) % cols;
  const fillers = '<div class="story story--filler" aria-hidden="true"></div>'.repeat(pad);
  board.innerHTML = `<div class="columns">${items.map(opinionEntryHtml).join("")}${fillers}</div>`;
}

function renderBoard() {
  const meta = SECTION_META[state.tab];
  const opinionView = state.view === "opinion";
  sectionBanner.textContent = opinionView ? `${meta.banner} — OPINION` : meta.banner;
  deskLine.textContent = opinionView
    ? "Columns and editorials — viewpoints, not claims. Pulled out of the trust tiers; they corroborate nothing."
    : meta.desk;
  scopeBar.hidden = state.tab !== "esports";
  fitBanner(sectionBanner);
  renderOpinionToggle();

  let items = state.data?.sections?.[state.tab] ?? [];
  if (state.tab === "esports" && state.esportsScope === "india") {
    items = items.filter((i) => i.scope === "india");
  }
  if (opinionView) {
    renderOpinionBoard(items.filter((i) => i.contentType === "opinion"));
    return;
  }
  // opinion items live behind the OPINION flip, never in the news flow
  items = items.filter((i) => i.contentType !== "opinion");
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

  // Importance decides the slot: lead well, secondary row, columns, briefs.
  const scored = items.map((item, i) => ({ item, i, score: importance(item) }))
    .sort((a, b) => b.score - a.score || a.i - b.i);

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

/* ---------- the page flip: the whole sheet turns on its spine ----------
   A single leaf holds a snapshot of the entire outgoing page (masthead
   included, offset by the reader's scroll so the turn covers exactly what
   they see). It hinges on the left spine and sweeps right-to-left; a
   curl-shade band and a cast shadow do the lighting, so the flat sheet reads
   as a curving page. The next section is set on the stand beneath before the
   turn starts, revealed as the sheet lifts away. */

let flipping = false;

function flipToNewPage(renderNew) {
  if (!state.data || REDUCED_MOTION.matches || flipping) {
    renderNew();
    return;
  }
  const paper = document.querySelector(".paper");
  const vw = document.documentElement.clientWidth;
  const scrollY = window.scrollY;

  const stage = document.createElement("div");
  stage.className = "flip-stage";
  stage.setAttribute("aria-hidden", "true");

  // the outgoing page snapshot, pinned to what the reader currently sees
  const shot = document.createElement("div");
  shot.className = "fold-shot";
  shot.style.width = `${vw}px`;
  shot.innerHTML = paper.outerHTML;
  shot.querySelectorAll("[id]").forEach((el) => el.removeAttribute("id"));
  shot.style.transform = `translateY(${-scrollY}px)`;

  const cast = document.createElement("div");
  cast.className = "flip-cast";
  const leaf = document.createElement("div");
  leaf.className = "leaf";
  const front = document.createElement("div");
  front.className = "leaf-face leaf-front";
  front.appendChild(shot);
  const back = document.createElement("div");
  back.className = "leaf-face leaf-back";
  const shade = document.createElement("div");
  shade.className = "leaf-shade";
  leaf.append(front, back, shade);
  stage.append(cast, leaf);

  flipping = true;
  document.body.classList.add("flipping");
  document.body.appendChild(stage);
  renderNew(); // the next page is already on the stand beneath the turning sheet
  window.scrollTo(0, 0);

  const done = () => {
    stage.remove();
    document.body.classList.remove("flipping");
    flipping = false;
  };
  leaf.addEventListener("animationend", done, { once: true });
  setTimeout(() => { if (stage.isConnected) done(); }, 1400); // safety net
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
  tabs.forEach((t) => {
    t.setAttribute("aria-selected", String(t === tab));
    t.tabIndex = t === tab ? 0 : -1;
  });
  board.setAttribute("aria-labelledby", tab.id);
  flipToNewPage(() => {
    state.tab = tab.dataset.tab;
    state.view = "news"; // a new section always opens on its news side
    renderBoard();
  });
}

/* ---------- the OPINION toggle: flip within the section ----------
   The same page-turn as a section switch, but the sheet lands on the
   section's own opinion side. Reduced motion follows the established flip
   behavior (skip to an instant cut). */

const opinionBtn = document.getElementById("opinion-toggle");

function renderOpinionToggle() {
  // Opinion is a World + India feature — the toggle never prints elsewhere.
  opinionBtn.hidden = state.tab !== "geopolitics" && state.tab !== "india";
  const opinionView = state.view === "opinion";
  opinionBtn.textContent = opinionView ? `Back to ${SECTION_META[state.tab].banner}` : "Opinion";
  opinionBtn.setAttribute("aria-pressed", String(opinionView));
}

opinionBtn.addEventListener("click", () => {
  if (!state.data) return;
  flipToNewPage(() => {
    state.view = state.view === "opinion" ? "news" : "opinion";
    renderBoard();
  });
});

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
   One click = one basic search for the open section (the Sports page searches
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
