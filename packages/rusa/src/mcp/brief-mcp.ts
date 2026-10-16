import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import {
  PORTABLE_CONTEXT_BRIEF_MAX_BYTES,
  seedPortableBriefState,
  validateActorBriefUpdate,
} from "../actor/portable-context-brief.js";
import type {
  PortableBrief,
  PortableBriefStore,
  PortableContextStore,
} from "../actor/portable-context-state.js";
import type { ReferenceEntity } from "../references/resolve.js";
import { toolError, toolOk } from "./result.js";
import { createMcpServer } from "./strict-server.js";

export const BRIEF_MCP_NAME = "brief";

/**
 * Reads a citation. `unavailable` says why its text could not be read; a
 * resolved `entity` shows the resource exists even when its text is empty,
 * such as an issue with no body.
 */
export type BriefCitationResolver = (
  ref: string
) => Promise<{ unavailable: string | null; entity?: ReferenceEntity }>;

export interface BriefMcpDeps {
  /** The calling actor. Baked into this server instance; no tool takes an actor id. */
  actorId: string;
  store: PortableContextStore & PortableBriefStore;
  /**
   * Resolves a citation the write introduces, through the host's existing
   * reference resolver (`references/resolve.ts`) and the clients it is
   * authorized to use.
   */
  resolveCitation: BriefCitationResolver;
  /**
   * How long one write waits for its new citations before refusing them as not
   * checkable right now. Keeps a degraded source's client retries from holding
   * the actor's run, and answers well inside an MCP client's own tool timeout,
   * so a write the client gave up on can never commit later.
   */
  citationDeadlineMs?: number;
  now?: () => string;
}

export const BRIEF_CITATION_DEADLINE_MS = 15_000;

/**
 * A brief-mode actor's own brief, read and replaced by the actor itself (#954).
 *
 * The server is mounted per actor, so identity is the mount, never an argument:
 * an actor can read and replace only its own brief. `replace` is a
 * compare-and-set on the generation `read` returned, so a write based on a brief
 * that has since changed is refused rather than silently overwriting it. Every
 * citation the write introduces must resolve before it is stored; resolution
 * is asynchronous, so the store rechecks the generation inside its write
 * transaction. A refused write — stale, malformed, oversized, uncited, naming
 * per-resource state, or citing something that cannot be resolved — leaves the
 * stored brief and its history exactly as they were. An unchanged write is a
 * no-op that records nothing and keeps the update time.
 */
export function createBriefMcpServer(deps: BriefMcpDeps): McpServer {
  const server = createMcpServer({ name: BRIEF_MCP_NAME, version: "0.1.0" });
  const now = deps.now ?? (() => new Date().toISOString());

  // Prompt assembly seeds the brief before the first brief-mode run; seeding
  // here too keeps the tools total for an actor whose mode just switched.
  const currentBrief = (): PortableBrief => {
    const state = deps.store.load(deps.actorId);
    if (state.brief) return state.brief;
    const seeded = seedPortableBriefState(state, now());
    deps.store.save(seeded);
    return seeded.brief as PortableBrief;
  };

  server.registerTool(
    "read",
    {
      title: "Read your brief",
      description:
        "Read your current portable brief, its generation, and when it was last changed. " +
        "Pass the generation to replace.",
      inputSchema: {},
    },
    async () => {
      try {
        const brief = currentBrief();
        return toolOk({
          text: brief.text,
          generation: brief.generation,
          updatedAt: brief.updatedAt,
        });
      } catch (err) {
        return toolError(err);
      }
    }
  );

  server.registerTool(
    "replace",
    {
      title: "Replace your brief",
      description:
        "Replace your portable brief with distilled, cited guidance: the sections ## WHAT, ## HOW and " +
        "## DOMAIN in that order, every statement line ending in a structured citation such as " +
        "[mesh:messages/<id>] or [github:OWNER/REPO/issues/<n>], no per-resource state (SHAs, run ids, " +
        `review ids, gate tallies), at most ${PORTABLE_CONTEXT_BRIEF_MAX_BYTES} bytes. ` +
        "Every citation you add must point at something that exists and can be read. " +
        "Consolidate and reword freely; one representative citation per principle is enough. " +
        "Unchanged text is a no-op. A rejected write keeps the current brief.",
      inputSchema: {
        text: z.string().describe("The complete new brief."),
        expected_generation: z
          .number()
          .int()
          .nonnegative()
          .describe(
            "The generation returned by read; the write is refused if the brief changed since."
          ),
        explanation: z
          .string()
          .optional()
          .describe("Optional: why you changed the brief. Shown in its history."),
      },
    },
    async ({ text, expected_generation, explanation }) => {
      try {
        const current = currentBrief();
        if (current.generation !== expected_generation) {
          return toolError(
            `stale brief write: expected generation ${expected_generation}, current is ${current.generation}; read the brief again before replacing it`
          );
        }
        const result = validateActorBriefUpdate({
          text,
          previousText: current.text,
          ...(explanation === undefined ? {} : { explanation }),
        });
        if (result.outcome === "invalid") return toolError(result.errors.join("\n"));
        if (result.outcome === "noop") {
          return toolOk({
            status: "unchanged",
            generation: current.generation,
            updatedAt: current.updatedAt,
          });
        }
        const unresolved = await unresolvedCitations(
          result.newCitations,
          deps.resolveCitation,
          deps.citationDeadlineMs ?? BRIEF_CITATION_DEADLINE_MS
        );
        if (unresolved.length > 0) {
          return toolError(
            [
              ...unresolved.map(
                ({ ref, reason }) => `citation [${ref}] could not be resolved: ${reason}`
              ),
              "The brief is unchanged.",
            ].join("\n")
          );
        }
        // Resolution awaited; commitBrief rechecks the generation inside its
        // write transaction, so a write that landed meanwhile refuses this one.
        const revision = deps.store.commitBrief({
          actorId: deps.actorId,
          expectedGeneration: expected_generation,
          text: result.text,
          ...(result.explanation === undefined ? {} : { explanation: result.explanation }),
          actingPrincipal: deps.actorId,
          at: now(),
        });
        return toolOk({
          status: "updated",
          generation: revision.generation,
          updatedAt: revision.updatedAt,
        });
      } catch (err) {
        return toolError(err);
      }
    }
  );

  return server;
}

async function unresolvedCitations(
  refs: readonly string[],
  resolve: BriefCitationResolver,
  deadlineMs: number
): Promise<Array<{ ref: string; reason: string }>> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<"timeout">((settle) => {
    timer = setTimeout(() => settle("timeout"), deadlineMs);
  });
  try {
    const outcomes = await Promise.all(
      refs.map(async (ref) => {
        try {
          const outcome = await Promise.race([resolve(ref), deadline]);
          if (outcome === "timeout") {
            return {
              ref,
              reason: `could not be checked within ${deadlineMs / 1000}s; try again later`,
            };
          }
          const { unavailable, entity } = outcome;
          const emptyIssue =
            entity?.type === "github_issue" || entity?.type === "github_pull_request";
          return unavailable === null || emptyIssue ? null : { ref, reason: unavailable };
        } catch (err) {
          return { ref, reason: err instanceof Error ? err.message : String(err) };
        }
      })
    );
    return outcomes.filter((outcome) => outcome !== null);
  } finally {
    clearTimeout(timer);
  }
}
