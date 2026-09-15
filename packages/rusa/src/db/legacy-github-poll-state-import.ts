import { existsSync, readFileSync, renameSync } from "node:fs";
import { join } from "node:path";
import type Database from "better-sqlite3";
import { z } from "zod";
import {
  GITHUB_POLL_EPOCH,
  type GitHubPollRepoState,
  type GitHubPollSeenEvent,
  type GitHubPollStream,
} from "../github/poll-state-store.js";
import type { Repositories } from "./repositories/index.js";

/** The file the poller wrote before its state moved into `mesh.db`. */
export const GITHUB_POLL_STATE_FILENAME = "github-poller-state.json";

/** The receipt key for this source; see {@link LegacyImportReceiptRepository}. */
export const GITHUB_POLL_STATE_IMPORT_SOURCE = GITHUB_POLL_STATE_FILENAME;

/** The read-only slice of {@link Repositories} a plan is allowed to touch. */
interface PlanRepositories {
  githubPollState: Pick<Repositories["githubPollState"], "list">;
  legacyImportReceipts: Pick<Repositories["legacyImportReceipts"], "has">;
}

/**
 * The text form every durable cursor and seen timestamp must have, and the
 * only spelling the retired writer ever produced for an event: GitHub's
 * `updated_at`, an ISO-8601 UTC instant at second precision with no fraction.
 * The store compares timestamps as text, and text order is time order only
 * when every value spells an instant exactly one way — `00Z` and `00.000Z`
 * name the same second yet the second sorts *before* the first, so admitting
 * both would let retention drop a key `since` can still return. Values are
 * copied as written, never reformatted. The one other spelling a legacy file
 * legitimately holds is the epoch constant itself, which the retired poller
 * wrote as a cursor's initial value and never as an event timestamp; it is
 * admitted by exact equality, for cursors only, below.
 */
const GITHUB_UPDATED_AT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/;

export function isGitHubUpdatedAt(value: string): boolean {
  return GITHUB_UPDATED_AT.test(value) && !Number.isNaN(Date.parse(value));
}

const cursorSchema = z
  .string()
  .refine((value) => value === GITHUB_POLL_EPOCH || isGitHubUpdatedAt(value), {
    message: "must be a GitHub updated_at timestamp (YYYY-MM-DDTHH:MM:SSZ) or the epoch",
  });

// The shape the retired poller wrote, including the single pre-stream-cursor
// `watermark` it still knew how to read and the draft set added for #307.
// `strict`, because a key the poller never wrote means a hand-edited file,
// and the import refuses rather than guess what the author meant by it.
const legacyRepoSchema = z
  .object({
    issuesWatermark: cursorSchema.optional(),
    commentsWatermark: cursorSchema.optional(),
    watermark: cursorSchema.optional(),
    seen: z.array(z.string().min(1)),
    branchHeads: z.record(z.string().min(1), z.string().min(1)).optional(),
    draftPullRequests: z.array(z.number().int().positive()).optional(),
  })
  .strict();
const legacyFileSchema = z
  .object({ repos: z.record(z.string().min(1), legacyRepoSchema) })
  .strict();

function readJson(path: string): unknown {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch (cause) {
    throw new Error(`Legacy GitHub poll state import: cannot parse ${path}`, { cause });
  }
}

// Mirrors legacy-host-job-import.ts's archive helpers: rename rather than
// delete, so the pre-import file is always recoverable after a commit.
function backupPath(path: string): string {
  const timestamp = new Date().toISOString().replaceAll(":", "-");
  let candidate = `${path}.imported-${timestamp}.bak`;
  let suffix = 1;
  while (existsSync(candidate)) candidate = `${path}.imported-${timestamp}-${suffix++}.bak`;
  return candidate;
}

function archive(path: string): string {
  const destination = backupPath(path);
  renameSync(path, destination);
  return destination;
}

/**
 * Split a retired seen key back into the stream it protects and the event's
 * own timestamp. Keys were written as `<kind>:<id>:<updatedAt>`, where the
 * timestamp itself contains colons, so the split is on the second colon only.
 * Kinds are the three the poller emits; anything else is a hand edit.
 */
export function parseLegacySeenKey(key: string): GitHubPollSeenEvent | undefined {
  const first = key.indexOf(":");
  const second = first === -1 ? -1 : key.indexOf(":", first + 1);
  if (second === -1) return undefined;
  const kind = key.slice(0, first);
  const updatedAt = key.slice(second + 1);
  if (!isGitHubUpdatedAt(updatedAt)) return undefined;
  const stream = streamForKind(kind);
  if (!stream) return undefined;
  return { key, stream, updatedAt };
}

function streamForKind(kind: string): GitHubPollStream | undefined {
  switch (kind) {
    case "issue_comment":
      return "comments";
    case "issues":
    case "pull_request":
      return "issues";
    default:
      return undefined;
  }
}

export interface LegacyGitHubPollStateImportResult {
  importedRepos: number;
  backupFiles: string[];
}

/** A read-only plan of what {@link applyLegacyGitHubPollStateImport} would do, with no writes performed. */
export type LegacyGitHubPollStateImportPlan =
  | { kind: "noop" }
  | { kind: "already-imported" }
  | { kind: "import"; repos: GitHubPollRepoState[] };

export interface LegacyGitHubPollStateImportPlanResult {
  plan: LegacyGitHubPollStateImportPlan;
  hasFile: boolean;
  filePath: string;
  /** Repository rows the plan would write. */
  plannedRepos: number;
}

/**
 * Parse and validate `github-poller-state.json` against the `github_poll_*`
 * tables without performing any write. Only accepts a read-only slice of
 * {@link Repositories}, so it cannot open a DB transaction, write a row, or
 * archive the legacy file.
 *
 * Refuses — rather than importing a partial view — whenever a repository
 * fails to resolve. The retired poller parsed the file with an unchecked cast
 * and, on any read failure, started every cursor over from the epoch. That
 * fallback is exactly the behaviour this migration exists to remove: a cursor
 * silently reset to 1970 replays every event in the repository through the
 * ingress, and a branch head silently forgotten loses the next deploy push.
 * A refused file stays on disk, the error names the repository and the key,
 * and the next boot re-plans.
 *
 * Resolution rules, matching what the poller did in memory on read:
 *
 * - a stream cursor falls back to the deprecated single `watermark`, then to
 *   the epoch;
 * - a seen key that does not parse as `<kind>:<id>:<updatedAt>` with a kind
 *   the poller emits is refused, because its stream and timestamp decide when
 *   it may be forgotten;
 * - every cursor and seen timestamp must already be in the store's text form
 *   (see {@link isGitHubUpdatedAt}); it is copied, not reformatted;
 * - the draft set is taken as is: a PR number in it was an open draft the
 *   last time the retired poller delivered an event for it.
 */
export function planLegacyGitHubPollStateImport(options: {
  mcHome: string;
  repositories: PlanRepositories;
}): LegacyGitHubPollStateImportPlanResult {
  const filePath = join(options.mcHome, GITHUB_POLL_STATE_FILENAME);
  const hasFile = existsSync(filePath);
  if (!hasFile) {
    return { plan: { kind: "noop" }, hasFile, filePath, plannedRepos: 0 };
  }

  // The receipt is the precedence rule: once the import transaction committed,
  // SQLite is authoritative and a source file still on disk is stale by
  // construction — a failed archive rename, or a restored backup. Reading it
  // again could only rewind cursors the poller has since advanced.
  if (options.repositories.legacyImportReceipts.has(GITHUB_POLL_STATE_IMPORT_SOURCE)) {
    return { plan: { kind: "already-imported" }, hasFile, filePath, plannedRepos: 0 };
  }

  const parsed = legacyFileSchema.safeParse(readJson(filePath));
  if (!parsed.success) {
    const detail = parsed.error.issues
      .map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`)
      .join("; ");
    throw new Error(
      `Legacy GitHub poll state import: ${filePath} has unresolved row(s); ` +
        `refusing to import a partial poll position (${detail})`
    );
  }

  const repos: GitHubPollRepoState[] = [];
  for (const [repo, legacy] of Object.entries(parsed.data.repos)) {
    const seen: GitHubPollSeenEvent[] = [];
    for (const key of legacy.seen) {
      const event = parseLegacySeenKey(key);
      if (!event) {
        throw new Error(
          `Legacy GitHub poll state import: ${filePath} has unresolved row(s); ` +
            `refusing to import a partial poll position (repos.${repo}.seen: '${key}' ` +
            "is not <kind>:<id>:<updatedAt> with a kind the poller emits)"
        );
      }
      seen.push(event);
    }
    repos.push({
      repo,
      issuesWatermark: legacy.issuesWatermark ?? legacy.watermark ?? GITHUB_POLL_EPOCH,
      commentsWatermark: legacy.commentsWatermark ?? legacy.watermark ?? GITHUB_POLL_EPOCH,
      seen,
      branchHeads: legacy.branchHeads ?? {},
      draftPullRequests: legacy.draftPullRequests ?? [],
    });
  }

  // No receipt but durable rows already exist: something polled against this
  // database before the file was imported, so neither side can be shown to
  // be the newer position. Refuse rather than rewind a cursor.
  const existing = options.repositories.githubPollState.list();
  if (existing.length > 0) {
    throw new Error(
      `Legacy GitHub poll state import: ${filePath} is present but ${existing.length} durable ` +
        "poll repository row(s) were written without an import receipt; refusing to overwrite them"
    );
  }

  return { plan: { kind: "import", repos }, hasFile, filePath, plannedRepos: repos.length };
}

/**
 * Apply a {@link LegacyGitHubPollStateImportPlan} produced by
 * {@link planLegacyGitHubPollStateImport} for the same home: write the durable
 * rows and the import receipt in one transaction, then archive the legacy
 * file.
 *
 * The two steps split the failure modes cleanly. An interruption before commit
 * leaves no rows and no receipt, so the next boot re-plans against the intact
 * file and gets the complete legacy view. An interruption after commit leaves
 * rows and a receipt, so the next boot sees the receipt, archives the file
 * unread, and gets the complete database view. There is no ordering that yields
 * a mixture.
 */
export function applyLegacyGitHubPollStateImport(
  planResult: LegacyGitHubPollStateImportPlanResult,
  options: { db: Database.Database; repositories: Repositories; now?: () => string }
): LegacyGitHubPollStateImportResult {
  const { plan, filePath } = planResult;
  const now = options.now ?? (() => new Date().toISOString());

  switch (plan.kind) {
    case "noop":
      return { importedRepos: 0, backupFiles: [] };

    case "already-imported":
      return { importedRepos: 0, backupFiles: [archive(filePath)] };

    case "import": {
      const { repos } = plan;
      options.db.transaction(() => {
        for (const repo of repos) options.repositories.githubPollState.importRepo(repo);
        options.repositories.legacyImportReceipts.record(
          GITHUB_POLL_STATE_IMPORT_SOURCE,
          now(),
          repos.length
        );
      })();
      return { importedRepos: repos.length, backupFiles: [archive(filePath)] };
    }
  }
}

/**
 * Import the retired `github-poller-state.json` file exactly once: plan, then
 * apply. See {@link planLegacyGitHubPollStateImport} and
 * {@link applyLegacyGitHubPollStateImport}.
 */
export function importLegacyGitHubPollState(options: {
  mcHome: string;
  db: Database.Database;
  repositories: Repositories;
}): LegacyGitHubPollStateImportResult {
  const planResult = planLegacyGitHubPollStateImport(options);
  return applyLegacyGitHubPollStateImport(planResult, options);
}
