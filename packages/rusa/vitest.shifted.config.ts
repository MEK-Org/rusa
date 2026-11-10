import { defineConfig } from "vitest/config";
import baseConfig from "./vitest.config";

// Second-suite config for the shifted-clock Checks run (#1218): the
// retention/expiry-owning test surface (the include list below; the Checks
// workflow step names the same scope) run with Date faked 45 days ahead of
// the real clock via the shifted-clock setup file.
//
// Duration & scoping rationale (#1218 / PR #1219 review):
// - The full suite (404 test files) takes ~3m 47s in Checks. Running all 404
//   files twice would add ~3m 47s, nearly doubling total CI time (~4m 40s).
//   The scoped 51-file suite covers every audited retention and expiry window
//   in ~40s (~17% of full suite time), keeping CI responsive.
// - Excluding non-retention suites also prevents false failures where code
//   compares in-process JS `Date` against OS kernel timestamps (e.g. `fs.stat().mtime`,
//   SQLite DB cache file mtimes, or git commit timestamps created by child
//   processes), which use the real system clock and desync by 45 days against
//   a faked in-process JS `Date`.
//
// Typecheck already ran with the ordinary suite; this pass is behavioral only.
export default defineConfig({
  ...baseConfig,
  test: {
    ...baseConfig.test,
    // Replaces the base include (object spread, not a merge): only the
    // retention/expiry-owning files run shifted.
    include: [
      // Quota retention (30d raw + observations, 7d weekly, 3d history,
      // 30m probe TTL), pacing, and missed-window logic.
      "src/quota/**/*.test.ts",
      // Quota probe TTL and pacing; 15-minute stamp expiry; 7-day timing
      // retention boundary.
      "src/mcp/quota-mcp.test.ts",
      "src/mcp/stamp.test.ts",
      "src/mcp/dashboard-timing-mcp.test.ts",
      // Weekly quota pacing, dashboard session (5d), 7-day timing
      // retention.
      "src/dashboard/quota-api.test.ts",
      "src/dashboard/auth.test.ts",
      "src/dashboard/timing.test.ts",
      "src/dashboard/timing-phases.test.ts",
      "src/dashboard/timing-server.test.ts",
      "src/dashboard/timing-http.test.ts",
      // Weekly pacer window, 30-minute quota age, availability-hold expiry,
      // and 7d hard runtime cap.
      "src/actor/provider-pacer.test.ts",
      "src/actor/availability-holds*.test.ts",
      "src/actor/host-job-runner.test.ts",
      // 30-day run prompt retention.
      "src/db/repositories/run-prompt-repository.test.ts",
      // 30-day run material retention, event-transfer staging expiry.
      "src/remote-instances/run-material*.test.ts",
      "src/remote-instances/follower-event-transfer.test.ts",
      // 1-day model-catalog cache age, memoization TTLs, Slack retry/cooldown
      // windows, 7-day gemini usage report windows, quota commands, 30d
      // config docs retention default, and the pinned-clock helper itself.
      "src/providers/model-catalog.test.ts",
      "src/references/**/*.test.ts",
      "src/slack/**/*.test.ts",
      "src/observability/**/*.test.ts",
      "src/commands/quota-*.test.ts",
      "src/commands/config-docs.test.ts",
      "src/providers/test-support/**/*.test.ts",
    ],
    setupFiles: ["src/providers/test-support/shifted-clock.ts"],
    typecheck: { enabled: false },
  },
});
