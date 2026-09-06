import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "jsdom",
    include: ["src/**/*.{test,spec}.{ts,tsx}"],
    // worker-prompt.test.ts is a deliberate comment-only tombstone (#179); it has no tests to run.
    exclude: ["**/node_modules/**", "src/v2/runs/**", "src/actor/worker-prompt.test.ts"],
    deps: {
      external: ["open"],
    },
    // Type-check test files alongside running them. The project tsconfig
    // excludes *.test.ts (tests are never compiled), so without this tests
    // are never type-checked at all; tsconfig.test.json re-includes them.
    typecheck: {
      enabled: true,
      include: ["src/**/*.{test,spec}.{ts,tsx}"],
      exclude: ["**/node_modules/**", "src/v2/runs/**"],
      tsconfig: "./tsconfig.test.json",
    },
  },
  resolve: {
    conditions: ["development", "browser"],
  },
});
