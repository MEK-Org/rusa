import { randomUUID } from "node:crypto";
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { defaultGchatConfigDir } from "../chat/gchat-oauth.js";
import { instanceIdentityOf, leaderPeerOf, resolveHome } from "../config/loader.js";
import type { RusaConfig } from "../config/types.js";
import { closeDb, getRepositories, initDb } from "../db/index.js";
import type { Logger } from "../observability/logger.js";
import { createLogger } from "../observability/logger.js";
import { assertBwrapAvailable, setSandboxLogger } from "../providers/sandbox.js";
import {
  FollowerEventAcceptanceFailedError,
  type FollowerEventBatch,
  FollowerEventParkedError,
  FollowerEventQueue,
  type FollowerEventTransferSender,
  httpEventTransferSender,
} from "../remote-instances/follower-event-queue.js";
import { createFollowerFileOps } from "../remote-instances/follower-file-ops.js";
import type { FollowerCommand, FollowerEvent } from "../remote-instances/follower-hub.js";
import { FollowerInstance } from "../remote-instances/follower-instance.js";
import { isFullCommitSha } from "../remote-instances/follower-update-validation.js";
import {
  executeFollowerUpdate,
  type FollowerBuildSeam,
  type FollowerGitSeam,
} from "../remote-instances/follower-updater.js";
import {
  type BoundedExecutionCapability,
  type EventTransferCapability,
  type FollowerUpdateCommand,
  INSTANCE_PROTOCOL_VERSION,
} from "../remote-instances/protocol.js";
import { FollowerRunMaterial } from "../remote-instances/run-material.js";
import type { ResourceScope } from "../runtime/resource-scope.js";
import { readBuildSentinel } from "../update/build-sentinel.js";
import {
  BuildRunner,
  GitRunner,
  UPDATE_BUILD_TIMEOUT_MS,
  UPDATE_INSTALL_TIMEOUT_MS,
} from "../update/runner.js";
import { resolveRepoRoot } from "./service-instance.js";
import type { RunStartOptions } from "./start.js";
import {
  consumeSupportedStartFollowerLauncherContract,
  START_FOLLOWER_UPDATE_LAUNCHER_ENV,
  START_FOLLOWER_UPDATE_LAUNCHER_VERSION,
} from "./start-follower-launcher-contract.js";

export class FollowerHttpError extends Error {
  constructor(
    message: string,
    readonly status: number
  ) {
    super(message);
    this.name = "FollowerHttpError";
  }
}

/** The checkout and build a start-mode follower promotes for a leader update. */
export interface StartFollowerUpdateSource {
  git: FollowerGitSeam;
  build: FollowerBuildSeam;
  /** Bound on waiting for hosted actors before restart; the updater's default otherwise. */
  drainTimeoutMs?: number;
}

export interface StartFollowerRelease {
  /** Build-sentinel SHA of the dist this process booted from; absent when unproven. */
  runningSha?: string;
  /** Where updates come from, or why this launch cannot update itself. */
  update: StartFollowerUpdateSource | { unavailable: string };
}

// `restarting` is the last status the old process can truthfully emit. Bound its
// delivery so a dead leader connection cannot delay the restart indefinitely.
const RESTART_FLUSH_TIMEOUT_MS = 1500;

/**
 * Resolve the running release from the launched entry point. Self-update is
 * supported only when a supported launcher has explicitly asserted that a
 * clean exit restarts onto the same entry point, preserving home/config, and
 * `rusa start` runs from `packages/rusa/dist` of a git checkout.
 */
export function resolveStartFollowerRelease(log: Logger): StartFollowerRelease {
  const launcherContract = consumeSupportedStartFollowerLauncherContract();
  let distDir: string;
  try {
    distDir = dirname(realpathSync(resolve(process.argv[1] ?? "")));
  } catch {
    return { update: { unavailable: "Cannot resolve the rusa start entry point" } };
  }
  const sentinel = readBuildSentinel(distDir);
  const runningSha = sentinel && isFullCommitSha(sentinel) ? sentinel : undefined;
  const unsupported = (reason: string): StartFollowerRelease => ({
    runningSha,
    update: { unavailable: `Follower self-update is unsupported for this launch: ${reason}` },
  });
  if (!launcherContract) {
    return unsupported(
      `supported launcher contract is absent or unrecognized (expected ${START_FOLLOWER_UPDATE_LAUNCHER_ENV}=${START_FOLLOWER_UPDATE_LAUNCHER_VERSION})`
    );
  }
  if (basename(distDir) !== "dist") {
    return unsupported("rusa start is not running from a built dist directory");
  }
  const packageDir = dirname(distDir);
  let repoRoot: string;
  try {
    repoRoot = resolveRepoRoot(packageDir);
  } catch {
    return unsupported("the running build is not inside a git checkout");
  }
  try {
    const packageJson = JSON.parse(readFileSync(join(packageDir, "package.json"), "utf8")) as {
      name?: unknown;
    };
    if (
      packageJson.name !== "rusa" ||
      realpathSync(join(repoRoot, "packages", "rusa")) !== realpathSync(packageDir)
    ) {
      return unsupported("the running build is not packages/rusa of a rusa checkout");
    }
  } catch {
    return unsupported("the running build is not packages/rusa of a rusa checkout");
  }
  const buildLog = log.child({ component: "follower-update" });
  return {
    runningSha,
    update: {
      git: new GitRunner(repoRoot),
      build: new BuildRunner(
        packageDir,
        { installMs: UPDATE_INSTALL_TIMEOUT_MS, buildMs: UPDATE_BUILD_TIMEOUT_MS },
        (message) => buildLog.info("follower_update_build_progress", { message })
      ),
    },
  };
}

function resolveFollowerToken(config: RusaConfig): string {
  const leader = leaderPeerOf(config);
  if (leader?.token?.trim()) {
    return leader.token.trim();
  }
  if (leader?.tokenFile?.trim()) {
    const file = leader.tokenFile.trim();
    if (!existsSync(file)) {
      throw new Error(`Follower peer token file not found at: ${file}`);
    }
    const content = readFileSync(file, "utf8").trim();
    if (!content) {
      throw new Error(`Follower peer token file at ${file} is empty`);
    }
    return content;
  }
  throw new Error("A follower's leader peer entry requires token or tokenFile");
}

export async function composeFollowerStart(
  config: RusaConfig,
  opts: RunStartOptions | undefined,
  resources: ResourceScope,
  _bootLog: Logger
): Promise<void> {
  const mcHome = resolveHome();
  const token = resolveFollowerToken(config);
  const rawLeaderUrl = leaderPeerOf(config)?.url;
  if (!rawLeaderUrl) {
    throw new Error("config.yaml: a follower's leader peer entry requires url");
  }
  const leaderUrl = new URL(rawLeaderUrl);

  const log = createLogger({
    level: config.observability?.logging?.level,
    format: config.observability?.logging?.format,
    secrets: () => [token],
    context: { component: "follower" },
  });
  // As on the leader: sandbox-layer records carry this logger's scrubbing, and
  // a host that cannot sandbox actors fails before mesh.db opens.
  setSandboxLogger(log.child({ component: "sandbox" }));
  if (config.sandbox !== "container-boundary") {
    try {
      assertBwrapAvailable();
    } catch (err) {
      log.error("sandbox_unavailable", { sandbox: config.sandbox ?? "bwrap", err });
      process.exit(1);
      return;
    }
  }

  // 1. Open the local database; identity comes from config alone (#1019)
  initDb(mcHome);
  resources.acquire("database", () => closeDb());
  log.info("database_ready", { home: mcHome });

  const identity = instanceIdentityOf(config);
  if (identity.role !== "follower") throw new Error("Follower start requires a leader peer");
  const repos = getRepositories("follower");
  log.info("instance_identity_ready", { instanceId: identity.instanceId, role: identity.role });

  // An e2e composition must never reset and rebuild the checkout running it.
  const release: StartFollowerRelease = opts?.e2e
    ? (opts.e2e.followerRelease ?? {
        update: { unavailable: "Follower update has no isolated source in this e2e composition" },
      })
    : resolveStartFollowerRelease(log);
  log.info("follower_release_resolved", {
    runningSha: release.runningSha,
    updateUnavailable: "unavailable" in release.update ? release.update.unavailable : undefined,
  });

  // 2. Setup FollowerInstance with requireReconciliation = true
  const eventQueue = new FollowerEventQueue();
  let sendTimer: ReturnType<typeof setTimeout> | undefined;
  let stopped = false;
  let leaderToken: string | undefined;
  let session = "";
  /** Event transfer as advertised by the current registration; absent from older leaders. */
  let eventTransfer: FollowerEventTransferSender | undefined;
  const generation = randomUUID();
  // Shutdown cancels the pending poll and any backoff, then joins the loop.
  const stopPolling = new AbortController();
  let polling: Promise<void> | undefined;

  function pause(ms: number): Promise<void> {
    return new Promise((resolve) => {
      const done = () => {
        clearTimeout(timer);
        stopPolling.signal.removeEventListener("abort", done);
        resolve();
      };
      const timer = setTimeout(done, ms);
      stopPolling.signal.addEventListener("abort", done, { once: true });
    });
  }

  function request(
    path: string,
    body: object | string,
    signal: AbortSignal = AbortSignal.timeout(25_000)
  ): Promise<Response> {
    const headers: Record<string, string> = {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
    };
    if (leaderToken) {
      headers["x-leader-token"] = leaderToken;
    }
    return fetch(new URL(path, leaderUrl), {
      method: "POST",
      headers,
      body:
        typeof body === "string"
          ? body
          : JSON.stringify({ id: identity.instanceId, session, ...body }),
      signal,
    });
  }

  async function post<T>(path: string, body: object, signal?: AbortSignal): Promise<T> {
    const response = await request(path, body, signal);
    if (!response.ok) {
      throw new FollowerHttpError(`Leader ${path}: HTTP ${response.status}`, response.status);
    }
    return (await response.json()) as T;
  }

  async function postEvents(batch: FollowerEventBatch): Promise<void> {
    const response = await request("/events", batch.body);
    if (response.ok) return;
    if (response.status === 409) {
      const refusal = (await response.json().catch(() => undefined)) as
        | { reason?: unknown; eventId?: unknown }
        | undefined;
      if (refusal?.reason === "acceptance_failed" && typeof refusal.eventId === "string") {
        throw new FollowerEventAcceptanceFailedError(refusal.eventId);
      }
    }
    throw new FollowerHttpError(`Leader /events: HTTP ${response.status}`, response.status);
  }

  async function flush(): Promise<void> {
    // A 410 clears the registration before the poll loop can obtain its next
    // session. Keep queued bytes local during that gap; an empty session is
    // neither an authentication retry nor an incarnation fence.
    if (stopped || !session) return;
    try {
      await eventQueue.flush(postEvents, { id: identity.instanceId, session }, eventTransfer);
    } catch (err) {
      if (err instanceof FollowerEventParkedError) {
        // Retrying cannot change the outcome; a new registration or capability
        // does, and the next poll flushes. Later events wait behind this one.
        if (!err.repeated) {
          log.warn("follower_event_parked", {
            reason: err.reason,
            eventId: err.eventId,
            eventType: err.eventType,
            eventBytes: err.eventBytes,
            limitBytes: err.limitBytes,
            eventTransfer: eventTransfer?.capability,
          });
        }
        return;
      }
      log.warn("follower_event_flush_failed", { err });
      if (err instanceof FollowerHttpError && err.status === 410) {
        session = "";
      }
    }
  }

  function emit(actorId: string, message: FollowerEvent["message"], eventId?: string): void {
    if (stopped) return;
    eventQueue.enqueue({ eventId: eventId ?? randomUUID(), actorId, message });
    if (!eventQueue.isFlushing && !sendTimer) {
      sendTimer = setTimeout(() => {
        sendTimer = undefined;
        void flush();
      }, 5);
    }
  }

  // Prompts and output of runs executed here stay here once the leader
  // negotiates bounded execution (#1020).
  const runMaterial = new FollowerRunMaterial(mcHome);
  const stopMaterialSweep = runMaterial.startSweeping((err) =>
    log.warn("run_material_sweep_failed", { err })
  );
  resources.acquire("runMaterialSweep", stopMaterialSweep);
  const instance = new FollowerInstance(
    mcHome,
    config.sandbox === "bwrap",
    (event) => emit(event.actorId, event.message, event.eventId),
    opts?.e2e?.followerProviderFactory,
    {
      requireReconciliation: true,
      repositories: repos,
      // Provider executable settings are host-local. The leader still owns
      // the admitted provider/model tuple carried in each actor Bootstrap.
      providerOptions: { providers: config.providers },
      // This follower's own Google credentials, never the leader's (#1013).
      fileOps: createFollowerFileOps({
        credentialDir: config.chat?.gchatConfigDir ?? defaultGchatConfigDir(),
      }),
      material: runMaterial.options,
    }
  );
  resources.acquire("followerInstance", async () => {
    stopped = true;
    if (sendTimer) clearTimeout(sendTimer);
    instance.close();
    // `actorIds` now stays populated until a started run has finished its
    // terminal local accounting. A provider that ignores interruption cannot
    // keep an open local row past the database disposer.
    const drain = await instance.waitForQuiescence(5000);
    const abandonReason = drain.quiesced
      ? "follower shutdown accounting reconciliation"
      : "follower shutdown drain timed out";
    try {
      // A terminal write can fail after a provider has unwound and removed its
      // Actor from the instance. Reconcile open local rows even after a
      // quiescent drain; the transport is already stopped, so the durable row
      // and local log are the shutdown receipt.
      const markedInterrupted = repos.actorRuns.abandonOpen(abandonReason);
      if (!drain.quiesced) {
        log.warn("follower_shutdown_drain_timed_out", {
          ...drain,
          markedInterrupted,
        });
      } else if (markedInterrupted > 0) {
        log.error("follower_shutdown_accounting_reconciled", {
          ...drain,
          markedInterrupted,
        });
      }
    } catch (err) {
      // The database disposer will run after this resource regardless. This
      // is the only observable receipt when the reconciliation itself cannot
      // persist because event transport has already stopped.
      log.error("follower_shutdown_accounting_reconciliation_failed", {
        ...drain,
        err: err instanceof Error ? err.message : String(err),
      });
    }
  });

  // 3. Register with leader and reconcile peer state
  const registerWithLeader = async (): Promise<boolean> => {
    try {
      const reg = await post<{
        session: string;
        protocolVersion: number;
        leaderToken?: string;
        eventTransfer?: EventTransferCapability;
        boundedExecution?: BoundedExecutionCapability;
      }>("/register", {
        platform: process.platform,
        pid: process.pid,
        generation,
        protocolVersion: INSTANCE_PROTOCOL_VERSION,
        // The leader's update reconciliation compares this with its target.
        ...(release.runningSha ? { commitSha: release.runningSha } : {}),
        boundedExecution: runMaterial.offer,
      });
      if (reg.protocolVersion !== INSTANCE_PROTOCOL_VERSION) {
        log.warn("follower_protocol_mismatch", {
          expected: INSTANCE_PROTOCOL_VERSION,
          received: reg.protocolVersion,
        });
        return false;
      }
      if (leaderToken && reg.leaderToken && reg.leaderToken !== leaderToken) {
        // A different leader incarnation must never receive events queued for
        // the old one. `session` alone is not an incarnation fence.
        eventQueue.clear();
        log.info("follower_leader_restarted_fencing_pending_events", {
          oldLeaderToken: leaderToken,
          newLeaderToken: reg.leaderToken,
        });
      }
      session = reg.session;
      if (reg.leaderToken) leaderToken = reg.leaderToken;
      runMaterial.accept(reg.boundedExecution);
      eventTransfer = httpEventTransferSender(
        reg.eventTransfer,
        (fragment) => request("/events/transfer", fragment),
        (message, status) => new FollowerHttpError(message, status)
      );
      // A registration answered after shutdown began still holds a leader
      // session. Keep it for the peer disposer to unregister; start nothing.
      if (stopped) return false;
      instance.markReconciled();
      log.info("follower_registered_and_reconciled", {
        leader: leaderUrl.origin,
        session,
        instanceId: identity.instanceId,
      });
      return true;
    } catch (err) {
      log.warn("follower_registration_failed", {
        err: err instanceof Error ? err.message : String(err),
      });
      return false;
    }
  };

  resources.acquire("followerPeer", async () => {
    stopped = true;
    // Join the loop before unregistering: no poll answered after this point
    // dispatches, and a registration still in flight has recorded its session.
    stopPolling.abort();
    await polling;
    if (session) {
      await post("/unregister", {}).catch(() => {});
    }
  });

  const onSignal = async () => {
    await resources.close();
    process.exit(0);
  };
  process.on("SIGINT", onSignal);
  process.on("SIGTERM", onSignal);
  resources.acquire("signalListeners", () => {
    process.off("SIGINT", onSignal);
    process.off("SIGTERM", onSignal);
  });

  const restart = async (code: number): Promise<void> => {
    if (sendTimer) clearTimeout(sendTimer);
    sendTimer = undefined;
    let flushTimer: ReturnType<typeof setTimeout> | undefined;
    await Promise.race([
      flush(),
      new Promise<void>((resolveTimeout) => {
        flushTimer = setTimeout(resolveTimeout, RESTART_FLUSH_TIMEOUT_MS);
      }),
    ]);
    clearTimeout(flushTimer);
    log.info("follower_update_restarting", { code });
    await resources.close();
    process.exit(code);
  };

  const handleUpdate = async (command: FollowerUpdateCommand): Promise<void> => {
    log.info("follower_update_received", {
      updateId: command.updateId,
      targetSha: command.targetSha,
      branch: command.branch,
    });
    const source = release.update;
    if ("unavailable" in source) {
      // Never silently drop an authenticated update command.
      log.warn("follower_update_unavailable", {
        updateId: command.updateId,
        error: source.unavailable,
      });
      emit("$instance", {
        type: "update_status",
        updateId: command.updateId,
        status: "failed",
        error: source.unavailable,
      });
      return;
    }
    const updateLog = log.child({ component: "follower-update" });
    await executeFollowerUpdate(
      {
        updateId: command.updateId,
        targetSha: command.targetSha,
        branch: command.branch,
        drainTimeoutMs: source.drainTimeoutMs,
        // The checkout can reach the target without this process running it.
        runningSha: release.runningSha ?? null,
      },
      {
        git: source.git,
        build: source.build,
        drain: {
          drain: async (timeoutMs) => {
            instance.beginDrain();
            const outcome = await instance.waitForQuiescence(timeoutMs);
            log.info("follower_update_drain_complete", outcome);
            return outcome;
          },
        },
        emitter: { emitStatus: (statusEvent) => emit("$instance", statusEvent) },
        exit: restart,
        log: (message) => updateLog.info("follower_update_progress", { message }),
      }
    );
    await flush();
  };

  const startPolling = () => {
    polling = (async () => {
      let backoffMs = 500;
      while (!stopped) {
        if (!session) {
          const ok = await registerWithLeader();
          if (stopped) break;
          if (!ok) {
            await pause(backoffMs);
            backoffMs = Math.min(backoffMs * 2, 10_000);
            continue;
          }
          backoffMs = 500;
        }
        try {
          if (eventQueue.hasPending && !eventQueue.isFlushing) void flush();
          const commands = await post<FollowerCommand[]>(
            "/poll",
            { parkedEvent: eventQueue.parkedHead ?? null },
            AbortSignal.any([AbortSignal.timeout(25_000), stopPolling.signal])
          );
          if (stopped) break;
          for (const command of commands) {
            if ("actorId" in command) {
              instance.dispatch(command);
            } else if (command.type === "update") {
              void handleUpdate(command);
            }
          }
          backoffMs = 500;
        } catch (err) {
          if (stopped) break;
          if (err instanceof FollowerHttpError && err.status === 410) {
            log.info("follower_session_expired", { leader: leaderUrl.origin });
            session = "";
          } else {
            // As in the retained follower entry point: back off exponentially
            // while the leader keeps failing polls, and reset on the next success.
            log.warn("follower_poll_error", { err, retryInMs: backoffMs });
            await pause(backoffMs);
            backoffMs = Math.min(backoffMs * 2, 10_000);
          }
        }
      }
    })();
  };

  if (opts?.e2e?.onFollowerReady) {
    if (opts.e2e.connectPeer !== false) {
      const ok = await registerWithLeader();
      if (!ok) {
        throw new Error(`Follower e2e registration with leader ${leaderUrl.origin} failed`);
      }
    }
    opts.e2e.onFollowerReady({
      instance,
      instanceIdentity: identity,
      shutdown: async () => {
        await resources.close();
      },
    });
    if (opts.e2e.followerPolling) startPolling();
    return;
  }

  // Normal daemon mode: register with leader and start poll loop
  startPolling();
}
