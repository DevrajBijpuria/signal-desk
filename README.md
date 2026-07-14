# Signal Desk

A personal news intelligence desk: **Tech & AI · Geopolitics (World) · India ·
Esports**, each item scored for legitimacy by rules (no model anywhere in the
loop), rendered as an 1890s broadsheet newspaper. Built to run **at zero
ongoing cost** on Netlify's free tier — no paid APIs, no database, no required
keys. A handful of optional layers (Tavily discovery, Public Pulse) are gated
behind free, self-serve credentials and skip cleanly when unset.

## Architecture

```
┌─────────────────────────┐     cron (4×/day)
│ refresh-news (scheduled)│  fetch → dedupe → score → tag
│ netlify/functions/      │──────────────┐
└─────────────────────────┘              ▼
                                 ┌───────────────┐
                                 │ Netlify Blobs │  one JSON blob ("latest")
                                 └───────┬───────┘
┌─────────────────────────┐              │ single read, edge-cached 5 min
│ news (GET /api/news)    │◄─────────────┘
└───────────┬─────────────┘
            ▼
   public/ (static frontend)      falls back to /data/seed.json
                                  (written at deploy time by the build command)
```

- Page loads never touch a news feed — they read the stored sweep.
- Every source fetch has its own timeout (8–9s); a slow or dead feed degrades the
  sweep instead of failing it. The whole run finishes in ~8–17s, under the 30s
  scheduled-function limit.
- The build command runs the same pipeline and writes `public/data/seed.json`, so a
  fresh deploy has data before the first cron tick.
- One reader-triggered endpoint sits beside `/api/news`, credential-gated
  server-side and merged back into the stored blob: `/api/tavily-fetch` (the
  per-section "Search the wire" button).

## Local dev

`netlify-cli` is a devDependency, so `npm install` is all the setup you need.

```bash
npm install
npm run pipeline        # run the whole fetch+score pipeline once, writes public/data/seed.json
npm run dev             # netlify dev on http://localhost:8888
```

With `netlify dev` running, trigger a sweep into the local blob store, then open
http://localhost:8888:

```bash
curl -X POST http://localhost:8888/.netlify/functions/refresh-news
```

(In production the scheduled function is not HTTP-invocable; that curl works in
dev only. In VS Code, `Ctrl+Shift+B` runs the dev-server task from
`.vscode/tasks.json`.)

## Cron schedule

Set in [netlify/functions/refresh-news.mjs](netlify/functions/refresh-news.mjs):

```js
export const config = { schedule: "0 1,7,13,19 * * *" }; // four sweeps a day, UTC
```

Change the cron expression and redeploy. Netlify free tier includes scheduled
functions and Blobs; four short sweeps a day is a rounding error against the quota.

## Deploy

```bash
npm i -g netlify-cli
netlify init      # create & link a site (pick "deploy manually" or connect the repo)
netlify deploy --prod
```

Or push to GitHub and click **Add new site → Import an existing project** in the
Netlify UI — `netlify.toml` already declares the build command and publish
directory. **There are no required environment variables** — the whole pipeline
is free and keyless. The optional layers are env-gated and skip cleanly when
unset (each documented in its own section below):

| Variable | Layer |
|----------|-------|
| `TAVILY_API_KEY` + `TAVILY_MONTHLY_CREDITS` | Tavily discovery + the "Search the wire" button |
| `BLUESKY_HANDLE` + `BLUESKY_APP_PASSWORD` | Public Pulse (Bluesky provider) |
| `YOUTUBE_API_KEY` | Public Pulse (YouTube comments provider) |
| `MASTODON_ENABLED=true` | Public Pulse Mastodon signal (World only; keyless, just opt-in) |

For local dev, the same variables live in a gitignored `.env` that
`netlify dev` and `node --env-file=.env` pick up automatically — never
committed, never hardcoded.

## Legitimacy scoring (the core feature)

Purely rule-based, and every item carries its reason in the UI:

| Tier | Who | Level |
|------|-----|-------|
| 1 | Wire services (Reuters, AP, AFP, BBC), PIB & government domains, official company blogs (openai.com, blog.google, …), peer-reviewed journals | **HIGH** |
| 2 | Single reputable outlets (TechCrunch, The Hindu, Bloomberg, …), arXiv preprints, Liquipedia | **MED** |
| 3 | Anything not in the map | **LOW** |

Stories are deduped across feeds by normalized-title similarity and canonical URL;
when **two or more independent tier-1 sources** corroborate the same story, the
level is bumped one step and the reason says who corroborated. Special cases keep
the reason honest: arXiv is labeled a primary preprint (not peer-reviewed),
Liquipedia a moderated community wiki. Market-impact notes on geopolitics items
are also rules (keyword → mechanism → likely direction) and are omitted when no
rule matches, rather than invented.

The tier map lives in [src/scoring.mjs](src/scoring.mjs) — extend it as you add sources.

## Sources & quirks

| Section | Sources | Notes |
|---------|---------|-------|
| Tech & AI | Hacker News (Algolia API), arXiv (cs.AI/LG/CL), TechCrunch, The Verge, VentureBeat, Ars Technica, Wired, MIT Tech Review, IEEE Spectrum, The Register | HN items are scored by the *linked* domain, so an HN link to openai.com scores tier-1 with the HN thread attached |
| Geopolitics | BBC World, Reuters, AP, Al Jazeera, The Guardian, DW, France 24, NPR World, UN News, GDELT DOC API | Reuters/AP retired public RSS — fetched via Google News RSS scoped to `site:reuters.com/world` / `site:apnews.com "world news"`, which preserves the original outlet for scoring. Sports/entertainment are filtered out |
| India | PIB, The Hindu (National + Other States), Indian Express, Hindustan Times, NDTV, Times of India | PIB's own RSS currently serves Hindi with no dates, so PIB comes via Google News scoped to `site:pib.gov.in`. PIB gets a reserved quota so dailies can't crowd government releases out |
| Esports | Liquipedia (VALORANT, CS2, Dota 2, PUBG Mobile/BGMI main pages + per-wiki Esports World Cup pages), Dexerto Esports, Dot Esports | All Liquipedia calls share one queue: spaced ~2s, descriptive User-Agent, hard time budget. BGMI events drive the India toggle; EWC pages are India-scoped when an Indian org appears among participants. **Update the contact email in `src/esports.mjs` (`LP_UA`) if you fork this** |
| World + India (Public Pulse) | Bluesky (search via app-password session; threads via public.api.bsky.app, no auth), YouTube comments (Data API v3), optionally Mastodon hashtag timelines (World only) | Reader reaction, not a news source — never merges into an item's source list, never touches the legitimacy tier. Bluesky search ANDs its terms, so queries stay at 4 keywords; matching uses title-side word overlap because plain Jaccard only ever matched verbatim headline-mirror bots (live-verified); zero-engagement Bluesky matches are discarded. YouTube's search.list has its own ~100/day bucket, hence a smaller per-desk cap and stored-video-ID reuse |

Dexerto/Dot Esports items are filtered to roster moves, transfers, rumors, and
EWC coverage. Anything with rumor markers ("reportedly", "in talks", "sources
say", …) is tagged **Rumor** and force-scored **Low** until a tier-1 source (an
org's official channel, a confirmed Liquipedia entry) corroborates it — an
unconfirmed lineup change never reads as settled fact.

GDELT is wired with its own timeout; some networks reset connections to it, in
which case the sweep simply proceeds without it (the source counter in the header
shows exactly this).

## Tavily discovery (optional, env-gated)

One broad topical search per section per run — five fixed queries, basic depth —
in [src/tavily.mjs](src/tavily.mjs). Results that match an existing story (same
title-similarity test as dedupe) merge in as a **corroborating source**; anything
else becomes a new item scored through the same rule-based tier map. No key, no
layer: if `TAVILY_API_KEY` or `TAVILY_MONTHLY_CREDITS` is unset, or the Blobs
budget ledger is unreachable, the run proceeds on RSS/API/YouTube alone.

Budget lock: spend is capped at **90% of `TAVILY_MONTHLY_CREDITS`**. Usage lives
in Blobs (`tavily-usage`: `{ month, creditsUsed, day, manualUsed }`; creditsUsed
resets on month rollover, manualUsed each UTC day); each scheduled run may spend
`(cappedCeiling − creditsUsed) / daysLeftInMonth`, so skipped runs roll their
budget forward. Queries run in priority order (tech → geo → India → esports
global → esports India) and stop when the allowance is out; a partial run never
blocks the rest of the sweep. Every attempted request counts as spent.

**Search the wire (on-demand):** every section header carries a
"Search the wire · N left today" button — one click runs that section's query
right now (the Esports page searches its current edition) via
`netlify/functions/tavily-fetch.mjs` and merges the results into the stored
sweep with the same corroborate-or-new-item semantics. The key stays
server-side. Clicks draw from a shared daily pool (20/day, resets each UTC
day) that also counts against the monthly ledger, so readers can never blow
the cap. When the layer is off (no env vars), the button never appears.

## Public Pulse (optional, lightweight credentials)

A rule-based **reader reaction** layer on the World and India desks only —
Tech & AI and Esports are out of scope by design. `pulse` is an **array of
provider entries** (`source: "bluesky" | "youtube" | "mastodon"`), one per
provider that found a qualifying match — a story matched by two providers
shows two stacked marginalia notes (a genuinely richer signal), and a story
matched by none carries `pulse: []`.

**Bluesky (primary):** for each desk's top stories, the sweep finds the most
engaged matching post (rule-based word overlap, ~3-day recency window,
adult-labeled posts excluded, zero-engagement headline-mirror bots filtered
out) and reads its native numbers: likes, reposts, replies, quotes.

**YouTube comments (second provider, both desks):** same query building, same
similarity function against video title + description, same 0.35 threshold;
`YOUTUBE_API_KEY` is a self-serve key from Google Cloud Console — no approval
queue, no card. The one real budget: since June 2026, `search.list` draws
from its own ~100-calls/day bucket, so YouTube gets a deliberately smaller
top-N (4 stories per desk vs. Bluesky's 8 → 32 searches/day worst case), and
matched video IDs are stored so later sweeps re-fetch numbers via the cheap
main-pool endpoints instead of re-searching. Videos with comments disabled (a
meaningful share of news videos) are a normal no-match, not an error — the
next qualifying candidate is tried. Key absent → the provider logs once and
no-ops; Bluesky and Mastodon are unaffected.

Replies/comments feed two **separately labeled** metrics that are never
collapsed into one figure:

- **Reaction Tone** — plain AFINN-165 lexicon sentiment across the reply
  sample (% positive / negative / neutral). A mood reading, not agreement.
- **Framing Alignment** — reply tone sign vs. the headline's own tone sign,
  always shown with its disclosure: *approximation — reply tone vs. headline
  tone, not a stance classifier.*

A **Contested** mark appears when tone splits both ways past ~35% or (Bluesky
only) when the post is quote-heavy relative to its likes — Bluesky's quote
culture skews commentary/pushback; YouTube has no quote analog, so it uses the
shared split-tone rule alone. No LLM anywhere — lexicon and rules only, same
as the legitimacy scoring. Stories with no qualifying match carry `pulse: []`
and render nothing — omitted, not invented. Matched post URIs and video IDs
are stored so later sweeps re-fetch fresh numbers directly instead of
re-searching.

**The per-story OPINION card flip:** during the same tone-bucketing pass that
feeds the aggregates, each provider entry retains up to 6 **samples** per
bucket (`samples: { positive, negative }`, each `{ text, author, permalink,
engagement }`, best engagement first; neutral comments aren't stored). Any
World/India card whose pulse entries carry samples grows an **OPINION** button
that turns that single card over — the same tilted-axis 780ms page-turn as a
section switch, scoped to the card, instant cut under `prefers-reduced-motion`
— onto a two-column **For / Against** back: real Bluesky and YouTube excerpts
merged and engagement-sorted, each tagged BSKY/YT with its author, a one-line
disclosure ("Based on comment tone, not a verified stance"), and a
"More on Bluesky/YouTube →" link out to each matched thread. No samples, no
button. BACK turns the card to its front.

**The credentials, stated plainly:** this project's posture is keyless, and
Pulse is the intentional exception — but a materially lighter one than a
typical OAuth registration. Bluesky's public read API needs no auth; keyword
*search* needs a session from an **app password**, generated instantly in your
own account settings (Settings → App Passwords) — no developer application, no
approval queue. YouTube's Data API key is equally self-serve from Google Cloud
Console — no review, no card. Set `BLUESKY_HANDLE` + `BLUESKY_APP_PASSWORD`
(never the account's main password) and `YOUTUBE_API_KEY` in Netlify env
settings; any that are unset make that provider silently no-op while the rest
of the sweep runs exactly as before.

**Mastodon secondary signal** (World only, off by default): set
`MASTODON_ENABLED=true` to also match against public hashtag timelines on
mastodon.social — fully keyless, since Mastodon's public API needs no auth.
Hashtag timelines only: the fediverse has no unified free-text search without
an instance account, so none is attempted. Never applied to India, where
fediverse political discussion is thin.

## YouTube commentary (no key needed)

Distinct from the Pulse YouTube *comments* provider above: this layer follows
whole channels, needs no key, and applies to every section. Channel RSS
(`youtube.com/feeds/videos.xml?channel_id=…`) is fetched exactly like
the other feeds. The channel list lives in
[src/commentary-channels.mjs](src/commentary-channels.mjs), grouped by section —
edit it there; the fetch logic never changes. Everything from this source is
**commentary**, a category apart from the trust tiers: it never carries a
legitimacy rating, never joins a story's source list, and never counts toward
corroboration. A video that topically matches a story rides along under that
story's byline; the rest run as their own stamped COMMENTARY entries. Uploads
older than 7 days don't print (max 3 per channel per sweep). Current roster:
**Tech/AI** — AI Explained, Yannic Kilcher, Wes Roth, Matt Wolfe, Two Minute
Papers, Fireship, David Shapiro; **Geopolitics** — Perun, Zeihan, CaspianReport,
Asianometry, Context Matters; **India** — Ravish Kumar, Punya Prasun Bajpai, The
Deshbhakt, ThePrint, Satya Hindi, Newslaundry, Sarthak Goswami; plus the Esports
global/India commentary channels. Every channel ID is resolved from its `@handle`
page and verified against its feed `<title>` before it's added.

## Frontend — the Miranda broadsheet

The site reads as one edition of a paper, styled to the Miranda reference
("old-world broadsheet on warm cream") in [design/DESIGN.md](design/DESIGN.md)
and [design/tokens.json](design/tokens.json). Every color, type, spacing,
radius, and shadow value flows from the tokens: run

```bash
node scripts/build-tokens.mjs   # design/tokens.json → public/tokens.css
```

after editing tokens (the generated `public/tokens.css` is committed).

The paper's furniture: a dateline topbar (edition **No. = day of year**, date,
last press run + wire count); a full-width Ink Black **SIGNAL DESK** masthead
banner in Abril Fatface with letters crowded tight; a section index strip as
the contents line (TECH & AI / WORLD / INDIA / ESPORTS — no "Page One" prefix);
per-desk ink banners with a one-line standfirst; then an **importance-weighted
front page** (see below). India runs state-tagged stories as a **From the
states** briefs rail; other desks get an **In brief** rail. Esports switches
between Global and India editions. Stale data prints a "stale edition" notice;
a failed load stops the presses (blackletter "Press Stopped"), never a spinner.

### Importance-weighted layout

Each section is set like a real front page: a story's footprint scales with an
**importance score** computed in `app.js` (`importance()`) purely from signals
the pipeline already produces — legitimacy tier, independent-source
corroboration, a market note, EWC/live status, recency, whether the wire sent
real copy; rumors are demoted. `renderBoard()` sorts by that score and assigns
slots:

- **Lead well** — the top story: large Abril headline, standfirst (its first
  sentence), justified body, big stamp, on the one Bone Cream card that carries
  the sole sanctioned ink shadow.
- **Secondary row** — the next two, in a two-column ruled row beneath the lead.
- **Column grid** — everything else, below a double-rule fold.
- **Briefs rail** — the thinnest items (on India, the state-tagged stories under
  "From the states"; elsewhere "In brief").

A low-signal day (few items) and a big-news day lay out differently because the
same scores map to fewer or more filled slots.

**The column grid is one shared CSS grid, not separate stacks.** Every
below-the-fold story is a cell in the same row/column matrix, so all cells in a
row share a height and the hairline rules line up straight across every column —
the section reads as clean at the bottom as at the top. The rules are drawn by a
`1px` grid `gap` over an Ink Black backing: each parchment cell covers the
backing and the gaps show through as aligned hairlines (no fragile per-column
border math). Stories flow row-major, so the highest-importance items sit along
the top row. `renderBoard()` pads the final row with blank parchment
`.story--filler` cells (up to `columnCount() - 1` of them) so an uneven story
count never leaves an empty cell exposing the ink backing. The grid collapses
`3 → 2 → 1` columns in pure CSS at the `1024px` / `640px` breakpoints and can
never overflow; `columnCount()` (matchMedia) is used only to size the filler
padding, and re-renders on breakpoint change.

### The page curl (WebGL, Three.js)

Both transitions — the section switch and the per-story Opinion card — run a
real **3D cylindrical page curl** modelled on the Apple Books turn, because a
true curl can't be faked by transforming a rectangle in CSS. The outgoing face
is rasterized to a texture (via `modern-screenshot`, which uses the browser's
own renderer so the project's modern CSS and web fonts come through — unlike
html2canvas, which chokes on `color-mix()`), mapped onto a finely subdivided
`three.js` plane. A custom shader wraps every vertex past a moving curl line
around a cylinder (`θ = dist/R`, `x' = curl + R·sinθ`, `z' = R·(1−cosθ)`) whose
**radius grows through the turn** — a tight corner curl early that widens into a
loose roll — biases that line by `y` so a **corner lifts first**, and shades the
sheet from its deformed normal with a **specular glint on the ridge**, soft
**ambient occlusion at the fold**, and a verso tinted darker and warmer. The turn
is **direction-signed**: moving to a *later* section curls **forward** (top-right
corner peels off the left edge); moving **back** to an *earlier* section (e.g.
World → Tech) mirrors the whole curl — top-left corner peels off the right edge,
like flipping back a page — and the Opinion card opens forward, closes backward.
A soft shadow band tracks the curl across the page beneath (mirrored to the
matching edge per direction); a short CSS settle adds the 2–3px landing flex. The
new content sits live in the DOM underneath and is revealed as the transparent
overlay's sheet rolls away — so both faces are the real rendered app, captured
only for the ~0.8s motion. The section snapshot is trimmed to the visible
viewport first (a full section is ~5000px of DOM; rasterizing all of it would
cost seconds — trimming keeps it ~200ms). Fires once per switch (and on the
Esports edition toggle), never on the already-open section. Under
**`prefers-reduced-motion` (or no WebGL) the curl is skipped** — the new content
cuts in instantly. Vendored, keyless deps in `public/vendor/`; `app.js` loads as
an ES module.

**Legitimacy prints as a circular rubber stamp**, not a gauge — an inked,
distressed press mark (SVG: double ring, arc text, banner word, stars, a
`feTurbulence` roughen filter). **VERIFIED / WIRE** is a crisp Ember Orange
stamp (the page's sanctioned chromatic note); **REPORTED** is a lighter, partial
Ink Black press (single reputable source); **UNVERIFIED / RUMOR** is a
struck-through Ink Black stamp (double-struck ring + strike line) — how every
rumor and unconfirmed lineup move runs until a tier-1 source corroborates. The
one-line reason and the source link(s) stay attached to every story — printed
in the lead rail and on Low-trust stories, and always in the stamp's tooltip
and accessible label. One neutral grayscale stamp sits deliberately outside
the tier system: **COMMENTARY** (YouTube channel videos) — a category, not a
rating.

**Fonts are free substitutes** for the commercial Miranda faces, mapped in
`scripts/build-tokens.mjs` (`FONT_SUBS`) so a licensed swap later is one line:
Editorial New → **Source Serif 4** (body, weight 300 only), Canopee →
**Abril Fatface** (masthead, section banners, story headlines — the didone
fatface that gives the front page its 19th-century weight; kept off body copy,
where it turns to mud), Domaine Display → **Playfair Display 500** (standfirsts,
pull quotes), Germgoth → **Pirata One** (the rare blackletter moment, reserved
for press-stopped states). Served from Google Fonts — keyless, free,
non-blocking.

**Google Stitch (MCP) is an optional design-time aid only** — it was available
for drafting layouts during development and is not a runtime dependency. The
deployed frontend stays static and free: every credential-gated call runs
server-side in a Netlify function, and no key ever reaches the browser.

## Retired assets

`public/assets/bg-world.png` / `bg-india.png` and
`scripts/generate_map_backgrounds.py` are from the previous dark theme and are
no longer referenced by the newspaper frontend; they're kept in the repo in
case a future theme wants map plates again (regenerate with
`py scripts/generate_map_backgrounds.py`, needs Python + matplotlib).
