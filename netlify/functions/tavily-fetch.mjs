import { getStore } from "@netlify/blobs";
import { readLedger, manualRemaining, runSectionQuery, MANUAL_DAILY_CAP } from "../../src/tavily.mjs";
import { mergeManualDiscovery } from "../../src/pipeline.mjs";

// Reader-triggered Tavily search, one section per click. The API key never
// leaves the server. Spend draws from a shared daily pool (MANUAL_DAILY_CAP,
// resets each UTC day) AND the same monthly ledger as the scheduled sweeps,
// so the 90% budget cap holds regardless of clicks.
//
//   GET  /api/tavily-fetch            → { enabled, remaining, cap }
//   POST /api/tavily-fetch?section=X  → runs X's query, merges into the stored
//        sweep, returns the updated section (X ∈ tech | geopolitics | india |
//        esportsGlobal | esportsIndia)

const SECTIONS = new Set(["tech", "geopolitics", "india", "esportsGlobal", "esportsIndia"]);

export default async (req) => {
  const apiKey = process.env.TAVILY_API_KEY;
  const ceiling = Number(process.env.TAVILY_MONTHLY_CREDITS);
  if (!apiKey || !Number.isFinite(ceiling) || ceiling <= 0) {
    return Response.json({ enabled: false }); // feature off — the button never shows
  }

  const store = getStore("news-desk");
  const ledger = await readLedger(store);
  const remaining = manualRemaining(ledger, ceiling);

  if (req.method !== "POST") {
    return Response.json({ enabled: true, remaining, cap: MANUAL_DAILY_CAP });
  }

  const section = new URL(req.url).searchParams.get("section");
  if (!SECTIONS.has(section)) {
    return Response.json({ enabled: true, remaining, error: "unknown section" }, { status: 400 });
  }
  if (remaining <= 0) {
    return Response.json(
      { enabled: true, remaining: 0, error: "today's wire-search allowance is spent" },
      { status: 429 }
    );
  }
  const data = await store.get("latest", { type: "json" });
  if (!data) {
    return Response.json(
      { enabled: true, remaining, error: "no stored sweep yet — wait for the first press run" },
      { status: 409 }
    );
  }

  // Attempted = spent, success or failure — persist before the request so a
  // crash can never under-count.
  ledger.creditsUsed += 1;
  ledger.manualUsed += 1;
  await store.setJSON("tavily-usage", ledger);
  const left = manualRemaining(ledger, ceiling);

  let discovered;
  try {
    discovered = await runSectionQuery(apiKey, section);
  } catch (err) {
    return Response.json(
      { enabled: true, remaining: left, error: `wire search failed: ${err.message}` },
      { status: 502 }
    );
  }

  const { added, corroborated } = mergeManualDiscovery(data.sections, section, discovered);
  if (added || corroborated) await store.setJSON("latest", data);

  const key = section.startsWith("esports") ? "esports" : section;
  return Response.json({
    enabled: true,
    remaining: left,
    added,
    corroborated,
    sectionKey: key,
    items: data.sections[key],
  });
};

export const config = { path: "/api/tavily-fetch" };
