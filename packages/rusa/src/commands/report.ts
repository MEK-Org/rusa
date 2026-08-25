import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { generateMeshReport } from "../actor/mesh-report.js";
import { resolveHome } from "../config/index.js";

/**
 * Default output: a gitignored `e2e-reports/` at the repo root, so the report is
 * reachable from an IDE file tree (e.g. a remote/SSH session) rather than buried
 * in the rusa home. Mirrors the e2e runner's report convention.
 */
function defaultReportPath(): string {
  let repoRoot: string;
  try {
    repoRoot = execFileSync("git", ["rev-parse", "--show-toplevel"], { encoding: "utf8" }).trim();
  } catch {
    repoRoot = process.cwd();
  }
  return join(repoRoot, "e2e-reports", "mesh-report.html");
}

/**
 * Build a self-contained HTML report of the actor mesh's activity from its
 * durable artifacts (`threads.json` + the `mesh_events` log). Read-only, so it's
 * safe to run against the live service.
 */
export function runReport(opts?: { home?: string; out?: string }): void {
  const home = opts?.home ?? resolveHome();
  const out = opts?.out ?? defaultReportPath();
  const { outPath, counts } = generateMeshReport({ home, out });
  console.log(
    `✓ Mesh report written to ${outPath}\n  ${counts.actors} actors · ${counts.events} events · ${counts.messages} messages · ${counts.runs} runs`
  );
}
