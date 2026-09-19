import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { ChatSpaceMembership } from "../chat/spaces.js";
import type { MeshEvent } from "../db/repositories/mesh-event-repository.js";
import type { CommitmentPolarityEvaluator } from "../understanding/commitment-polarity.js";
import type { DistillerStore } from "../understanding/distiller-cursor.js";
import {
  appendJournalEntry,
  type IuReportPaths,
  journalEntryBodySchema,
  renderAndIndex,
} from "../understanding/distiller-journal.js";
import {
  distillAdvance,
  distillGate,
  distillSeed,
  distillWindow,
} from "../understanding/distiller-ops.js";
import { toolError, toolOk } from "./result.js";
import { createMcpServer } from "./strict-server.js";

export const DISTILLER_MCP_NAME = "distiller";

export interface DistillerSeedSource {
  seed: string | null;
  reason: string;
}

/** One page of the distiller's bounded, oldest-first mesh_events replay (#537). */
export interface DistillerEventPage {
  events: MeshEvent[];
  hasMore: boolean;
  /** Opaque resume point for the next page; `null` once the window is exhausted. */
  nextCursor: string | null;
}

/**
 * The host-side distiller boundary. This is intentionally narrower than raw
 * mesh.db or repository access: it can touch only cursor state, count
 * substantive activity for the gate, derive the one-shot seed source, and
 * read a bounded window of durable events across every actor.
 */
export interface DistillerMcpStore extends DistillerStore {
  countSubstantiveEvents(sinceISO: string, untilISO: string): number;
  resolveSeed(): Promise<DistillerSeedSource>;
  unsyncedCount(): number;
  listEvents(opts: {
    since: string;
    until?: string;
    limit: number;
    after?: string;
  }): DistillerEventPage;
}

/**
 * Page bounds for `distill_read_events`. The ceiling matches the dashboard's
 * events route so one page never carries more transcript text than the
 * human-facing read is already trusted with; a window wider than that is
 * walked with the cursor.
 */
export const DISTILLER_EVENTS_DEFAULT_LIMIT = 100;
export const DISTILLER_EVENTS_MAX_LIMIT = 200;

/**
 * The instance-side nightly-report sink . Present only where the report
 * filesystem is available (the live host wiring); omitted for read-only or test
 * constructions, in which case the journal/render tools fail soft with a clear
 * message rather than touching disk. `now` is injected so `ts`/`generatedAt` stay
 * host-authored and deterministically testable.
 */
export interface DistillerReportsDeps {
  paths: IuReportPaths;
  now?: () => string;
  /**
   * Semantic evaluator for the ISSUE_NUM commitment-claim polarity check. Omitted
   * where no model key is configured, in which case the rendered report states
   * that the check did not run — there is deliberately no lexical fallback .
   */
  evaluateCommitment?: CommitmentPolarityEvaluator;
}

export interface DistillerMcpDeps {
  store: DistillerMcpStore;
  reports?: DistillerReportsDeps;
  /**
   * Enumerate the chat spaces the distiller may read (ISSUE_NUM/ISSUE_NUM) — every space
   * the Chat identity is a member of, measured per run rather than configured.
   * Omitted where Chat is not wired at all, which is reported as "chat is not
   * configured", distinct from both "member of nothing" and "could not look".
   */
  listChatSpaces?: () => Promise<ChatSpaceMembership>;
}

export interface DistillerChatSpaces {
  status: "enumerated" | "incomplete" | "not_configured";
  spaces: string[];
  note: string;
  error?: string;
}

/**
 * The chat read set for a run, in the three states it actually has. `spaces` is
 * only a read set when `status` is `enumerated`; on `incomplete` it is whatever
 * the walk managed before it stopped, which is a lower bound and not a scope.
 */
async function resolveChatSpaces(
  listChatSpaces: (() => Promise<ChatSpaceMembership>) | undefined
): Promise<DistillerChatSpaces> {
  if (!listChatSpaces) {
    return {
      status: "not_configured",
      spaces: [],
      note: "no Google Chat identity is wired on this host, so chat is outside this run's read set. This is a host fact, not a measurement of what exists.",
    };
  }
  const membership = await listChatSpaces();
  const spaces = membership.spaces.map((s) => s.name);
  if (!membership.complete) {
    return {
      status: "incomplete",
      spaces,
      note: `space enumeration did not finish, so this run does NOT know its chat read set. Report chat coverage as unknown; do not treat these ${spaces.length} space(s) as the scope.`,
      ...(membership.error ? { error: membership.error } : {}),
    };
  }
  return {
    status: "enumerated",
    spaces,
    note: `every space this Chat identity is a member of (${spaces.length}). Apply judgment per message about what belongs in a durable org-wide node — the read set is not pre-filtered.`,
  };
}

/**
 * Grantable MCP wrapper for the IU distiller cursor operations . The
 * implementation stays at the edge: deterministic behavior lives in
 * understanding/distiller-ops.ts, while this server only adapts MCP args/results
 * to the narrow host-side distiller store.
 */
export function createDistillerServer(
  deps: DistillerMcpDeps,
  options?: { isFenced?: () => boolean }
): McpServer {
  const server = createMcpServer(
    { name: DISTILLER_MCP_NAME, version: "0.1.0" },
    { isFenced: options?.isFenced }
  );

  server.registerTool(
    "distill_gate",
    {
      title: "Check whether the distiller should run",
      description:
        "Return whether substantive mesh activity exists since the last successful distill. Uses the full uncapped [lastDistilled, now) gate window.",
      inputSchema: {
        now: z
          .string()
          .datetime()
          .optional()
          .describe("ISO timestamp to gate until; defaults to the current host time."),
      },
    },
    async ({ now }) => {
      try {
        const until = now ?? new Date().toISOString();
        return toolOk(
          distillGate(deps.store, until, (sinceISO, untilISO) =>
            deps.store.countSubstantiveEvents(sinceISO, untilISO)
          )
        );
      } catch (err) {
        return toolError(err);
      }
    }
  );

  server.registerTool(
    "distill_window",
    {
      title: "Read the capped distiller scan window",
      description:
        "Return the capped walk-forward window to scan, and whether it includes mesh events.",
      inputSchema: {
        now: z
          .string()
          .datetime()
          .optional()
          .describe("ISO timestamp to window until; defaults to the current host time."),
        cap_days: z
          .number()
          .positive()
          .optional()
          .describe("Optional cap width in days; defaults to the distiller policy."),
      },
    },
    async ({ now, cap_days }) => {
      try {
        return toolOk(distillWindow(deps.store, now ?? new Date().toISOString(), cap_days));
      } catch (err) {
        return toolError(err);
      }
    }
  );

  server.registerTool(
    "distill_seed",
    {
      title: "Seed the distiller cursor if unset",
      description:
        "One-shot seed from the latest glass-goals op. If glass-goals is unreachable, does not seed so the next run can retry safely.",
      inputSchema: {},
    },
    async () => {
      try {
        const existing = deps.store.getState().lastDistilled;
        if (existing !== null) return toolOk({ seeded: false, cursor: existing });

        const { seed, reason } = await deps.store.resolveSeed();
        if (seed === null) return toolOk({ seeded: false, reason });

        return toolOk({ ...distillSeed(deps.store, seed), source: reason });
      } catch (err) {
        return toolError(err);
      }
    }
  );

  server.registerTool(
    "distill_advance",
    {
      title: "Advance the distiller cursor",
      description:
        "Commit the cursor to the processed window end when all sources succeeded, or record a bounded failure/gap according to policy.",
      inputSchema: {
        to: z.string().datetime().describe("Processed window end ISO timestamp."),
        ok: z.boolean().describe("Whether all distillation sources succeeded for this window."),
      },
    },
    async ({ to, ok }) => {
      try {
        return toolOk(distillAdvance(deps.store, to, ok));
      } catch (err) {
        return toolError(err);
      }
    }
  );

  server.registerTool(
    "distill_status",
    {
      title: "Read distiller status",
      description:
        "Return distiller cursor state, the local outbox unsynced op count for health checks, and `chatSpaces` — the Google Chat read set for this run, which is every space the Chat identity is a member of (ISSUE_NUM/ISSUE_NUM). Read `chatSpaces.status` before `chatSpaces.spaces`: `enumerated` means the list is the membership, `incomplete` means the walk failed or stopped short and the list is NOT the read set, `not_configured` means this host has no Chat identity at all. Judgment about what belongs in a durable node is applied per message while distilling, never by excluding a space up front.",
      inputSchema: {},
    },
    async () => {
      try {
        return toolOk({
          ...deps.store.getState(),
          unsyncedCount: deps.store.unsyncedCount(),
          // Always present, and never a bare array: the distiller has to be able
          // to tell "member of no spaces" from "could not enumerate" from "no
          // Chat on this host", and all three would arrive as `[]`.
          chatSpaces: await resolveChatSpaces(deps.listChatSpaces),
        });
      } catch (err) {
        return toolError(err);
      }
    }
  );

  server.registerTool(
    "distill_read_events",
    {
      title: "Read a bounded window of mesh events",
      description:
        "Replay durable mesh events across ALL actors in the half-open window [since, until), oldest first. Pages are stable: pass the returned `nextCursor` back as `cursor` to continue exactly where the previous page stopped; `nextCursor` is null once the window is exhausted. Read-only — replaying a missed window never touches events or inbox state.",
      inputSchema: {
        since: z.string().datetime().describe("Inclusive ISO lower bound."),
        until: z
          .string()
          .datetime()
          .optional()
          .describe("Exclusive ISO upper bound; omit for an open-ended read."),
        limit: z
          .number()
          .int()
          .min(1)
          .max(DISTILLER_EVENTS_MAX_LIMIT)
          .optional()
          .describe(
            `Page size, 1..${DISTILLER_EVENTS_MAX_LIMIT} (default ${DISTILLER_EVENTS_DEFAULT_LIMIT}).`
          ),
        cursor: z
          .string()
          .optional()
          .describe("Opaque `nextCursor` from the previous page of the same window."),
      },
    },
    async (args) => {
      try {
        // Stored stamps are `toISOString()` output and the window compares
        // lexically against them, so the bounds are canonicalised first: the
        // schema also admits `…:24Z`, which sorts after `…:24.000Z` as text.
        const since = new Date(args.since).toISOString();
        const until = args.until === undefined ? undefined : new Date(args.until).toISOString();
        if (until !== undefined && until <= since) {
          return toolError(`until (${until}) must be later than since (${since})`);
        }
        const page = deps.store.listEvents({
          since,
          ...(until === undefined ? {} : { until }),
          limit: args.limit ?? DISTILLER_EVENTS_DEFAULT_LIMIT,
          ...(args.cursor === undefined ? {} : { after: args.cursor }),
        });
        return toolOk({ since, until: until ?? null, ...page });
      } catch (err) {
        return toolError(err);
      }
    }
  );

  server.registerTool(
    "distill_journal_append",
    {
      title: "Append a run-journal entry at decision time",
      description:
        "Append one line to the run's instance-side JSONL journal . The host stamps the envelope (v, seq, ts) — never author them. Send `run_meta` first, one `decision` per distillation judgment (including what you deliberately skipped, with a disposition), and `run_summary` last, then call `distill_report_render`.",
      inputSchema: {
        run_id: z
          .string()
          .describe('Stable run id: the half-open window pair "<from>__<to>" (ISO timestamps).'),
        entry: journalEntryBodySchema.describe(
          "The entry body (run_meta | decision | run_summary), WITHOUT v/seq/ts — the host stamps those."
        ),
      },
    },
    async ({ run_id, entry }) => {
      try {
        if (!deps.reports) return toolError("report emission is not configured on this host");
        const now = deps.reports.now?.() ?? new Date().toISOString();
        return toolOk(appendJournalEntry(deps.reports.paths, run_id, entry, { now }));
      } catch (err) {
        return toolError(err);
      }
    }
  );

  server.registerTool(
    "distill_report_render",
    {
      title: "Render the nightly report for a run",
      description:
        "Read the run's journal, render the human-readable markdown report, and upsert the run into index.json . Call once after appending run_summary. Deterministic projection — adds no new judgment.",
      inputSchema: {
        run_id: z.string().describe('The run id whose journal to render ("<from>__<to>").'),
      },
    },
    async ({ run_id }) => {
      try {
        if (!deps.reports) return toolError("report emission is not configured on this host");
        const now = deps.reports.now?.() ?? new Date().toISOString();
        return toolOk(
          await renderAndIndex(deps.reports.paths, run_id, {
            now,
            ...(deps.reports.evaluateCommitment
              ? { evaluateCommitment: deps.reports.evaluateCommitment }
              : {}),
          })
        );
      } catch (err) {
        return toolError(err);
      }
    }
  );

  return server;
}
