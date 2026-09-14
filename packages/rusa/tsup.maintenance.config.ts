import { defineConfig } from "tsup";

// Build operator maintenance and quota-evaluation utilities on demand into an
// isolated directory. `build/` is gitignored and outside the npm `files` set,
// so these entries never join the production CLI bundle in `dist/`, and running
// a maintenance script never cleans, rebuilds, or otherwise touches `dist/`
// beside a live service. Mirrors `tsup.follower.config.ts`, `clean` included:
// the output directory is ours alone, so cleaning it each build keeps the
// artifact set exactly the current entry set rather than letting a renamed or
// removed entry stay runnable from a stale bundle.
export default defineConfig({
  entry: {
    "actor/backfill-run-token-records": "src/actor/backfill-run-token-records.ts",
    "mcp/quota-mcp": "src/mcp/quota-mcp.ts",
    "quota/shared-store": "src/quota/shared-store.ts",
  },
  format: ["esm"],
  target: "node20",
  outDir: "build/maintenance",
  clean: true,
  sourcemap: true,
});
