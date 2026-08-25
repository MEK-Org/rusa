import { defineConfig } from "tsup";

// Output dir is overridable via RUSA_DIST_DIR so the `update` tool  can
// build into a STAGING dir (`dist.new`), leaving the live `dist/` untouched until an
// atomic swap on a green build. Unset (CI/dev) → the normal `dist`.
const outDir = process.env.RUSA_DIST_DIR ?? "dist";

export default defineConfig({
  entry: ["src/cli.ts", "src/commands/e2e.cli.ts"],
  format: ["esm"],
  target: "node20",
  outDir,
  // Dev CLI/E2E commands run tsup without rebuilding Flutter. Cleaning all of
  // dist would delete their existing dashboard-ui-app, so those commands opt out.
  // Long term, separate code/static output dirs or clean only tsup-owned files.
  clean: process.env.RUSA_TSUP_PRESERVE_DIST !== "1",
  sourcemap: true,
  banner: {
    js: "#!/usr/bin/env node",
  },
});
