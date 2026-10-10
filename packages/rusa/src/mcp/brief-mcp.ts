import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import {
  seedPortableBriefState,
  validateActorBriefUpdate,
} from "../actor/portable-context-brief.js";
import type {
  PortableBrief,
  PortableBriefRevision,
  PortableContextStore,
} from "../actor/portable-context-state.js";
import { toolError, toolOk } from "./result.js";
import { createMcpServer } from "./strict-server.js";

export const BRIEF_MCP_NAME = "brief";

export interface BriefMcpDeps {
  actorId: string;
  store: PortableContextStore;
  charter: () => string;
  now?: () => string;
}

/**
 * Actor-owned brief read and replace tools (#954, Matt ri18gmk-BNk / jMZhErvvUEY).
 * Identity is bound strictly to the caller actor (actorId is baked into the server instance).
 *
 * Invariants:
 * - 16 KiB size cap.
 * - Markdown structure: ## WHAT, ## HOW, ## DOMAIN.
 * - Structured citations on WHAT and HOW lines.
 * - Transient state excluded.
 * - Atomic last-good on rejected write (failed validation leaves stored brief untouched).
 * - Inspectable accepted-write time and recent revision history.
 * - Consolidation, citation rotation, and no-ops permitted.
 */
export function createBriefMcpServer(deps: BriefMcpDeps): McpServer {
  const server = createMcpServer({ name: BRIEF_MCP_NAME, version: "0.1.0" });
  const getNow = deps.now ?? (() => new Date().toISOString());

  server.registerTool(
    "read",
    {
      title: "Read current actor brief",
      description:
        "Read this actor's current portable brief, update timestamp, generation, and governing charter.",
      inputSchema: {},
    },
    async () => {
      try {
        const state = deps.store.load(deps.actorId);
        if (!state.brief) {
          throw new Error(`Actor ${deps.actorId} does not have an initialized brief.`);
        }
        return toolOk({
          text: state.brief.text,
          generation: state.brief.generation,
          updatedAt: state.brief.updatedAt,
          charter: deps.charter(),
          revisions: state.brief.revisions ?? [],
        });
      } catch (err) {
        return toolError(err);
      }
    }
  );

  server.registerTool(
    "replace",
    {
      title: "Replace actor brief",
      description:
        "Replace this actor's portable brief with distilled operating principles and domain context. " +
        "Enforces 16KB cap, valid WHAT/HOW/DOMAIN markdown structure, source citations, and transient state exclusion. " +
        "If validation fails, the existing brief is preserved atomically.",
      inputSchema: {
        text: z.string().describe("The candidate brief text in ## WHAT, ## HOW, ## DOMAIN format."),
        explanation: z
          .string()
          .optional()
          .describe("Optional actor explanation of the logic for the update."),
      },
    },
    async ({ text, explanation }) => {
      try {
        const now = getNow();
        let state = deps.store.load(deps.actorId);
        if (!state.brief) {
          state = seedPortableBriefState(state, deps.actorId, null, now);
          deps.store.save(state);
        }

        const currentBrief = state.brief;
        if (!currentBrief) {
          return toolError(`Actor ${deps.actorId} does not have an initialized brief.`);
        }
        const result = validateActorBriefUpdate({
          actorId: deps.actorId,
          charter: deps.charter(),
          text,
          previousText: currentBrief.text,
        });

        if (!result.valid) {
          // Atomic last-good on rejected write: the stored state remains completely untouched.
          return toolError(result.errors.join("\n"));
        }

        if (result.isNoop) {
          return toolOk({
            status: "unchanged",
            generation: currentBrief.generation,
            updatedAt: currentBrief.updatedAt,
            text: currentBrief.text,
          });
        }

        const nextGeneration = currentBrief.generation + 1;
        const newText = `${text.trimEnd()}\n`;
        const newRevision: PortableBriefRevision = {
          generation: nextGeneration,
          updatedAt: now,
          text: newText,
          ...(explanation?.trim() ? { explanation: explanation.trim() } : {}),
        };
        const priorRevisions = currentBrief.revisions ?? [];
        const revisions = [...priorRevisions, newRevision].slice(-10);

        const updatedBrief: PortableBrief = {
          ...currentBrief,
          text: newText,
          generation: nextGeneration,
          updatedAt: now,
          model: null,
          revisions,
        };

        deps.store.save({
          ...state,
          brief: updatedBrief,
        });

        return toolOk({
          status: "updated",
          generation: nextGeneration,
          updatedAt: now,
          previousGeneration: currentBrief.generation,
        });
      } catch (err) {
        return toolError(err);
      }
    }
  );

  return server;
}
