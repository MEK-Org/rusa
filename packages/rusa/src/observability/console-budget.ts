/**
 * The mechanical non-increase gate for direct `console.*` diagnostics.
 *
 * Rusa carries a large backlog of direct console calls, and #177 deliberately
 * does not clear it in one change. What it does do is stop the backlog growing:
 * a file may keep the call sites it already had, and may only ever have fewer.
 * A new diagnostic goes through the application logger.
 *
 * Interactive commands are the exception, and an explicit one. A command whose
 * printed output *is* its contract with a human keeps writing to the console and
 * is named on the policy's allowlist — reviewing that list is how the exception
 * stays deliberate.
 */

import ts from "typescript";

/** How the gate treats each production source file. */
export interface ConsoleBudgetPolicy {
  /**
   * Files whose console output is the interactive contract of a CLI command.
   * Console calls in these files are unrestricted and unreviewed by this gate.
   */
  allowlist: readonly string[];
  /**
   * Pre-existing diagnostic call sites per file. A count may fall — that is a
   * migration — but never rise. A file on neither list has a budget of zero.
   */
  budgets: Readonly<Record<string, number>>;
}

/** Console call sites counted in one file. */
export interface ConsoleUsage {
  file: string;
  count: number;
}

/** A file whose count no longer matches its budget. */
export interface ConsoleBudgetViolation extends ConsoleUsage {
  budget: number;
}

export interface ConsoleBudgetResult {
  /** Files over budget. A non-empty list fails the gate. */
  violations: ConsoleBudgetViolation[];
  /** Files now under budget — lower the baseline to lock the migration in. */
  ratchets: ConsoleBudgetViolation[];
}

/**
 * Count direct `console.*` call sites in one file's source.
 *
 * The count comes off the TypeScript AST. `typescript` is already a dependency,
 * and parsing settles by construction what a text scan has to keep guessing at:
 * a `console.log` written inside a comment, a string, a template literal or a
 * regular expression never becomes a node, so it cannot be counted, and no
 * regex-versus-division heuristic has to be maintained to keep that true.
 *
 * `console["log"]` counts too — a bracket is not a way around the gate.
 *
 * `fileName` only picks the dialect to parse as; pass the real path so a `.tsx`
 * file is read as TSX rather than as TypeScript.
 */
export function countConsoleCalls(source: string, fileName = "scan.ts"): number {
  const parsed = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, false);
  let count = 0;
  const visit = (node: ts.Node): void => {
    if (
      (ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node)) &&
      ts.isIdentifier(node.expression) &&
      node.expression.text === "console"
    ) {
      count++;
    }
    ts.forEachChild(node, visit);
  };
  ts.forEachChild(parsed, visit);
  return count;
}

/** Compare a scan of the production tree against the policy. */
export function evaluateConsoleBudget(
  usage: readonly ConsoleUsage[],
  policy: ConsoleBudgetPolicy
): ConsoleBudgetResult {
  const allowed = new Set(policy.allowlist);
  const violations: ConsoleBudgetViolation[] = [];
  const ratchets: ConsoleBudgetViolation[] = [];
  for (const { file, count } of usage) {
    if (allowed.has(file)) continue;
    const budget = policy.budgets[file] ?? 0;
    if (count > budget) violations.push({ file, count, budget });
    else if (count < budget) ratchets.push({ file, count, budget });
  }
  for (const [file, budget] of Object.entries(policy.budgets)) {
    if (allowed.has(file)) continue;
    if (usage.some((entry) => entry.file === file)) continue;
    ratchets.push({ file, count: 0, budget });
  }
  return { violations, ratchets };
}

/** A failure message that names every offending file and the way out. */
export function formatConsoleBudgetFailure(result: ConsoleBudgetResult): string {
  return [
    "New direct console.* diagnostics are not allowed outside the CLI-output allowlist:",
    ...result.violations.map(
      ({ file, count, budget }) => `  ${file}: ${count} console call(s), budget ${budget}`
    ),
    "",
    "Route diagnostics through the application logger (src/observability/logger.ts);",
    "see docs/logging.md. If this file's output really is an interactive CLI",
    "contract, add it to the allowlist in console-budget.json in the same change,",
    "so a reviewer sees the exception being taken.",
  ].join("\n");
}

/** A baseline that no longer matches the tree, with the numbers to paste in. */
export function formatConsoleBudgetRatchet(result: ConsoleBudgetResult): string {
  return [
    "console-budget.json is stale — these files now have fewer console calls than",
    "their budget allows. Lower the budget so the migration cannot be undone:",
    ...result.ratchets.map(
      ({ file, count, budget }) => `  ${file}: ${budget} -> ${count === 0 ? "(remove)" : count}`
    ),
  ].join("\n");
}
