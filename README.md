# Signal Desk

A personal news-intelligence desk rendered as an 1890s broadsheet newspaper. Four desks — **Tech & AI · Geopolitics (World) · India · Esports** — with every item **scored for legitimacy by rules** (no model anywhere in the loop).

Built to run at **zero ongoing cost** on Netlify's free tier: no paid APIs, no database, no required keys. Optional layers (Tavily discovery, Public Pulse) are gated behind free, self-serve credentials and skip cleanly when unset.

**At a glance**

- 🗞️ **Rule-based legitimacy scoring** — a source-tier map plus a corroboration bump, with the reason printed on every story
- ⚖️ **Cross-source framing** — how differently each outlet worded the same headline, on clustered stories
- 📈 **Market wire** — rule-derived market-impact notes on geopolitics items
- 💬 **Public Pulse** — real reader reaction from Bluesky / YouTube / Mastodon on World & India
- 📺 **YouTube commentary** — channel uploads as a separate opinion category, never counted as news
- 📄 **The Miranda broadsheet** — tokens-driven 19th-century front page with a real WebGL page curl

## Contents

- [How it works](#how-it-works)
- [Quick start](#quick-start)
- [Deploy](#deploy)
- [Legitimacy scoring (the core feature)](#legitimacy-scoring-the-core-feature)
- [Cross-source framing (keyless)](#cross-source-framing-keyless)
- [Sources & quirks](#sources--quirks)
- [Tavily discovery (optional)](#tavily-discovery-optional-env-gated)
- [Public Pulse (optional)](#public-pulse-optional-lightweight-credentials)
- [YouTube commentary (no key needed)](#youtube-commentary-no-key-needed)
- [Frontend — the Miranda broadsheet](#frontend--the-miranda-broadsheet)
- [Retired assets](#retired-assets)

## How it works

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

- **Page loads never touch a news feed** — they read the stored sweep. Instant, free per visitor.
- Every source fetch has its own timeout (8–9s); a slow or dead feed **degrades** the sweep instead of failing it. The whole run finishes in ~8–17s, under Netlify's 30s scheduled-function limit.
- The build command runs the same pipeline and writes `public/data/seed.json`, so a fresh deploy has data before the first cron tick.
- One reader-triggered endpoint sits beside `/api/news`: `/api/tavily-fetch` (the per-section "Search the wire" button), credential-gated server-side and merged back into the stored blob.

## Quick start

`netlify-cli` is a devDependency, so `npm install` is all the setup you need.

```bash
npm install
npm run pipeline        # run the fetch+score pipeline once, writes public/data/seed.json
npm run dev             # netlify dev on http://localhost:8888
```

With `netlify dev` running, trigger a sweep into the local blob store, then open http://localhost:8888:

```bash
curl -X POST http://localhost:8888/.netlify/functions/refresh-news
```

That curl works in dev only (in production the scheduled function is not HTTP-invocable). In VS Code, `Ctrl+Shift+B` runs the dev-server task from `.vscode/tasks.json`.

## Deploy

```bash
npm i -g netlify-cli
netlify init      # create & link a site (deploy manually or connect the repo)
netlify deploy --prod
```

Or push to GitHub and click **Add new site → Import an existing project** in the Netlify UI — `netlify.toml` already declares the build command and publish directory.

### Environment variables (all optional)

**There are no required environment variables** — the whole pipeline is free and keyless. The optional layers are env-gated and skip cleanly when unset:

| Variable | Layer |
|----------|-------|
| `TAVILY_API_KEY` + `TAVILY_MONTHLY_CREDITS` | Tavily discovery + the "Search the wire" button |
| `BLUESKY_HANDLE` + `BLUESKY_APP_PASSWORD` | Public Pulse (Bluesky provider) |
| `YOUTUBE_API_KEY` | Public Pulse (YouTube comments provider) |
| `MASTODON_ENABLED=true` | Public Pulse Mastodon signal (World only; keyless, just opt-in) |

For local dev, the same variables live in a gitignored `.env` that `netlify dev` and `node --env-file=.env` pick up automatically.

### Cron schedule

Set in [netlify/functions/refresh-news.mjs](netlify/functions/refresh-news.mjs):

```js
export const config = { schedule: "0 1,7,13,19 * * *" }; // four sweeps a day, UTC
```

Change the cron expression and redeploy. Netlify's free tier includes scheduled functions and Blobs; four short sweeps a day is a rounding error against the quota.

## Legitimacy scoring (the core feature)

Purely rule-based, and every item carries its reason in the UI:

| Tier | Who | Level |
|------|-----|-------|
| 1 | Wire services (Reuters, AP, AFP, BBC), PIB & government domains, official company blogs (openai.com, blog.google, …), peer-reviewed journals | **HIGH** |
| 2 | Single reputable outlets (TechCrunch, The Hindu, Bloomberg, …), arXiv preprints, Liquipedia | **MED** |
| 3 | Anything not in the map | **LOW** |

Stories are deduped across feeds by normalized-title similarity and canonical URL; when **two or more independent tier-1 sources** corroborate the same story, the level is bumped one step and the reason says who corroborated. Special cases keep the reason honest: **arXiv** is labeled a primary preprint (not peer-reviewed), **Liquipedia** a moderated community wiki, and **market-impact notes** on geopolitics items are also rules (keyword → mechanism → likely direction), omitted when no rule matches rather than invented.

The tier map lives in [src/scoring.mjs](src/scoring.mjs) — extend it as you add sources.

## Cross-source framing (keyless)

When dedupe clusters the same story from **two or more outlets**, each corroborating source keeps **its own original headline wording** through the merge, and one extra rule-based pass ([src/framing.mjs](src/framing.mjs)) scores each headline with the same AFINN-165 lexicon Public Pulse uses for Reaction Tone — no model, no key, all four desks.

Each headline lands in one of five buckets — **Critical · Skeptical · Neutral · Measured · Favorable** — with thresholds kept as data in `FRAMING_CONFIG`, tuned against a live sweep's real scores (154 headlines in −7..+4, median 0, so ±1 reads as "near zero" and ±4 as strongly loaded wording). The labels print beside each outlet in the byline — "TechCrunch (Neutral) · The Verge (Skeptical)" — with a one-line disclosure: *framing reflects headline word-choice only, not a bias or quality judgment.*

Boundaries: framing is a **separate axis from the legitimacy tier** and never influences it — a Critical-framed headline from a wire service stays High. It's equally distinct from Public Pulse's Reaction Tone and Framing Alignment (which measure *reader* reaction). Single-source stories carry no `framing` field — omitted, not invented.

## Sources & quirks

| Section | Sources | Notes |
|---------|---------|-------|
| Tech & AI | Hacker News (Algolia API), arXiv (cs.AI/LG/CL), TechCrunch, The Verge, VentureBeat, Ars Technica, Wired, MIT Tech Review, IEEE Spectrum, The Register | HN items are scored by the *linked* domain, so an HN link to openai.com scores tier-1 with the HN thread attached |
| Geopolitics | BBC World, Reuters, AP, Al Jazeera, The Guardian, DW, France 24, NPR World, UN News, GDELT DOC API | Reuters/AP retired public RSS — fetched via Google News RSS scoped to `site:reuters.com/world` / `site:apnews.com "world news"`, which preserves the original outlet for scoring. Sports/entertainment filtered out |
| India | PIB, The Hindu (National + Other States), Indian Express, Hindustan Times, NDTV, Times of India | PIB's own RSS serves Hindi with no dates, so PIB comes via Google News scoped to `site:pib.gov.in`. PIB gets a reserved quota so dailies can't crowd government releases out |
| Esports | Liquipedia (VALORANT, CS2, Dota 2, PUBG Mobile/BGMI main pages + per-wiki Esports World Cup pages), Dexerto Esports, Dot Esports | All Liquipedia calls share one queue: spaced ~2s, descriptive User-Agent, hard time budget. BGMI events drive the India toggle; EWC pages are India-scoped when an Indian org appears. **Update `LP_UA` in `src/esports.mjs` if you fork this** |
| World + India (Public Pulse) | Bluesky (search via app-password session; threads via public.api.bsky.app, no auth), YouTube comments (Data API v3), optionally Mastodon hashtag timelines (World only) | Reader reaction, not a news source — never merges into a source list, never touches the tier. See the Public Pulse section below |

**Rumor handling:** Dexerto/Dot Esports items are filtered to roster moves, transfers, rumors, and EWC coverage. Anything with rumor markers ("reportedly", "in talks", "sources say", …) is tagged **Rumor** and force-scored **Low** until a tier-1 source (an org's official channel, a confirmed Liquipedia entry) corroborates it.

**GDELT** is wired with its own timeout; some networks reset connections to it, in which case the sweep proceeds without it (the header's source counter shows this).

## Tavily discovery (optional, env-gated)

One broad topical search per section per run — five fixed queries, basic depth — in [src/tavily.mjs](src/tavily.mjs). Results that match an existing story (same title-similarity test as dedupe) merge in as a **corroborating source**; anything else becomes a new item scored through the same tier map. If `TAVILY_API_KEY` / `TAVILY_MONTHLY_CREDITS` is unset or the Blobs ledger is unreachable, the run proceeds on RSS/API/YouTube alone.

**Budget lock:** spend is capped at **90% of `TAVILY_MONTHLY_CREDITS`**. Usage lives in Blobs (`tavily-usage`: `{ month, creditsUsed, day, manualUsed }`; creditsUsed resets on month rollover, manualUsed each UTC day); each scheduled run may spend `(cappedCeiling − creditsUsed) / daysLeftInMonth`, so skipped runs roll budget forward. Queries run in priority order (tech → geo → India → esports global → esports India) and stop when the allowance is out. Every attempted request counts as spent.

**Search the wire (on-demand):** every section header carries a "Search the wire · N left today" button — one click runs that section's query now via `netlify/functions/tavily-fetch.mjs` and merges results into the stored sweep with the same corroborate-or-new-item semantics. The key stays server-side. Clicks draw from a shared daily pool (20/day, resets each UTC day) that also counts against the monthly ledger, so readers can never blow the cap. Off (no env vars) → the button never appears.

## Public Pulse (optional, lightweight credentials)

A rule-based **reader reaction** layer on the World and India desks only (Tech & AI and Esports are out of scope by design). `pulse` is an **array of provider entries** (`source: "bluesky" | "youtube" | "mastodon"`), one per provider that found a qualifying match — two providers show two stacked marginalia notes; no match carries `pulse: []` and renders nothing.

### Providers

- **Bluesky (primary):** for each desk's top stories, finds the most engaged matching post (rule-based word overlap, ~3-day recency window, adult-labeled posts excluded, zero-engagement headline-mirror bots filtered out) and reads its native numbers: likes, reposts, replies, quotes. Search ANDs its terms, so queries stay at 4 keywords; matching uses title-side word overlap because plain Jaccard only ever matched verbatim bots (live-verified).
- **YouTube comments (both desks):** same query building and 0.35 similarity threshold against video title + description. Since June 2026 `search.list` draws from its own ~100-calls/day bucket, so YouTube gets a smaller top-N (4 stories/desk vs. Bluesky's 8 → 32 searches/day worst case), and matched video IDs are stored so later sweeps re-fetch numbers via cheap main-pool endpoints. Comments-disabled videos are a normal no-match — the next candidate is tried.
- **Mastodon (World only, off by default):** set `MASTODON_ENABLED=true` to also match public hashtag timelines on mastodon.social — keyless. Hashtag timelines only (the fediverse has no unified free-text search without an instance account). Never applied to India.

### The two metrics

Replies/comments feed two **separately labeled** metrics, never collapsed into one:

- **Reaction Tone** — plain AFINN-165 lexicon sentiment across the reply sample (% positive / negative / neutral). A mood reading, not agreement.
- **Framing Alignment** — reply tone sign vs. the headline's own tone sign, always shown with its disclosure: *approximation — reply tone vs. headline tone, not a stance classifier.*

A **Contested** mark appears when tone splits both ways past ~35%, or (Bluesky only) when the post is quote-heavy relative to its likes. No LLM anywhere — lexicon and rules only.

### The per-story OPINION card flip

During the same tone-bucketing pass, each provider entry retains up to 6 **samples** per bucket (`samples: { positive, negative }`, each `{ text, author, permalink, engagement }`, best first; neutral not stored). Any World/India card carrying samples grows an **OPINION** button that turns that card over (the same tilted-axis 780ms page-turn as a section switch, scoped to the card; instant cut under `prefers-reduced-motion`) onto a two-column **For / Against** back: real Bluesky/YouTube excerpts merged and engagement-sorted, each tagged BSKY/YT with author, a disclosure ("Based on comment tone, not a verified stance"), and a "More on Bluesky/YouTube →" link. No samples, no button.

### The credentials, stated plainly

Pulse is the intentional exception to the keyless posture — but a lighter one than typical OAuth. Bluesky's public read API needs no auth; keyword *search* needs a session from an **app password**, generated instantly in your account settings (Settings → App Passwords) — no developer application, no approval queue. YouTube's Data API key is equally self-serve from Google Cloud Console. Set `BLUESKY_HANDLE` + `BLUESKY_APP_PASSWORD` (never the account's main password) and `YOUTUBE_API_KEY` in Netlify env; any unset make that provider silently no-op while the rest of the sweep runs unchanged.

## YouTube commentary (no key needed)

Distinct from the Pulse YouTube *comments* provider above: this layer follows whole channels, needs no key, and applies to every section. Channel RSS (`youtube.com/feeds/videos.xml?channel_id=…`) is fetched like the other feeds. The channel list lives in [src/commentary-channels.mjs](src/commentary-channels.mjs), grouped by section.

Everything here is **commentary**, a category apart from the trust tiers: it never carries a legitimacy rating, never joins a source list, and never counts toward corroboration. Each entry carries the video's title and a short description, lifted from the feed's `media:group > media:description` and cleaned to the one real synopsis sentence — sponsor lines, Patreon rolls, hashtags, and social fragments are skipped; no genuine synopsis → title alone, never an ad.

**On the three news desks (Tech, World, India)** every channel shows its **latest upload — one video per channel, no age cutoff** — in a dedicated **"On the channels · latest video"** block placed high on the page (after the lead and secondary headlines, above the wire columns). On **Esports** the older behavior stands: up to 3 uploads/channel within 7 days, and a video that topically matches a story rides along under that story's byline.

Current roster — every channel ID resolved from its `@handle` page and verified against its feed `<title>` before it's added:

| Desk | Channels |
|------|----------|
| Tech & AI | AI Explained, Yannic Kilcher, Wes Roth, Matt Wolfe, Two Minute Papers, Fireship, David Shapiro |
| Geopolitics | Perun, Zeihan, CaspianReport, Asianometry, Context Matters |
| India | Ravish Kumar, Punya Prasun Bajpai, The Deshbhakt, ThePrint, Satya Hindi, Newslaundry, Sarthak Goswami |
| Esports | the global/India esports commentary channels |

## Frontend — the Miranda broadsheet

The site reads as one edition of a paper, styled to the Miranda reference ("old-world broadsheet on warm cream") in [design/DESIGN.md](design/DESIGN.md) and [design/tokens.json](design/tokens.json). Every color, type, spacing, radius, and shadow value flows from the tokens:

```bash
node scripts/build-tokens.mjs   # design/tokens.json → public/tokens.css
```

Run after editing tokens (the generated `public/tokens.css` is committed).

The furniture: a dateline topbar (edition **No. = day of year**, date, last press run + wire count); a full-width Ink Black **SIGNAL DESK** masthead in Abril Fatface; a section index strip (TECH & AI / WORLD / INDIA / ESPORTS); per-desk ink banners with a one-line standfirst; then an **importance-weighted front page** (below). India runs state-tagged stories as a **From the states** briefs rail; other desks get **In brief**. Esports switches between Global and India editions. Stale data prints a "stale edition" notice; a failed load stops the presses (blackletter "Press Stopped"), never a spinner.

### Importance-weighted layout

A story's footprint scales with an **importance score** computed in `app.js` (`importance()`) purely from signals the pipeline already produces — legitimacy tier, corroboration, a market note, EWC/live status, recency, whether the wire sent real copy; rumors are demoted. `renderBoard()` sorts by that score and assigns slots:

- **Lead well** — the top story: large Abril headline, standfirst, justified body, big stamp, on the one Bone Cream card with the sole sanctioned ink shadow.
- **Secondary row** — the next two, in a two-column ruled row beneath the lead.
- **Column grid** — everything else, below a double-rule fold.
- **Briefs rail** — the thinnest items ("From the states" on India, "In brief" elsewhere).

The same scores map to fewer or more filled slots, so a low-signal day and a big-news day lay out differently.

**The column grid is one shared CSS grid, not separate stacks** — every below-the-fold story is a cell in the same matrix, so cells in a row share a height and hairline rules line up across columns. The rules are a `1px` grid `gap` over an Ink Black backing: each parchment cell covers the backing, the gaps show through as aligned hairlines. `renderBoard()` pads the final row with blank `.story--filler` cells (up to `columnCount() - 1`) so an uneven count never exposes the backing. The grid collapses `3 → 2 → 1` columns in pure CSS at `1024px` / `640px`; `columnCount()` (matchMedia) only sizes the filler padding.

### The page curl (WebGL, Three.js)

Both the section switch and the per-story Opinion card run a real **3D cylindrical page curl** modelled on the Apple Books turn (a true curl can't be faked by transforming a rectangle in CSS). The outgoing face is rasterized to a texture via `modern-screenshot` (it uses the browser's own renderer, so the project's `color-mix()` tokens and web fonts come through — unlike html2canvas, which chokes on them), mapped onto a subdivided `three.js` plane. A custom shader wraps every vertex past a moving curl line around a cylinder (`θ = dist/R`, `x' = curl + R·sinθ`, `z' = R·(1−cosθ)`) whose **radius grows through the turn** (tight corner → loose roll), biases the line by `y` so a **corner lifts first**, and shades from the deformed normal with a specular ridge glint, fold AO, and a darker/warmer verso.

The turn is **direction-signed**: a *later* section curls **forward** (top-right off the left edge); moving **back** mirrors it (top-left off the right edge), and the Opinion card opens forward, closes backward. New content sits live underneath and is revealed as the transparent overlay's sheet rolls away — both faces are the real app, captured only for the ~0.8s motion. The section snapshot is trimmed to the visible viewport first (a full section is ~5000px of DOM; trimming keeps rasterize ~200ms). Under **`prefers-reduced-motion` or no WebGL the curl is skipped**. Vendored, keyless deps in `public/vendor/`; `app.js` loads as an ES module.

### The legitimacy stamp

**Legitimacy prints as a circular rubber stamp**, not a gauge — an inked, distressed press mark (SVG: double ring, arc text, banner word, stars, a `feTurbulence` roughen filter):

| Stamp | Meaning |
|-------|---------|
| **VERIFIED / WIRE** — crisp Ember Orange | High: the page's sanctioned chromatic note |
| **REPORTED** — lighter, partial Ink Black | Medium: single reputable source |
| **UNVERIFIED / RUMOR** — struck-through Ink Black | Low: every rumor/unconfirmed move until a tier-1 source corroborates |
| **COMMENTARY** — neutral grayscale | Deliberately outside the tier system: a category, not a rating |

The one-line reason and source link(s) stay attached to every story — in the lead rail, on Low-trust stories, and always in the stamp's tooltip and accessible label.

### Fonts

**Free substitutes** for the commercial Miranda faces, mapped in `scripts/build-tokens.mjs` (`FONT_SUBS`) so a licensed swap later is one line. Served from Google Fonts — keyless, non-blocking.

| Miranda face | Free substitute | Used for |
|--------------|-----------------|----------|
| Editorial New | **Source Serif 4** (weight 300) | Body copy |
| Canopee | **Abril Fatface** | Masthead, section banners, headlines — kept off body copy, where it turns to mud |
| Domaine Display | **Playfair Display 500** | Standfirsts, pull quotes |
| Germgoth | **Pirata One** | Blackletter, reserved for press-stopped states |

**Google Stitch (MCP) is a design-time aid only**, not a runtime dependency. The deployed frontend stays static and free: every credential-gated call runs server-side in a Netlify function, and no key reaches the browser.

## Retired assets

`public/assets/bg-world.png` / `bg-india.png` and `scripts/generate_map_backgrounds.py` are from the previous dark theme, no longer referenced by the newspaper frontend; kept in case a future theme wants map plates again (regenerate with `py scripts/generate_map_backgrounds.py`, needs Python + matplotlib).
