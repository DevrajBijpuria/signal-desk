// Runs the same pipeline as the scheduled function and writes the result to
// public/data/seed.json. Used two ways:
//   - locally: `npm run pipeline` to exercise the whole pipeline end to end
//   - on Netlify: the build command, so a fresh deploy has data before the
//     first cron tick (the frontend falls back to this file if the blob is empty)
import { mkdirSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { runPipeline } from "../src/pipeline.mjs";

const data = await runPipeline();

const outDir = fileURLToPath(new URL("../public/data/", import.meta.url));
mkdirSync(outDir, { recursive: true });
writeFileSync(outDir + "seed.json", JSON.stringify(data, null, 1));

console.log(`\npipeline finished in ${data.durationMs}ms`);
console.log("source            ok   items  ms     error");
for (const s of data.sourceStats) {
  console.log(
    `${s.id.padEnd(18)}${s.ok ? "yes" : "NO "}  ${String(s.items ?? "-").padEnd(6)} ${String(s.ms ?? "-").padEnd(6)} ${s.error ?? ""}`
  );
}
for (const [name, items] of Object.entries(data.sections)) {
  console.log(`\n[${name}] ${items.length} items`);
  for (const it of items.slice(0, 3)) {
    console.log(`  · ${it.title.slice(0, 90)}`);
    console.log(it.kind === "commentary"
      ? `    commentary — ${it.sources[0]?.name} (outside the trust tiers)`
      : `    trust=${it.trust.level} — ${it.trust.reason}`);
    if (it.market) console.log(`    market: ${it.market.assets} (${it.market.direction}) — ${it.market.note}`);
  }
}
