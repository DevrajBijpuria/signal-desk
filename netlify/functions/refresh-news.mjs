import { getStore } from "@netlify/blobs";
import { runPipeline } from "../../src/pipeline.mjs";

// Scheduled sweep: fetch + score everything, store one JSON blob.
// Every source fetch has its own timeout, so a slow feed degrades the sweep
// instead of failing it; worst-case wall time stays under the 30s cap.
export default async () => {
  const data = await runPipeline();
  const store = getStore("news-desk");
  await store.setJSON("latest", data);
  const ok = data.sourceStats.filter((s) => s.ok).length;
  console.log(`sweep stored: ${ok}/${data.sourceStats.length} sources ok in ${data.durationMs}ms`);
  return new Response("ok");
};

export const config = {
  schedule: "0 1,7,13,19 * * *", // four sweeps a day (UTC)
};
