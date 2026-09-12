import { defineConfig } from "tsup";

// Build one-time or operator maintenance scripts on demand without bundling
// them into the production CLI or distribution entry set.
export default defineConfig({
  entry: {
    "actor/backfill-run-token-records": "src/actor/backfill-run-token-records.ts",
  },
  format: ["esm"],
  target: "node20",
  outDir: "dist",
  clean: false,
  sourcemap: true,
});
