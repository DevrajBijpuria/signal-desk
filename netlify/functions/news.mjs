import { getStore } from "@netlify/blobs";

// Hands the stored sweep to the frontend. Page loads never trigger feed
// fetches — this is a single blob read, cached at the edge for 5 minutes.
export default async () => {
  try {
    const store = getStore("news-desk");
    const data = await store.get("latest", { type: "json" });
    if (data) {
      return Response.json(data, {
        headers: { "Cache-Control": "public, max-age=300" },
      });
    }
  } catch (err) {
    console.error("blob read failed:", err.message);
  }
  // No sweep stored yet (fresh deploy before the first cron tick). The
  // frontend falls back to the deploy-time seed at /data/seed.json.
  return Response.json({ status: "empty" }, { status: 404 });
};

export const config = { path: "/api/news" };
