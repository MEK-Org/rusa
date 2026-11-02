import { defineConfig } from "vitest/config";
import baseConfig from "./vitest.config";

// Second-suite config for the shifted-clock Checks run (#1218): the
// retention/expiry-owning test surface (the include list below; the Checks
// workflow step names the same scope) run with Date faked 45 days ahead of
// the real clock via the shifted-clock setup file. The scope keeps the run
// bounded instead of doubling suite time and excludes suites whose
// assertions sit on OS-level clocks or mtimes, which any fake Date breaks
// independent of the shift (verified with a one-minute probe). Typecheck
// already ran with the ordinary suite; this pass is behavioral only.
export default defineConfig({
  ...baseConfig,
  test: {
    ...baseConfig.test,
    // Replaces the base include (object spread, not a merge): only the
    // retention/expiry-owning files run shifted.
    include: [
      // Quota retention (30d raw + observations, 7d weekly, 3d history,
      // 30m probe TTL, sprint expiry), pacing, and missed-window logic.
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
      // Weekly pacer window, 30-minute quota age, availability-hold expiry.
      "src/actor/provider-pacer.test.ts",
      "src/actor/availability-holds*.test.ts",
      // 30-day run prompt retention.
      "src/db/repositories/run-prompt-repository.test.ts",
      // 30-day run material retention, event-transfer staging expiry.
      "src/remote-instances/run-material*.test.ts",
      "src/remote-instances/follower-event-transfer.test.ts",
      // 1-day model-catalog cache age, memoization TTLs, Slack retry/cooldown
      // windows, 7-day gemini usage report windows, quota commands, and the
      // pinned-clock helper itself.
      "src/providers/model-catalog.test.ts",
      "src/references/**/*.test.ts",
      "src/slack/**/*.test.ts",
      "src/observability/**/*.test.ts",
      "src/commands/quota-*.test.ts",
      "src/providers/test-support/**/*.test.ts",
    ],
    setupFiles: ["src/providers/test-support/shifted-clock.ts"],
    typecheck: { enabled: false },
  },
});
