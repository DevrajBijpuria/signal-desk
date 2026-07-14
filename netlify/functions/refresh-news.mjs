import { getStore } from "@netlify/blobs";
import { runPipeline } from "../../src/pipeline.mjs";
import { enrichWithPulse } from "../../src/pulse.mjs";

// Scheduled sweep: fetch + score everything, store one JSON blob.
// Every source fetch has its own timeout, so a slow feed degrades the sweep
// instead of failing it; worst-case wall time stays under the 30s cap.
export default async () => {
  const store = getStore("news-desk");

  // Previous sweep's pulse matches, keyed by item id: an already-matched
  // story re-fetches its stored post/video directly instead of re-searching
  // (which matters most for YouTube's scarce search bucket). Both the array
  // shape and the legacy single-object shape ride through; pulse.mjs
  // normalizes.
  const prevPulse = new Map();
  try {
    const prev = await store.get("latest", { type: "json" });
    for (const section of ["geopolitics", "india"]) {
      for (const item of prev?.sections?.[section] ?? []) {
        const entries = Array.isArray(item.pulse) ? item.pulse : item.pulse?.found ? [item.pulse] : [];
        if (entries.length) prevPulse.set(item.id, entries);
      }
    }
  } catch { /* no previous sweep — every match starts from search */ }

  const data = await runPipeline();

  // Public Pulse: World and India only, after scoring, before the blob write.
  // Tech & AI and Esports pass through untouched. Degrades, never fails.
  await Promise.all([
    enrichWithPulse(data.sections.geopolitics, "geopolitics", data.sourceStats, prevPulse),
    enrichWithPulse(data.sections.india, "india", data.sourceStats, prevPulse),
  ]);

  await store.setJSON("latest", data);
  const ok = data.sourceStats.filter((s) => s.ok).length;
  console.log(`sweep stored: ${ok}/${data.sourceStats.length} sources ok in ${data.durationMs}ms`);
  return new Response("ok");
};

export const config = {
  schedule: "0 1,7,13,19 * * *", // four sweeps a day (UTC)
};
