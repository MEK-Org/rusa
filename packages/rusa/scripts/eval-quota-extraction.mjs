import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import Database from "better-sqlite3";
import {
  parseAgyQuota,
  parseClaudeQuota,
  parseCodexQuota,
  parseKimiQuota,
} from "../dist/mcp/quota-mcp.js";

const PROVIDERS = ["codex", "claude", "agy", "kimi"];

function usage() {
  return [
    "Usage:",
    "  GEMINI_API_KEY=... pnpm --filter rusa run eval:quota -- \\",
    "    --database /absolute/path/to/quota.db \\",
    "    --labels /absolute/path/to/quota-labels.json \\",
    "    --report /absolute/path/to/quota-eval.md [--repeat 3]",
    "",
    "The label file is a JSON array of {id, expected:{status, limits}} records.",
    "Raw scrape text and source IDs are never written to the report.",
  ].join("\n");
}

function parseArgs(argv) {
  const result = { repeat: 3 };
  for (let index = 2; index < argv.length; index += 1) {
    const flag = argv[index];
    if (flag === "--") continue;
    if (flag === "--help") return { help: true };
    const value = argv[index + 1];
    if (!value || value.startsWith("--")) throw new Error(`missing value for ${flag}`);
    index += 1;
    if (flag === "--database") result.database = value;
    else if (flag === "--labels") result.labels = value;
    else if (flag === "--report") result.report = value;
    else if (flag === "--repeat") result.repeat = Number(value);
    else throw new Error(`unknown argument ${flag}`);
  }
  if (!result.database || !result.labels || !result.report) {
    throw new Error("--database, --labels, and --report are required");
  }
  if (!Number.isInteger(result.repeat) || result.repeat < 1) {
    throw new Error("--repeat must be a positive integer");
  }
  return result;
}

function shortHash(value) {
  return createHash("sha256").update(value).digest("hex").slice(0, 16);
}

function normalizedReset(value) {
  if (value === undefined || value === null) return null;
  const millis = Date.parse(value);
  return Number.isFinite(millis) ? new Date(millis).toISOString() : `invalid:${String(value)}`;
}

function normalizedSnapshot(snapshot) {
  const limits = Array.isArray(snapshot?.limits)
    ? snapshot.limits
        .map((limit) => ({
          kind: limit.kind ?? null,
          percentLeft: limit.percentLeft,
          resetAtIso: normalizedReset(limit.resetAtIso),
          scope: limit.scope ?? null,
        }))
        .sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right), "en-US"))
    : [];
  return { status: snapshot?.status ?? null, limits };
}

function validateLabels(labels) {
  if (!Array.isArray(labels) || labels.length === 0) {
    throw new Error("label file must contain a non-empty JSON array");
  }
  const ids = new Set();
  for (const [index, label] of labels.entries()) {
    if (!label || typeof label.id !== "string" || !label.id.trim()) {
      throw new Error(`label ${index + 1} has no id`);
    }
    if (ids.has(label.id)) throw new Error(`duplicate label id at record ${index + 1}`);
    ids.add(label.id);
    if (!label.expected || !PROVIDERS.includes(label.provider)) {
      throw new Error(`label ${index + 1} needs provider and expected fields`);
    }
    const expected = normalizedSnapshot(label.expected);
    if (
      !PROVIDERS.includes(label.provider) ||
      !["available", "exhausted", "unknown"].includes(expected.status)
    ) {
      throw new Error(`label ${index + 1} has an invalid provider or status`);
    }
    for (const limit of expected.limits) {
      if (limit.scope !== "provider") {
        throw new Error(`label ${index + 1} contains a non-provider expected limit`);
      }
      if (!Number.isFinite(limit.percentLeft) || limit.percentLeft < 0 || limit.percentLeft > 100) {
        throw new Error(`label ${index + 1} contains an invalid expected percentage`);
      }
    }
  }
}

async function evaluateRecord(record, parser, apiKey, repeat) {
  const attempts = [];
  for (let pass = 0; pass < repeat; pass += 1) {
    const parsed = await parser(record.rawOutput, apiKey, Date.parse(record.scrapedAt));
    attempts.push(normalizedSnapshot(parsed));
  }
  const expected = normalizedSnapshot(record.expected);
  const expectedJson = JSON.stringify(expected);
  const results = attempts.map((attempt) => JSON.stringify(attempt));
  const providerOnly = attempts.every((attempt) =>
    attempt.limits.every((limit) => limit.scope === "provider")
  );
  return {
    provider: record.provider,
    idHash: shortHash(`${record.provider}\0${record.id}`),
    exact: results.every((result) => result === expectedJson),
    stable: results.every((result) => result === results[0]),
    providerOnly,
  };
}

function renderReport(results, repeat) {
  const passed = results.filter((result) => result.exact && result.stable && result.providerOnly);
  const providerRows = PROVIDERS.map((provider) => {
    const rows = results.filter((result) => result.provider === provider);
    const ok = rows.filter((result) => result.exact && result.stable && result.providerOnly).length;
    return `| ${provider} | ${rows.length} | ${ok} | ${rows.length - ok} |`;
  }).join("\n");
  const failures = results.filter(
    (result) => !result.exact || !result.stable || !result.providerOnly
  );
  const failureLines = failures.length
    ? failures
        .map((result) => {
          const reasons = [
            !result.exact && "expected-value mismatch",
            !result.stable && "inconsistent repeated output",
            !result.providerOnly && "non-provider scope",
          ].filter(Boolean);
          return `- \`${result.idHash}\` (${result.provider}): ${reasons.join(", ")}`;
        })
        .join("\n")
    : "- None";
  return (
    "# Quota extraction evaluation\n\n" +
    `Each labeled historical scrape was parsed ${repeat} time(s) through the production model/fallback path. ` +
    "The evaluator compares structured provider fields only and does not parse or match raw quota text.\n\n" +
    `Result: **${passed.length === results.length ? "PASS" : "FAIL"}** (${passed.length}/${results.length} labeled scrapes passed).\n\n` +
    "| Provider | Labeled scrapes | Passed | Failed |\n" +
    "| --- | ---: | ---: | ---: |\n" +
    `${providerRows}\n\n` +
    "## Failures\n\n" +
    `${failureLines}\n`
  );
}

async function main() {
  const args = parseArgs(process.argv);
  if (args.help) {
    process.stdout.write(`${usage()}\n`);
    return;
  }
  const apiKey = process.env.GEMINI_API_KEY?.trim();
  if (!apiKey) throw new Error("GEMINI_API_KEY is required");
  const labels = JSON.parse(await readFile(args.labels, "utf8"));
  validateLabels(labels);

  const db = new Database(args.database, { readonly: true, fileMustExist: true });
  const select = db.prepare(
    "SELECT provider, scraped_at AS scrapedAt, raw_output AS rawOutput FROM quota_scrapes WHERE id = ?"
  );
  const parsers = {
    codex: parseCodexQuota,
    claude: parseClaudeQuota,
    agy: parseAgyQuota,
    kimi: parseKimiQuota,
  };
  try {
    const results = [];
    for (const label of labels) {
      const row = select.get(label.id);
      if (!row)
        throw new Error(`labeled scrape ${shortHash(label.id)} is absent from the database`);
      if (row.provider !== label.provider) {
        throw new Error(`labeled scrape ${shortHash(label.id)} has the wrong provider`);
      }
      results.push(
        await evaluateRecord({ ...row, ...label }, parsers[label.provider], apiKey, args.repeat)
      );
    }
    const report = renderReport(results, args.repeat);
    await writeFile(args.report, report);
    process.stdout.write(
      `[quota-eval] wrote ${args.report}; ${results.filter((result) => result.exact && result.stable && result.providerOnly).length}/${results.length} passed\n`
    );
    if (results.some((result) => !result.exact || !result.stable || !result.providerOnly)) {
      process.exitCode = 2;
    }
  } finally {
    db.close();
  }
}

main().catch((error) => {
  process.stderr.write(`[quota-eval] ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
