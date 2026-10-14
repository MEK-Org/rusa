// @vitest-environment node
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, it } from "vitest";
import type { GeminiUsageReport } from "../observability/gemini-usage-report.js";

it("runs the actual logger→JSONL→built CLI report across two real processes and overlapping exports", () => {
  const root = mkdtempSync(join(process.cwd(), ".gemini-usage-proof-"));
  try {
    const emitter = join(root, "emit.ts");
    writeFileSync(
      emitter,
      `
import { configureGeminiUsage, observeGeminiRequest, beginGeminiAttempt, GEMINI_USAGE_PURPOSES } from ${JSON.stringify(join(process.cwd(), "src/observability/gemini-usage.ts"))};
import { createLogger } from ${JSON.stringify(join(process.cwd(), "src/observability/logger.ts"))};
const log = createLogger({ format: "json", level: "info", secrets: ["synthetic-sensitive-value"] });
configureGeminiUsage(log, process.argv[2]);
for (const purpose of GEMINI_USAGE_PURPOSES) await observeGeminiRequest(purpose, "fixture-model", async () => ({ usageMetadata: { promptTokenCount: 100, candidatesTokenCount: 20, thoughtsTokenCount: 5, cachedContentTokenCount: 40, toolUsePromptTokenCount: 2, totalTokenCount: 127 }, text: "PRIVATE BODY" }));
await observeGeminiRequest("quota_parse", "fixture-model", async () => ({}));
try { await observeGeminiRequest("quota_parse", "fixture-model", async () => { throw new Error("PRIVATE ERROR"); }); } catch {}
const partial = beginGeminiAttempt("speech_synthesis", "fixture-model");
partial.observe({ usageMetadata: { promptTokenCount: 50, candidatesTokenCount: 10, thoughtsTokenCount: 2, totalTokenCount: 62 } });
partial.finish("cancelled", true);
log.info("credential_probe", { apiKey: "synthetic-sensitive-value", promptTokenCount: 123, counts: { input: 9 } });
`
    );
    const env = { ...process.env, RUSA_LOG_LEVEL: "info", RUSA_LOG_FORMAT: "json" };
    const buildConfig = join(root, "tsup.config.ts");
    writeFileSync(
      buildConfig,
      `export default { entry: { cli: ${JSON.stringify(join(process.cwd(), "src/cli.ts"))}, emit: ${JSON.stringify(emitter)} }, outDir: ${JSON.stringify(join(root, "dist"))}, format: ["esm"], target: "node20" };`
    );
    execFileSync("pnpm", ["exec", "tsup", "--config", buildConfig, "--silent"], {
      env,
      timeout: 45_000,
      stdio: "pipe",
    });
    const paths = [join(root, "a.jsonl"), join(root, "b.jsonl"), join(root, "overlap.jsonl")];
    const first = execFileSync(
      process.execPath,
      [join(root, "dist/emit.js"), "/synthetic/instance-a"],
      { env, encoding: "utf8", timeout: 10_000 }
    );
    const second = execFileSync(
      process.execPath,
      [join(root, "dist/emit.js"), "/synthetic/instance-b"],
      { env, encoding: "utf8", timeout: 10_000 }
    );
    expect(first).not.toMatch(/PRIVATE BODY|PRIVATE ERROR|synthetic-sensitive-value/);
    expect(JSON.parse(first.trim().split("\n").at(-1) ?? "")).toMatchObject({
      apiKey: "[redacted]",
      promptTokenCount: "[redacted]",
      counts: { input: 9 },
    });
    writeFileSync(paths[0], first);
    writeFileSync(paths[1], second);
    writeFileSync(paths[2], first);
    const args = [
      join(root, "dist/cli.js"),
      "gemini-usage-report",
      ...paths,
      "--from",
      "2000-01-01T00:00:00Z",
      "--to",
      "2099-01-01T00:00:00Z",
      "--gap",
      "earlier rotation unavailable",
      "--json",
    ];
    const report = JSON.parse(
      execFileSync(process.execPath, args, { env, encoding: "utf8", timeout: 10_000 })
    ) as GeminiUsageReport;
    expect(report.instances).toHaveLength(2);
    expect(report.processes).toHaveLength(2);
    expect(report.groups).toHaveLength(11);
    expect(report.duplicates).toBe(14);
    expect(report.knownGaps).toEqual(["earlier rotation unavailable"]);
    expect(report.groups.find((g) => g.purpose === "quota_parse")).toMatchObject({
      calls: 6,
      outcomes: { response: 4, error: 2 },
      coverage: { complete: 2, missing: 4 },
      totals: { input: { sum: 200, measured: 2, missing: 4 }, output: { sum: 50 } },
    });
    expect(report.groups.find((g) => g.purpose === "speech_synthesis")).toMatchObject({
      calls: 4,
      totals: { input: { sum: 200 }, output: { sum: 50 } },
      partialObservations: { input: { sum: 100 }, output: { sum: 24 } },
    });
    expect(report.sources.every((s) => s.logFrom && s.logTo && s.invalidUsage === 0)).toBe(true);
    const textArgs = args.slice(0, -1);
    expect(
      execFileSync(process.execPath, textArgs, { env, encoding: "utf8", timeout: 10_000 })
    ).toContain("Unobserved purposes (not measured zero): none");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}, 75_000);
