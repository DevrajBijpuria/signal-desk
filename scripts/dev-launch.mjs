// Single entry point for .claude/launch.json: refresh public/data/seed.json
// (the same pipeline as `npm run pipeline`), then start the static server.
// Combines the two steps that were previously run separately (the
// "Run pipeline once" VS Code task, then the launch config).
import { spawnSync, spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const onWindows = process.platform === "win32";

console.log("[dev-launch] Running the pipeline to refresh public/data/seed.json...");
const pipeline = spawnSync(process.execPath, ["scripts/run-pipeline.mjs"], {
  cwd: root,
  stdio: "inherit",
});
if (pipeline.status !== 0) {
  console.error("[dev-launch] Pipeline run failed — serving the existing seed.json as-is.");
}

console.log("\n[dev-launch] Starting the static server on :8899...");
// Windows needs shell:true to resolve npx's .cmd shim; folding the fixed
// (non-user-supplied) args into one string avoids Node's DEP0190 warning,
// which only fires when shell:true is paired with a separate args array.
const serve = onWindows
  ? spawn("npx serve public -l 8899", [], { cwd: root, stdio: "inherit", shell: true })
  : spawn("npx", ["serve", "public", "-l", "8899"], { cwd: root, stdio: "inherit" });

const shutdown = () => { serve.kill(); process.exit(0); };
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
serve.on("exit", (code) => process.exit(code ?? 0));
