import { readdirSync, readFileSync } from "node:fs";
import { dirname, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  type ConsoleBudgetPolicy,
  type ConsoleUsage,
  countConsoleCalls,
  evaluateConsoleBudget,
  formatConsoleBudgetFailure,
  formatConsoleBudgetRatchet,
  stripNonCode,
} from "./console-budget.js";

/**
 * The gate itself, and then the gate applied to this tree. The unit tests fix
 * what counts as a call site; the enforcement test is the thing that actually
 * fails a pull request that adds a new direct console diagnostic.
 */

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const policy = JSON.parse(
  readFileSync(resolve(packageRoot, "console-budget.json"), "utf8")
) as ConsoleBudgetPolicy;

/** Every production source file, as a path relative to the package root. */
function scanProductionSources(): ConsoleUsage[] {
  const srcRoot = resolve(packageRoot, "src");
  const usage: ConsoleUsage[] = [];
  for (const entry of readdirSync(srcRoot, { recursive: true, withFileTypes: true })) {
    if (!entry.isFile()) continue;
    if (!/\.tsx?$/.test(entry.name)) continue;
    if (/\.(test|spec)\.tsx?$/.test(entry.name)) continue;
    const absolute = resolve(entry.parentPath, entry.name);
    const file = relative(packageRoot, absolute).split(sep).join("/");
    // Excluded from the compiled build, so not production code.
    if (file.startsWith("src/v2/runs/")) continue;
    const count = countConsoleCalls(readFileSync(absolute, "utf8"));
    if (count > 0) usage.push({ file, count });
  }
  return usage;
}

describe("countConsoleCalls", () => {
  it("counts each console method call once", () => {
    expect(countConsoleCalls("console.log('a'); console.error('b');\nconsole.warn('c');")).toBe(3);
  });

  it("counts a call spread across lines or spaced out", () => {
    expect(countConsoleCalls("console\n  .log(\n  'a'\n);")).toBe(1);
    expect(countConsoleCalls("console . error('a');")).toBe(1);
  });

  it("ignores a mention of console.log in a comment", () => {
    expect(countConsoleCalls("// migrate this console.log to the logger\nconst x = 1;")).toBe(0);
    expect(countConsoleCalls("/**\n * Replaces console.warn.\n */\nconst x = 1;")).toBe(0);
  });

  it("ignores console.log inside a string or template literal", () => {
    expect(countConsoleCalls("const src = 'console.log(1)';")).toBe(0);
    // biome-ignore lint/suspicious/noTemplateCurlyInString: the fixture is source text, not an interpolation.
    expect(countConsoleCalls("const src = `console.log(${x})`;")).toBe(0);
  });

  it("does not read a URL in a string as the start of a comment", () => {
    expect(countConsoleCalls('const u = "https://example.test"; console.log(u);')).toBe(1);
  });

  it("does not let a regular expression swallow the code after it", () => {
    expect(countConsoleCalls("const q = /[\"']/g;\nconsole.log(q);")).toBe(1);
    expect(countConsoleCalls("const c = a / b; console.log(c);")).toBe(1);
  });

  it("does not count a property that merely ends in console", () => {
    expect(countConsoleCalls("deps.console.log('a'); myconsole.log('b');")).toBe(0);
  });

  it("keeps line positions intact so a stripped file still lines up", () => {
    expect(stripNonCode("const a = 1;\n// gone\nconsole.log(a);").split("\n")).toHaveLength(3);
  });
});

describe("evaluateConsoleBudget", () => {
  const fixture: ConsoleBudgetPolicy = {
    allowlist: ["src/commands/init.ts"],
    budgets: { "src/gitops/worktree.ts": 7 },
  };

  it("passes a file that stayed at its budget", () => {
    expect(evaluateConsoleBudget([{ file: "src/gitops/worktree.ts", count: 7 }], fixture)).toEqual({
      violations: [],
      ratchets: [],
    });
  });

  it("flags a file that gained a console call", () => {
    const result = evaluateConsoleBudget([{ file: "src/gitops/worktree.ts", count: 8 }], fixture);

    expect(result.violations).toEqual([{ file: "src/gitops/worktree.ts", count: 8, budget: 7 }]);
    expect(formatConsoleBudgetFailure(result)).toContain("src/gitops/worktree.ts: 8");
    expect(formatConsoleBudgetFailure(result)).toContain("docs/logging.md");
  });

  it("flags a file with no budget at all, so a new module cannot start one", () => {
    expect(
      evaluateConsoleBudget([{ file: "src/observability/new-thing.ts", count: 1 }], fixture)
        .violations
    ).toEqual([{ file: "src/observability/new-thing.ts", count: 1, budget: 0 }]);
  });

  it("leaves an allowlisted CLI command unrestricted", () => {
    const result = evaluateConsoleBudget(
      [
        { file: "src/commands/init.ts", count: 40 },
        { file: "src/gitops/worktree.ts", count: 7 },
      ],
      fixture
    );

    expect(result).toEqual({ violations: [], ratchets: [] });
  });

  it("reports a migration as a ratchet, with the number to write down", () => {
    const result = evaluateConsoleBudget([{ file: "src/gitops/worktree.ts", count: 2 }], fixture);

    expect(result.ratchets).toEqual([{ file: "src/gitops/worktree.ts", count: 2, budget: 7 }]);
    expect(formatConsoleBudgetRatchet(result)).toContain("src/gitops/worktree.ts: 7 -> 2");
  });

  it("reports a fully migrated or deleted file as a ratchet to remove", () => {
    const result = evaluateConsoleBudget([], fixture);

    expect(result.ratchets).toEqual([{ file: "src/gitops/worktree.ts", count: 0, budget: 7 }]);
    expect(formatConsoleBudgetRatchet(result)).toContain("src/gitops/worktree.ts: 7 -> (remove)");
  });
});

describe("the tree's console budget", () => {
  const result = evaluateConsoleBudget(scanProductionSources(), policy);

  it("has no file above its budget — new diagnostics go through the logger", () => {
    expect(result.violations.length === 0 || formatConsoleBudgetFailure(result)).toBe(true);
  });

  it("has a baseline that matches the tree, so a migration cannot be undone", () => {
    expect(result.ratchets.length === 0 || formatConsoleBudgetRatchet(result)).toBe(true);
  });

  it("names every allowlisted file as an interactive command, not a library", () => {
    for (const file of policy.allowlist) {
      expect(file.startsWith("src/commands/") || file.startsWith("src/e2e/")).toBe(true);
    }
  });

  it("gives the logging modules themselves no console allowance", () => {
    const own = [
      "src/observability/logger.ts",
      "src/observability/log-secrets.ts",
      "src/observability/actor-output-sink.ts",
      "src/observability/console-budget.ts",
    ];

    for (const file of own) {
      expect(policy.budgets[file]).toBeUndefined();
      expect(policy.allowlist).not.toContain(file);
    }
  });
});
