import { existsSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { ThreadRegistry } from "../actor/thread-registry.js";
import {
  checkPnpmHardlinks,
  ensurePnpmStoreDir,
  findPnpmProjects,
  relinkPnpmProject,
  resolvePnpmStoreDir,
} from "../pnpm/hardlinks.js";
import { toolError, toolOk } from "./result.js";
import { createMcpServer } from "./strict-server.js";

export const PNPM_HARDLINKS_MCP_NAME = "pnpm-hardlinks";

export interface PnpmHardlinksToolDeps {
  rootId: string;
  workersDir: string;
  registry: ThreadRegistry;
  runningThreadIds: () => Iterable<string>;
}

export interface WorkerRelinkSummary {
  workerId: string;
  skipped?: string;
  projects: Array<{
    projectDir: string;
    scanned: number;
    relinked: number;
    alreadyLinked: number;
    missingStoreFile: number;
    failed: number;
    invariantProblems: number;
  }>;
}

export class PnpmRelinkInvariantError extends Error {
  constructor(readonly summaries: WorkerRelinkSummary[]) {
    const bad = summaries
      .flatMap((worker) =>
        worker.projects
          .filter((project) => project.failed > 0 || project.invariantProblems > 0)
          .map(
            (project) =>
              `${worker.workerId}:${project.projectDir} failed=${project.failed} missingStore=${project.missingStoreFile} invariantProblems=${project.invariantProblems}`
          )
      )
      .slice(0, 10)
      .join("\n");
    super(`pnpm hardlink relink did not converge\n${bad}`);
  }
}

function workerIds(workersDir: string): string[] {
  if (!existsSync(workersDir)) return [];
  return readdirSync(workersDir)
    .filter((entry) => {
      try {
        return statSync(join(workersDir, entry)).isDirectory();
      } catch {
        return false;
      }
    })
    .sort();
}

export function runForceRelinkWorkers(
  deps: PnpmHardlinksToolDeps,
  opts?: { dryRun?: boolean; includeOrphans?: boolean }
): WorkerRelinkSummary[] {
  const dryRun = opts?.dryRun ?? true;
  const activeIds = new Set(
    deps.registry
      .list()
      .filter((record) => record.status === "active")
      .map((record) => record.id)
  );
  const runningIds = new Set(deps.runningThreadIds());
  const summaries: WorkerRelinkSummary[] = [];

  for (const workerId of workerIds(deps.workersDir)) {
    const workerDir = join(deps.workersDir, workerId);
    if (runningIds.has(workerId)) {
      summaries.push({ workerId, skipped: "run in progress", projects: [] });
      continue;
    }
    if (!activeIds.has(workerId) && opts?.includeOrphans !== true) {
      summaries.push({ workerId, skipped: "not active in registry", projects: [] });
      continue;
    }

    const projects = [];
    for (const projectDir of findPnpmProjects(workerDir)) {
      const storeDir = resolvePnpmStoreDir(projectDir);
      ensurePnpmStoreDir(storeDir);
      const relink = relinkPnpmProject({ projectDir, storeDir, dryRun });
      const invariant = checkPnpmHardlinks({ projectDir, storeDir, sampleLimit: 64 });
      projects.push({
        projectDir,
        scanned: relink.scanned,
        relinked: relink.relinked,
        alreadyLinked: relink.alreadyLinked,
        missingStoreFile: relink.missingStoreFile,
        failed: relink.failed,
        // ISSUE_NUM: missing-store files (content not in the shared CAS → unlinkable) are benign,
        // not failures — exclude them from the convergence signal so a clean reclaim returns
        // success. Only real problems (not-linked after relink / not-same-inode) count here.
        invariantProblems: invariant.problems.filter((p) => p.reason !== "missing-store-file")
          .length,
      });
    }
    summaries.push({ workerId, projects });
  }

  if (
    !dryRun &&
    summaries.some((worker) =>
      worker.projects.some((project) => project.failed > 0 || project.invariantProblems > 0)
    )
  ) {
    throw new PnpmRelinkInvariantError(summaries);
  }

  return summaries;
}

export function createPnpmHardlinksMcpServer(
  deps: PnpmHardlinksToolDeps,
  selfId: string
): McpServer {
  const server = createMcpServer({ name: PNPM_HARDLINKS_MCP_NAME, version: "0.1.0" });

  server.registerTool(
    "force_relink_workers",
    {
      title: "Relink idle worker pnpm package files",
      description:
        "Root-only maintenance: host-side relink of idle worker node_modules package files to the shared pnpm store. Skips workers with active runs; defaults to dry-run.",
      inputSchema: {
        dry_run: z
          .boolean()
          .optional()
          .describe("Report what would be relinked without changing files. Defaults true."),
        include_orphans: z
          .boolean()
          .optional()
          .describe("Also inspect worker directories missing from the active registry."),
      },
    },
    async ({ dry_run, include_orphans }) => {
      try {
        if (selfId !== deps.rootId) {
          return toolError(
            `'${PNPM_HARDLINKS_MCP_NAME}' is a root-only tool — refusing to run it for '${selfId}'.`
          );
        }
        return toolOk(
          runForceRelinkWorkers(deps, {
            dryRun: dry_run ?? true,
            includeOrphans: include_orphans ?? false,
          })
        );
      } catch (err) {
        return toolError(err);
      }
    }
  );

  return server;
}
