import { getStore } from "@netlify/blobs";
import { fetchPulseForItem } from "../../src/pulse.mjs";

// Reader-triggered pulse for one story (the per-story Opinion button on the
// World and India desks). The Bluesky credentials never leave the server.
// Bluesky's limits are generous (thousands of requests per 5-minute window),
// so no budget ledger — one click is one search plus one thread read.
//
//   GET  /api/pulse-fetch                     → { enabled }
//   POST /api/pulse-fetch?section=X&id=Y      → matches story Y, stores the
//        pulse back into the blob, returns { pulse }
//        (X ∈ geopolitics | india — the only pulse desks)

const DESKS = new Set(["geopolitics", "india"]);

export default async (req) => {
  const enabled = Boolean(process.env.BLUESKY_HANDLE && process.env.BLUESKY_APP_PASSWORD);
  if (req.method !== "POST") return Response.json({ enabled });
  if (!enabled) {
    return Response.json({ enabled, error: "Bluesky credentials not configured" }, { status: 503 });
  }

  const url = new URL(req.url);
  const section = url.searchParams.get("section");
  const id = url.searchParams.get("id");
  if (!DESKS.has(section) || !id) {
    return Response.json({ enabled, error: "unknown section or story" }, { status: 400 });
  }

  const store = getStore("news-desk");
  const data = await store.get("latest", { type: "json" });
  const item = data?.sections?.[section]?.find((i) => i.id === id);
  if (!item) {
    return Response.json(
      { enabled, error: "story not in the stored sweep — resync and try again" },
      { status: 404 }
    );
  }

  try {
    const pulse = await fetchPulseForItem(item, section);
    await store.setJSON("latest", data); // the fetched pulse rides along for later readers
    return Response.json({ enabled, pulse, opinions: item.opinions ?? [] });
  } catch (err) {
    return Response.json({ enabled, error: `the wire did not answer: ${err.message}` }, { status: 502 });
  }
};

export const config = { path: "/api/pulse-fetch" };
