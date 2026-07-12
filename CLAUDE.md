# CLAUDE.md — Signal Desk project context

Load this at the start of any chat about this project. It captures the non-obvious
knowledge; [README.md](README.md) has the full how-it-works, and the design source
of truth is [design/DESIGN.md](design/DESIGN.md) + [design/tokens.json](design/tokens.json).

## What this is

**Signal Desk** — a personal news-intelligence desk for one reader (a final-year CS
student heading into ML / data engineering; it's the only news they read). Four
sections — **Tech & AI · Geopolitics (World) · India · Esports (Sports)** — each
item **rule-scored for legitimacy** (no model anywhere in the loop) and rendered as
an 1890s broadsheet newspaper (the "Miranda" theme).

**Two hard constraints that override any convenience:**
1. **Zero ongoing cost** — no paid APIs, no keys, no database, everything on
   Netlify's free tier. No required environment variables. (Tavily discovery is
   the one env-gated optional: `TAVILY_API_KEY` + `TAVILY_MONTHLY_CREDITS`, never
   hardcoded, skips cleanly when unset.)
2. **Legitimacy scoring stays rule-based** — a source-tier map + corroboration
   bump, never an LLM call.

Status: built and runs end-to-end locally; **not yet deployed**.

## Architecture (do not re-derive)

```
Scheduled Netlify function (cron 4×/day)  →  fetch + dedupe + score + tag
        └─ netlify/functions/refresh-news.mjs
                        │  writes one JSON blob "latest"
                        ▼
              Netlify Blobs  ──►  GET /api/news (serving fn)  ──►  public/ static frontend
                                   (falls back to public/data/seed.json,
                                    written at deploy time by the build command)
```

- **Page loads never fetch a feed** — they read the stored sweep. Instant, free per visitor.
- Every source fetch has its own timeout; a slow/dead feed **degrades** the sweep, never fails it. Whole run must stay under Netlify's **30s** scheduled-function cap.
- The build command (`node scripts/run-pipeline.mjs`) writes `public/data/seed.json` so a fresh deploy has data before the first cron tick.

## Key files

| Path | Role |
|------|------|
| `src/pipeline.mjs` | Orchestrates the sweep: feed list, section builders, dedupe, scoring, tagging. **The FEEDS object is the source list.** |
| `src/feeds.mjs` | RSS/Atom fetch + parse (fast-xml-parser); strips emoji from titles. |
| `src/scoring.mjs` | The tier map + High/Med/Low + corroboration bump. **Extend the tier map here when adding sources.** |
| `src/esports.mjs` | Liquipedia scraping (one spaced queue, budgeted), EWC pages, Dexerto/DotEsports rumor layer. `LP_UA` holds the contact email. |
| `src/tavily.mjs` | Optional Tavily discovery: 5 fixed queries/run (basic depth), env-gated, Blobs budget ledger (`tavily-usage`) capped at 90% of the monthly plan, allowance spread over days left in the month. Results enter the normal dedupe+score path. |
| `src/commentary.mjs` + `src/commentary-channels.mjs` | YouTube channel-RSS commentary layer. **The channel list lives in commentary-channels.mjs — edit there only.** Commentary sits outside the trust tiers: attached post-scoring (`item.commentary[]` on a matched story, `kind:"commentary"` standalone), never corroborates, never stamped High/Med/Low. |
| `netlify/functions/refresh-news.mjs` | The scheduled sweep. Cron in `export const config`. |
| `scripts/run-pipeline.mjs` | Runs the pipeline once → `public/data/seed.json` (used by `npm run pipeline` and the build). |
| `scripts/build-tokens.mjs` | `design/tokens.json` → `public/tokens.css`. **`FONT_SUBS` maps commercial faces → free Google Fonts.** Re-run after editing tokens. |
| `public/index.html` / `styles.css` / `app.js` | The static frontend. `tokens.css` is generated — don't hand-edit it. |
| `design/DESIGN.md` + `design/tokens.json` | Miranda design system — the visual source of truth. |

## Data layer — DO NOT TOUCH unless asked

The pipeline, source list, scoring, dedupe, EWC coverage, and rumor handling are
settled and verified. Frontend re-themes should leave `src/**` and
`netlify/functions/**` alone.

### Feed quirks (verified by live probing — don't rediscover the hard way)

- **Reuters / AP have no public RSS.** Fetched via Google News RSS scoped to
  `site:reuters.com/world` and `site:apnews.com "world news"`; the `<source>` tag
  preserves the real outlet domain for tier scoring. Plain keyword "world" pulls in
  "World Cup" (sports pollution) — the query is deliberately scoped.
- **PIB's own RSS serves Hindi with no dates** regardless of the Lang param → use
  Google News `site:pib.gov.in`. PIB gets a reserved quota so the dailies can't
  crowd government releases out.
- **GDELT** connection-resets from this user's home network (works elsewhere);
  pipeline tolerates via per-fetch timeout. **UN News RSS currently 404s.** Both
  show up as failed wires in the header count — that's correct behavior.
- **Liquipedia** rate-limits (HTTP 429) after a day of dev sweeps; all its calls
  share one ~2s-spaced queue with a hard time budget, and a start-cutoff so a
  hanging request can't push the function past 30s. Main-page markup differs per
  wiki (valorant/cs/dota use `tournaments-list-heading`; pubgmobile uses
  `tournaments-list-item` + toggle areas, and `data-filter-category="bgmi"` marks
  India-only events that drive the India toggle).
- **Rumors:** anything from Dexerto/DotEsports with rumor markers ("reportedly",
  "in talks", "sources say", …) is tagged **Rumor** and force-scored **Low** until a
  tier-1 source corroborates.
- **YouTube channel RSS** (`youtube.com/feeds/videos.xml?channel_id={ID}`) parses
  fine through the existing Atom path — no key, no quirks. But **resolving a
  @handle to its ID needs `"externalId"`** from the handle page's source; the first
  `"channelId"` hit can belong to a *related* channel (this bit both Perun and
  CaspianReport during setup — always verify the ID against its feed `<title>`).
  **AFK Gaming's channel is dormant** (main: nothing since 2022; "Global": Mar 2025),
  so Esports-India commentary is legitimately empty until they upload again.
- **Tavily runs in parallel with the section builders** (a shared promise each
  builder awaits), never serially before them — serial would stack ~8s on the 24s
  esports budget and threaten the 30s cap. Attempted requests count as spent,
  success or failure. Live-verified 2026-07-12: ~0.8–2.7s per basic query, five
  concurrent is fine. Quirk: the **first** sweep after a fresh `netlify dev` start
  can abort all five at the 8s timeout (cold-start artifact of the local runner —
  direct API calls are fast); the retry runs clean. Those aborted calls still
  count as spent — correct, conservative.

## Frontend — the Miranda broadsheet

Full details in [README.md](README.md#frontend--the-miranda-broadsheet). The essentials:

- **Design source of truth is the tokens.** All color/type/spacing/radius/shadow
  come from `public/tokens.css` (generated from `design/tokens.json`). Palette:
  parchment `#e2dedb` page, bone-cream `#cdc6be` cards, ink `#1d1d1b` text/banners,
  **ember `#c03f13` is the ONLY chromatic accent** (stamps + two active-marker
  stars — nowhere else). No gradients/blur, radius ≤ 12px, shadows only the one
  directional ink shadow on the lead card.
- **Fonts are free substitutes** behind CSS vars (`FONT_SUBS` in
  `scripts/build-tokens.mjs`), so a licensed swap later is one line:
  Editorial New → **Source Serif 4** (body, wt 300); Canopee → **Abril Fatface**
  (masthead, section banners, headlines — display only, mud at body sizes);
  Domaine Display → **Playfair Display 500** (standfirsts, pull quotes);
  Germgoth → **Pirata One** (blackletter, only for "Press Stopped" state).
- **Contrast gotcha:** token Charcoal `#69645f` fails 4.5:1 at caption sizes on both
  paper surfaces. Small-caps furniture uses `--color-charcoal-print`
  (`color-mix(45% charcoal / 55% ink)`). **Never put Charcoal on small text** —
  borders/rules only.
- **Masthead sizing:** the banner font-size is fitted to the page width by
  `fitBanner()` in `app.js` (CSS clamp is only a fallback), or "SIGNAL DESK" clips.
- **Importance-weighted front page** (`importance()` + `renderBoard()` in `app.js`):
  score from EXISTING signals only → lead well / secondary row / **one shared column
  grid** / briefs rail. The column grid is a single CSS grid (not separate stacks):
  `1px` gap over an ink backing draws aligned hairline rules; the last row is padded
  with `.story--filler` parchment cells so no empty cell shows ink; collapses
  3→2→1 in pure CSS (never overflows). `columnCount()` only sizes the filler padding.
- **Legitimacy = circular rubber stamp** (inline SVG, `feTurbulence` distress):
  **VERIFIED/WIRE** = ember (High), **REPORTED** = partial ink (Medium),
  **UNVERIFIED/RUMOR** = struck ink (Low). Reason + source links stay attached to
  every story (in the lead rail, on Low stories, and always in the stamp's
  `title` + `aria-label`).
- **Page flip** (`flipToNewPage()` in `app.js`): switching sections turns the whole
  viewport like a bound book (turn.js / Apple Books model) — full-viewport
  `.flip-stage` snapshots the whole page incl. masthead (scroll-offset) into one
  `.leaf` hinged on the left spine, sweeps with a curl-shade + cast shadow. Fires
  once per switch (and the Sports edition toggle), never on the active section.
  **Under `prefers-reduced-motion` it's skipped — instant cut.**

## Local dev

```bash
npm install                # netlify-cli is a devDependency; nothing else to set up
npm run pipeline           # run the sweep once → public/data/seed.json
npm run dev                # netlify dev on http://localhost:8888  (VS Code: Ctrl+Shift+B)
curl -X POST http://localhost:8888/.netlify/functions/refresh-news   # sweep into local blob (dev only)
node scripts/build-tokens.mjs   # regenerate tokens.css after editing design/tokens.json
```

Windows shell is PowerShell; a Bash tool is also available. Prefer writing `.mjs`
scripts to a scratch dir over long inline `node -e` (PowerShell mangles quotes/`[`).

## Environment gotchas that have burned time

- **The in-app preview pane FREEZES the animation timeline.**
  `document.timeline.currentTime` does not advance (verified), so CSS animations
  read as their frame-0 identity even though `getAnimations()` reports "running",
  and `preview` **screenshots hang / time out**. The pane also doesn't reliably fire
  `resize` / `ResizeObserver` callbacks on programmatic resize. **Consequence:** you
  cannot visually verify the page-flip motion or resize-driven re-renders in this
  pane — verify structure via `javascript_tool` (DOM, computed styles, getAnimations)
  and confirm motion in a real browser. Don't chase these as code bugs.
- Use `javascript_tool` evals for verification; keep them short (long promises can
  hit the 30s eval timeout). `read_page` (a11y tree) works when screenshots don't.
- **Design verification** the briefs ask for uses a fresh-context subagent driving
  real headless Chrome (agent-browser skill) — that DOES see animations. Note:
  `ui-ux-pro-max` is **not installed** on this machine; its checklist items are
  applied manually. Cold-verifier subagents have repeatedly died on **session
  limits** mid-run — the v4 (newspaper-refinements) design-verification pass is
  still **owed**.

## Build history (newest first)

- **v4** (current) — newspaper format: Abril Fatface display face, importance-weighted
  front page, aligned shared-grid columns, circular rubber-stamp legitimacy,
  full-page book-flip on section change, dropped "PAGE ONE —" prefix.
- **v3** — re-themed dark "Slash" → light "Miranda" broadsheet (tokens-driven).
- **v2** — "Slash" dark-fintech theme (superseded).
- **v1** — original signals-desk board.

Retired but kept in repo: `public/assets/bg-*.png` and
`scripts/generate_map_backgrounds.py` (Slash-era map plates, unused by the newspaper).

## How to work here

- Autonomous: act on reversible changes that follow from the request; don't block on
  "want me to…?". Give a recommendation, not a survey.
- Scope discipline: change only what's asked. Don't refactor the data layer or add
  abstractions. Validate only at real boundaries (feed fetch, stored JSON, user input).
- Be honest in progress reports: if the flip is untested-in-pane, a feed failed, or a
  section is wired but unverified, say so plainly with the evidence.
