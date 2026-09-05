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

/** Matches `console.<member>` where `console` is not itself a property access. */
const CONSOLE_ACCESS = /(?<![\w$.])console\s*\.\s*[a-zA-Z$_][\w$]*/g;

/**
 * Characters after which a `/` opens a regular expression rather than dividing.
 * Without this the scanner reads the `"` inside `/["']/` as a string opener and
 * swallows the code that follows it. The empty string covers start-of-file.
 */
const REGEX_PRECEDING = new Set([
  "",
  "\n",
  "(",
  ",",
  "=",
  ":",
  "[",
  "!",
  "&",
  "|",
  "?",
  "{",
  "}",
  ";",
  "+",
  "-",
  "*",
  "%",
  "~",
  "^",
  "<",
  ">",
]);

/**
 * Blank out comments, string literals, template literals, and regular
 * expressions, leaving code positions intact. A URL inside a string must not
 * read as a line comment, a prose mention of `console.warn` in a doc comment
 * must not count as a call site, and neither must the literal text
 * `"console.log("` in a test fixture.
 */
export function stripNonCode(source: string): string {
  let out = "";
  let previousCode = "";
  let index = 0;
  const end = source.length;
  const keepNewlines = (from: number, to: number): void => {
    for (let i = from; i < to; i++) if (source[i] === "\n") out += "\n";
  };
  while (index < end) {
    const char = source[index];
    const next = source[index + 1];
    if (char === "/" && next === "/") {
      while (index < end && source[index] !== "\n") index++;
      continue;
    }
    if (char === "/" && next === "*") {
      const start = index;
      index += 2;
      while (index < end && !(source[index] === "*" && source[index + 1] === "/")) index++;
      index = Math.min(index + 2, end);
      keepNewlines(start, index);
      continue;
    }
    if (char === "/" && REGEX_PRECEDING.has(previousCode)) {
      index++;
      let inClass = false;
      while (index < end) {
        const c = source[index];
        if (c === "\\") {
          index += 2;
          continue;
        }
        if (c === "\n") break;
        if (c === "[") inClass = true;
        else if (c === "]") inClass = false;
        else if (c === "/" && !inClass) {
          index++;
          break;
        }
        index++;
      }
      previousCode = "/";
      continue;
    }
    if (char === '"' || char === "'" || char === "`") {
      const start = index;
      index++;
      while (index < end) {
        const c = source[index];
        if (c === "\\") {
          index += 2;
          continue;
        }
        if (c === char) {
          index++;
          break;
        }
        index++;
      }
      keepNewlines(start, index);
      previousCode = "'";
      continue;
    }
    out += char;
    if (char === "\n") previousCode = "\n";
    else if (char.trim()) previousCode = char;
    index++;
  }
  return out;
}

/** Count direct `console.*` references in one file's source. */
export function countConsoleCalls(source: string): number {
  return stripNonCode(source).match(CONSOLE_ACCESS)?.length ?? 0;
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
