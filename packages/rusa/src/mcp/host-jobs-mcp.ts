import { randomUUID } from "node:crypto";
import { rmSync } from "node:fs";
import { join } from "node:path";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import {
  hostJobAuditArtifactDir,
  writeHostJobAuditArtifact,
} from "../actor/host-job-audit-artifact.js";
import {
  buildHostJobBwrapArgs,
  buildSystemdRunArgv,
  MAX_CONCURRENT_ACTIVE_JOBS_PER_ACTOR,
  queryHostJobUnitStatus,
  resolveRuntimeMaxSec,
  spawnHostJob,
  stopHostJobUnit,
  wakeOnExitScriptPath,
  writeHostJobScript,
} from "../actor/host-job-runner.js";
import type { HostJobRecord, HostJobStore } from "../actor/host-job-store.js";
import type { MeshEventSink } from "../actor/mesh-events.js";
import { toolError, toolOk } from "./result.js";
import { createMcpServer } from "./strict-server.js";

export const HOST_JOBS_MCP_NAME = "host-jobs";

export interface HostJobsMcpDeps {
  store: HostJobStore;
  /** The SAME handle-derivation start.ts threads everywhere else — never re-derived ad hoc. */
  handleForId: (actorId: string) => string;
  /** The mesh's own state/secrets root — also the host-jobs scratch/script install root. */
  mcHome: string;
  recordEvent: MeshEventSink;
  now?: () => string;
}

/**
 * Skips blank lines AND the shebang — every submitted script is `/bin/sh`, so
 * the first non-blank line is always literally `#!/bin/sh`, making a naive
 * "first non-blank line" label useless for telling jobs apart in `list_jobs`.
 */
function scriptLabelFor(script: string): string {
  const firstLine = script
    .split("\n")
    .map((line) => line.trim())
    .find((line) => line.length > 0 && !line.startsWith("#!"));
  return firstLine ? firstLine.slice(0, 80) : "(empty script)";
}

function scratchDirFor(mcHome: string, unitName: string): string {
  return join(mcHome, "host-jobs", unitName);
}

/**
 * Only the owning actor may see/status/stop a job. A missing id and someone
 * else's job throw the identical message, so job existence never leaks across
 * actors through this surface.
 */
function requireOwnJob(store: HostJobStore, id: string, selfId: string): HostJobRecord {
  const job = store.get(id);
  if (!job || job.actorId !== selfId) {
    throw new Error(`host-jobs: no such job "${id}"`);
  }
  return job;
}

/**
 * Grantable MCP wrapper for host-plane job submission : submit/list/status/stop
 * over a transient `systemd-run --user` unit wrapping a deny-by-default bwrap sandbox
 * (see `host-job-runner.ts`). `selfId` is baked in at mount time by the
 * grantable-servers wiring, and every store call here is scoped to it — one actor
 * can never see or touch another's jobs through this surface.
 */
export function createHostJobsServer(
  deps: HostJobsMcpDeps,
  selfId: string,
  options?: { isFenced?: () => boolean }
): McpServer {
  const server = createMcpServer(
    { name: HOST_JOBS_MCP_NAME, version: "0.1.0" },
    { isFenced: options?.isFenced }
  );
  const now = deps.now ?? (() => new Date().toISOString());

  server.registerTool(
    "submit_job",
    {
      title: "Submit a host-plane job",
      description:
        "Run a shell script as a transient systemd-run --user unit inside a deny-by-default bwrap " +
        "sandbox. The job can read nothing beyond base OS/toolchain visibility unless " +
        "manifest.readPaths explicitly allow-lists a path — credential stores (~/.rusa, ~/.ssh, " +
        "~/.config/gh, ~/.npmrc, etc.) are always denied, even if listed. Capped at " +
        `${MAX_CONCURRENT_ACTIVE_JOBS_PER_ACTOR} concurrently active jobs per actor.`,
      inputSchema: {
        script: z.string().min(1).describe("Inline shell script text (run via /bin/sh)."),
        args: z.array(z.string()).default([]).describe("Positional args passed to the script."),
        manifest: z
          .object({ readPaths: z.array(z.string()).default([]) })
          .default({ readPaths: [] })
          .describe("Deny-by-default read-scope allow-list. Empty by default."),
        runtimeMaxSec: z
          .number()
          .positive()
          .optional()
          .describe(
            "RuntimeMaxSec override in seconds; defaults to 48h, capped at a hard ceiling."
          ),
      },
    },
    async ({ script, args, manifest, runtimeMaxSec }) => {
      try {
        if (deps.store.activeCountFor(selfId) >= MAX_CONCURRENT_ACTIVE_JOBS_PER_ACTOR) {
          throw new Error(
            `host-jobs: at the ${MAX_CONCURRENT_ACTIVE_JOBS_PER_ACTOR}-active-job cap for this actor — ` +
              "stop or wait for one to exit first"
          );
        }
        const resolvedRuntimeMaxSec = resolveRuntimeMaxSec(runtimeMaxSec);
        const id = randomUUID();
        const unitName = `job-${deps.handleForId(selfId)}-${id.slice(0, 8)}`;
        const scratchDir = scratchDirFor(deps.mcHome, unitName);

        // Validate the manifest + build the bwrap argv FIRST — a rejected
        // manifest throws here, before anything touches disk, so no orphan
        // scratch dir or audit artifact is ever left behind .
        const bwrapArgs = buildHostJobBwrapArgs({ mcHome: deps.mcHome, scratchDir, manifest });

        // Deterministic ahead of the write itself, so cleanup below can find
        // it even if writeHostJobAuditArtifact throws partway through.
        const auditArtifactPath = join(hostJobAuditArtifactDir(deps.mcHome), `${id}.json`);

        // Everything from here through a successful spawnHostJob touches disk
        // or spawns a process; any failure in this window must purge whatever
        // was already materialized so nothing orphans (ISSUE_NUM's write-then-fail
        // window covers script/audit writes, not just the spawn call itself).
        const submittedAt = now();
        let durablyRecorded = false;
        let auditArtifact: { path: string; sha256: string };
        try {
          const scriptPath = writeHostJobScript(scratchDir, script);
          auditArtifact = writeHostJobAuditArtifact(deps.mcHome, {
            jobId: id,
            script,
            args,
            manifest,
          });
          const argv = buildSystemdRunArgv({
            jobId: id,
            unitName,
            scratchDir,
            runtimeMaxSec: resolvedRuntimeMaxSec,
            wakeOnExitScriptPath: wakeOnExitScriptPath(deps.mcHome),
            submitterActorId: selfId,
            bwrapArgs,
            scriptPath,
            scriptArgs: args,
          });
          // Durable record BEFORE the launch, never after. The store is SQLite
          // now, so `submit` can fail (constraint, busy, I/O) where the retired
          // file store swallowed the write and kept an in-process copy. Ordered
          // the other way, a failed write would leave a unit systemd had already
          // accepted with no row to list, stop or route its exit through. Here
          // the failure lands before anything is running.
          deps.store.submit({
            id,
            actorId: selfId,
            unitName,
            scriptLabel: scriptLabelFor(script),
            manifest,
            auditArtifactPath: auditArtifact.path,
            auditArtifactSha256: auditArtifact.sha256,
            runtimeMaxSec: resolvedRuntimeMaxSec,
            submittedAt,
          });
          durablyRecorded = true;
          spawnHostJob(argv);
        } catch (err) {
          // The job never actually started — purge what we may have written
          // so it doesn't linger as an orphan .
          rmSync(scratchDir, { recursive: true, force: true });
          if (durablyRecorded) {
            // A row exists for a launch that failed. Close it out instead of
            // deleting it: the record of an attempted submit is audit history
            // like any other, and leaving it open would hold one of the actor's
            // concurrency slots against a unit that does not exist. Its audit
            // artifact stays on disk so the pointer the row carries resolves.
            // If this compensating write fails too, the original failure is
            // still what the caller is told, and the row stays visible and
            // stoppable rather than silently gone.
            try {
              deps.store.recordExit(id, now(), "launch-failed");
            } catch {
              /* best effort — the original error below is the one that matters */
            }
          } else {
            rmSync(auditArtifactPath, { force: true });
          }
          throw err;
        }

        deps.recordEvent({
          kind: "host_job_submitted",
          actorId: selfId,
          detail: `${unitName} audit=${auditArtifact.path} sha256=${auditArtifact.sha256}`,
        });

        return toolOk({ id, unitName, submittedAt, runtimeMaxSec: resolvedRuntimeMaxSec });
      } catch (err) {
        return toolError(err);
      }
    }
  );

  server.registerTool(
    "list_jobs",
    {
      title: "List my host-plane jobs",
      description: "List every job this actor has submitted, most recent first.",
      inputSchema: {},
    },
    async () => {
      try {
        const jobs = deps.store
          .listFor(selfId)
          .sort((a, b) => b.submittedAt.localeCompare(a.submittedAt));
        return toolOk(jobs);
      } catch (err) {
        return toolError(err);
      }
    }
  );

  server.registerTool(
    "job_status",
    {
      title: "Check a host-plane job's live status",
      description:
        "Return the stored job record plus a live `systemctl --user show` summary " +
        "(ActiveState/SubState/Result).",
      inputSchema: { id: z.string().describe("The job id returned by submit_job.") },
    },
    async ({ id }) => {
      try {
        const job = requireOwnJob(deps.store, id, selfId);
        return toolOk({ ...job, liveStatus: queryHostJobUnitStatus(job.unitName) });
      } catch (err) {
        return toolError(err);
      }
    }
  );

  server.registerTool(
    "stop_job",
    {
      title: "Stop a host-plane job",
      description:
        "Stop a job's unit by its server-resolved unit name (never a client-supplied name). " +
        "ExecStopPost still fires and wakes this actor with the exit result.",
      inputSchema: { id: z.string().describe("The job id returned by submit_job.") },
    },
    async ({ id }) => {
      try {
        const job = requireOwnJob(deps.store, id, selfId);
        stopHostJobUnit(job.unitName);
        const stopRequestedAt = now();
        deps.store.recordStopRequested(id, stopRequestedAt);
        deps.recordEvent({ kind: "host_job_stopped", actorId: selfId, detail: job.unitName });
        return toolOk({ id, unitName: job.unitName, stopRequestedAt });
      } catch (err) {
        return toolError(err);
      }
    }
  );

  return server;
}
