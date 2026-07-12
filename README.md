# Signal Desk

A personal news intelligence desk: **Tech & AI · Geopolitics · India · Esports**, each item
scored for legitimacy by rules (no model anywhere in the loop), rendered as a
signals-desk board. Built to run **at zero ongoing cost** on Netlify's free tier —
no paid APIs, no keys, no database.

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
is free and keyless. Optionally, set `TAVILY_API_KEY` + `TAVILY_MONTHLY_CREDITS`
to enable the Tavily discovery layer (see below); leave them unset and it skips
cleanly.

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
right now (the Sports page searches its current edition) via
`netlify/functions/tavily-fetch.mjs` and merges the results into the stored
sweep with the same corroborate-or-new-item semantics. The key stays
server-side. Clicks draw from a shared daily pool (20/day, resets each UTC
day) that also counts against the monthly ledger, so readers can never blow
the cap. When the layer is off (no env vars), the button never appears.

## YouTube commentary (no key needed)

Channel RSS (`youtube.com/feeds/videos.xml?channel_id=…`) fetched exactly like
the other feeds. The channel list lives in
[src/commentary-channels.mjs](src/commentary-channels.mjs), grouped by section —
edit it there; the fetch logic never changes. Everything from this source is
**commentary**, a category apart from the trust tiers: it never carries a
legitimacy rating, never joins a story's source list, and never counts toward
corroboration. A video that topically matches a story rides along under that
story's byline; the rest run as their own stamped COMMENTARY entries. Uploads
older than 7 days don't print (max 3 per channel per sweep). The India slot is
an intentionally empty placeholder.

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
the contents line (TECH & AI / WORLD / INDIA / SPORTS — no "Page One" prefix);
per-desk ink banners with a one-line standfirst; then an **importance-weighted
front page** (see below). India runs state-tagged stories as a **From the
states** briefs rail; other desks get an **In brief** rail. Sports switches
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

### The page flip

Switching sections turns the **whole page** like a bound book (the turn.js /
Apple Books model): a fixed full-viewport stage snapshots the entire outgoing
page — masthead included, offset by the reader's scroll — into a single leaf
hinged on the left spine. The leaf sweeps right-to-left about a slightly tilted
axis so the top-right corner leads, while a curl-shade gradient sweeps across
and a cast shadow rakes the incoming page, so the flat sheet reads as a curving
page. The next section is set on the stand beneath before the turn starts, then
revealed as the sheet lifts away. Transform/opacity only (GPU-composited). It
fires once per switch (and on the Sports edition toggle), never on the already-
open section. Under **`prefers-reduced-motion` the flip is skipped entirely** —
the new section cuts in instantly with no leaf in the DOM.

**Legitimacy prints as a circular rubber stamp**, not a gauge — an inked,
distressed press mark (SVG: double ring, arc text, banner word, stars, a
`feTurbulence` roughen filter). **VERIFIED / WIRE** is a crisp Ember Orange
stamp (the page's sanctioned chromatic note); **REPORTED** is a lighter, partial
Ink Black press (single reputable source); **UNVERIFIED / RUMOR** is a
struck-through Ink Black stamp (double-struck ring + strike line) — how every
rumor and unconfirmed lineup move runs until a tier-1 source corroborates. The
one-line reason and the source link(s) stay attached to every story — printed
in the lead rail and on Low-trust stories, and always in the stamp's tooltip
and accessible label.

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
deployed site stays static, keyless, and free with no environment variables.

## Retired assets

`public/assets/bg-world.png` / `bg-india.png` and
`scripts/generate_map_backgrounds.py` are from the previous dark theme and are
no longer referenced by the newspaper frontend; they're kept in the repo in
case a future theme wants map plates again (regenerate with
`py scripts/generate_map_backgrounds.py`, needs Python + matplotlib).
