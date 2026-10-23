import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { stringify as toYaml } from "yaml";
import type { PromptBuild } from "../actor/actor.js";
import {
  assemblePortableContext,
  PORTABLE_CONTEXT_MAX_BYTES,
  portableReadWindow,
} from "../actor/portable-context.js";
import { type InstanceIdentity, loadConfig } from "../config/index.js";
import { closeDb, getDb, getRepositories, initDb } from "../db/index.js";
import { ActorRunRepository } from "../db/repositories/actor-run-repository.js";
import { HostRunReceiptRepository } from "../db/repositories/run-receipt-repository.js";
import type { RunOptions } from "../providers/types.js";
import type { FollowerCommand } from "../remote-instances/follower-hub.js";
import { FollowerInstance } from "../remote-instances/follower-instance.js";
import { createHarness, waitUntil } from "../remote-instances/harness.js";
import {
  EVENT_TRANSFER_CAPABILITY,
  type EventTransferFragment,
  INSTANCE_PROTOCOL_VERSION,
  type ProviderFactory,
} from "../remote-instances/protocol.js";
import { runStart } from "./start.js";

interface SyntheticRequestMessage {
  type?: string;
  requestId?: number;
  request?: {
    op?: string;
    mode?: string;
    [key: string]: unknown;
  };
  /** Set on `runStart`. */
  runId?: string;
  injectRecord?: { sourceEventIds: string[] };
  [key: string]: unknown;
}

interface SyntheticEvent {
  eventId: string;
  actorId: string;
  message?: SyntheticRequestMessage;
}

interface ActorRunRow {
  id: string;
  actor_id: string;
  outcome: string;
  success: number;
  exit_code: number;
  output?: string | null;
  abandon_reason?: string | null;
}

interface RunPromptRow {
  prompt: string;
}

// The real bwrap preflight runs unless a test makes it fail.
const sandboxMock = vi.hoisted(() => ({ bwrapMissing: false }));
vi.mock("../providers/sandbox.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../providers/sandbox.js")>();
  return {
    ...actual,
    assertBwrapAvailable: () => {
      if (sandboxMock.bwrapMissing) throw new Error("bubblewrap (bwrap) is required");
      actual.assertBwrapAvailable();
    },
  };
});

const originalHome = process.env.RUSA_HOME;
const tempDirs: string[] = [];

function makeTempHome(): string {
  const dir = mkdtempSync(join(tmpdir(), "rusa-start-roles-test-"));
  tempDirs.push(dir);
  return dir;
}

function writeConfigFile(home: string, config: Record<string, unknown>): void {
  writeFileSync(join(home, "config.yaml"), toYaml(config), "utf8");
}

type SyntheticRoute = (path: string, body: Record<string, unknown>, res: ServerResponse) => void;

/** A synthetic leader over real HTTP; held responses are closed with it. */
async function startSyntheticLeader(route: SyntheticRoute) {
  const server = createServer((req, res) => {
    let raw = "";
    req.on("data", (chunk) => {
      raw += chunk;
    });
    req.on("end", () => {
      const path = new URL(req.url ?? "/", `http://${req.headers.host}`).pathname;
      route(path, raw ? (JSON.parse(raw) as Record<string, unknown>) : {}, res);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return {
    url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.closeAllConnections();
        server.close((error) => (error ? reject(error) : resolve()));
      }),
  };
}

function replyJson(res: ServerResponse, body: unknown, status = 200): void {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}

let originalExit: typeof process.exit;

beforeEach(() => {
  originalExit = process.exit;
  process.exit = vi.fn() as unknown as typeof process.exit;
});

afterEach(() => {
  // Accounting-fault tests spy on the repository prototype the follower's
  // frozen capabilities delegate to; later tests must see the real writer.
  vi.restoreAllMocks();
  process.exit = originalExit;
  closeDb();
  if (originalHome !== undefined) {
    process.env.RUSA_HOME = originalHome;
  } else {
    delete process.env.RUSA_HOME;
  }
  for (const dir of tempDirs) {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {}
  }
  tempDirs.length = 0;
});

describe("shared startup, role authority, and local database (#1019)", () => {
  it("keeps a leader's config identity across real restarts and persists its local runs and prompts", async () => {
    const home = makeTempHome();
    process.env.RUSA_HOME = home;

    writeConfigFile(home, {
      providers: { fake: {} },
      github: { account: "test-account" },
      webhook: { port: 9742, secret: "secret" },
      instance: { id: "leader-node-alpha" },
    });

    const dbPath = join(home, "data", "mesh.db");
    const runRows = (actorId: string) =>
      getDb()
        .prepare(
          "SELECT r.id, r.outcome, p.prompt FROM actor_runs r JOIN run_prompts p ON p.run_id = r.id WHERE r.actor_id = ?"
        )
        .all(actorId) as Array<{ id: string; outcome: string; prompt: string }>;

    // Boot 1: run one local worker to completion, then shut down.
    let workerId = "";
    let firstRuns: Array<{ id: string; outcome: string; prompt: string }> = [];
    await new Promise<void>((resolve, reject) => {
      const start = runStart({
        e2e: {
          onReady: async (handles) => {
            try {
              expect(handles.instanceIdentity).toEqual({
                role: "leader",
                instanceId: "leader-node-alpha",
              });
              workerId = handles.mesh.spawn({
                charter: "Leader local persistence fixture",
                parentId: null,
                modelConfig: { provider: "fake", model: "fake-model" },
              });
              expect(handles.mesh.deliverWake(workerId, "record a local run")).toBe(true);
              await waitUntil(() => runRows(workerId).some((run) => run.outcome === "completed"));
              firstRuns = runRows(workerId);
            } finally {
              await handles.shutdown();
            }
            resolve();
          },
        },
      });
      void start.catch(reject);
    });
    expect(firstRuns.length).toBeGreaterThanOrEqual(1);
    expect(firstRuns[0]?.prompt).toContain("Leader local persistence fixture");

    // Boot 2 over the same home: the same identity, and boot 1's records survive.
    let secondIdentity: InstanceIdentity | undefined;
    let secondRuns: typeof firstRuns = [];
    await new Promise<void>((resolve, reject) => {
      const start = runStart({
        e2e: {
          onReady: async (handles) => {
            try {
              secondIdentity = handles.instanceIdentity;
              secondRuns = runRows(workerId);
            } finally {
              await handles.shutdown();
            }
            resolve();
          },
        },
      });
      void start.catch(reject);
    });
    expect(secondIdentity).toEqual({ role: "leader", instanceId: "leader-node-alpha" });
    expect(secondRuns).toEqual(firstRuns);

    // Identity lives in config only; mesh.db holds no identity table.
    const db = new Database(dbPath);
    expect(
      db.prepare("SELECT name FROM sqlite_master WHERE name = 'instance_identity'").get()
    ).toBeUndefined();
    db.close();
  }, 30_000);

  it("releases leader startup resources before propagating an E2E driver failure", async () => {
    const home = makeTempHome();
    process.env.RUSA_HOME = home;
    writeConfigFile(home, {
      providers: { fake: {} },
      github: { account: "test-account" },
      webhook: { port: 9742, secret: "secret" },
      instance: { id: "leader-failed-driver" },
    });

    const failure = new Error("forced leader e2e driver failure");
    const start = runStart({
      e2e: {
        onReady: async (handles) => {
          expect(handles.instanceIdentity).toEqual({
            role: "leader",
            instanceId: "leader-failed-driver",
          });
          throw failure;
        },
      },
    });

    // This is the same continuation the restart fixtures use (`start.catch(reject)`):
    // it must not observe the original driver failure until runStart has closed its
    // resource scope.
    const failureAfterDisposal = start.then(
      () => {
        throw new Error("leader start unexpectedly completed");
      },
      (error) => {
        expect(() => getDb()).toThrow("Database not initialized");
        return error;
      }
    );

    let timeout: ReturnType<typeof setTimeout> | undefined;
    const finishesPromptly = Promise.race([
      failureAfterDisposal,
      new Promise<never>((_, reject) => {
        timeout = setTimeout(
          () => reject(new Error("leader cleanup did not finish promptly")),
          1_000
        );
      }),
    ]).finally(() => {
      if (timeout) clearTimeout(timeout);
    });
    await expect(finishesPromptly).resolves.toBe(failure);
  });

  it("keeps a follower's config identity across real restarts without rootActor", async () => {
    const home = makeTempHome();
    process.env.RUSA_HOME = home;

    writeConfigFile(home, {
      providers: { codex: { cliCommand: "codex" } },
      peers: [{ type: "leader", url: "http://127.0.0.1:8190", token: "test-follower-token" }],
      instance: {
        id: "worker-node-alpha",
      },
    });

    for (let boot = 0; boot < 2; boot++) {
      let followerShutdown: (() => Promise<void>) | undefined;
      await runStart({
        e2e: {
          connectPeer: false,
          onFollowerReady: (handles) => {
            expect(handles.instanceIdentity).toEqual({
              role: "follower",
              instanceId: "worker-node-alpha",
            });
            followerShutdown = handles.shutdown;
          },
        },
      });
      expect(followerShutdown).toBeDefined();
      if (followerShutdown) await followerShutdown();
    }

    const db = new Database(join(home, "data", "mesh.db"));
    expect(
      db.prepare("SELECT name FROM sqlite_master WHERE name = 'instance_identity'").get()
    ).toBeUndefined();
    db.close();
  }, 20_000);

  it("fails a follower boot without bwrap before mesh.db opens or enrollment starts", async () => {
    const home = makeTempHome();
    process.env.RUSA_HOME = home;
    writeConfigFile(home, {
      providers: { codex: { cliCommand: "codex" } },
      peers: [{ type: "leader", url: "http://127.0.0.1:1", token: "test-follower-token" }],
      instance: { id: "worker-node-no-bwrap" },
    });
    const onFollowerReady = vi.fn();
    sandboxMock.bwrapMissing = true;
    try {
      await runStart({ e2e: { onFollowerReady } });
    } finally {
      sandboxMock.bwrapMissing = false;
    }
    expect(process.exit).toHaveBeenCalledWith(1);
    expect(onFollowerReady).not.toHaveBeenCalled();
    expect(existsSync(join(home, "data", "mesh.db"))).toBe(false);
  });

  it("enforces follower role authority: blocks global control writes while recording execution via follower composition", async () => {
    const home = makeTempHome();
    initDb(home);

    const repos = getRepositories("follower");
    const untyped = repos as unknown as Record<string, unknown>;

    // The follower gets its run capabilities only; global control is absent.
    expect(Object.keys(repos).sort()).toEqual(["actorRuns", "runPrompts"]);
    expect(untyped.obligations).toBeUndefined();
    expect(untyped.actors).toBeUndefined();
    expect(untyped.principals).toBeUndefined();
    expect(untyped.capabilityGrants).toBeUndefined();
    expect(() => {
      (untyped.obligations as { create: () => void }).create();
    }).toThrow(TypeError);

    // Follower actor execution writes execution state (actorRuns and runPrompts)
    // through the follower composition rather than direct repo writes
    const h = createHarness({
      cwd: home,
      repositories: repos,
    });

    const actorId = h.spawn("Execute via follower composition");
    await waitUntil(() => h.events.some((e) => e.actorId === actorId && e.event.type === "result"));

    // Verify local execution records retained in follower mesh.db
    const completedRuns = repos.actorRuns.listRecentCompleted(actorId, 5);
    expect(completedRuns.length).toBeGreaterThanOrEqual(1);
    const run = completedRuns[0];
    expect(run.actorId).toBe(actorId);
    expect(run.outcome).toBe("completed");
    expect(run.success).toBe(true);

    const promptRecord = getDb()
      .prepare("SELECT prompt FROM run_prompts WHERE run_id = ?")
      .get(run.id) as RunPromptRow | undefined;
    expect(promptRecord?.prompt).toContain("Execute via follower composition");

    await h.close();
    closeDb();
  });

  it("refuses follower dispatch before peer reconciliation completes", () => {
    const home = makeTempHome();
    const follower = new FollowerInstance(home, false, () => {}, undefined, {
      requireReconciliation: true,
    });

    expect(follower.isReconciled).toBe(false);

    // Attempting to dispatch an actor command before reconciliation must be refused
    expect(() => {
      follower.dispatch({
        actorId: "actor-unreconciled",
        message: {
          type: "init",
          bootstrap: {
            id: "actor-unreconciled",
            charter: "test charter",
            actorOptions: {},
          } as unknown as Parameters<typeof follower.dispatch>[0]["message"] extends {
            type: "init";
            bootstrap: infer B;
          }
            ? B
            : never,
        },
      });
    }).toThrow(/Follower instance is not reconciled with leader; dispatch refused/);

    // After peer reconciliation
    follower.markReconciled();
    expect(follower.isReconciled).toBe(true);

    follower.close();
  });

  it("reports a local accounting write failure without representing it as persisted", async () => {
    const home = makeTempHome();
    initDb(home);
    const repos = getRepositories("follower");
    vi.spyOn(ActorRunRepository.prototype, "start").mockImplementation(() => {
      throw new Error("synthetic local database write failure");
    });

    const harness = createHarness({ cwd: home, repositories: repos });
    const actorId = harness.spawn("Report local accounting failures");
    await waitUntil(() =>
      harness.events.some((entry) => entry.actorId === actorId && entry.event.type === "result")
    );
    await waitUntil(() =>
      harness.events.some(
        (entry) =>
          entry.actorId === actorId &&
          entry.event.type === "error" &&
          entry.event.error.includes("Local start accounting failed")
      )
    );

    expect(repos.actorRuns.listRecentCompleted(actorId, 5)).toEqual([]);
    expect(
      harness.events.some(
        (entry) =>
          entry.actorId === actorId &&
          entry.event.type === "error" &&
          entry.event.error.includes("Local terminal accounting failed")
      )
    ).toBe(true);

    await harness.close();
    closeDb();
  });

  it("validates conflicting and invalid configurations before side effects", async () => {
    const leader = { type: "leader", url: "http://127.0.0.1:8190", token: "secret" };
    const gateway = { bind: "127.0.0.1", port: 8190, tokenFile: "/path/to/token" };
    const rootActor = { provider: "codex", model: "gpt-5.6-sol" };
    const cases: Array<{ config: Record<string, unknown>; error: RegExp }> = [
      // Removed top-level role key
      { config: { role: "follower" }, error: /top-level role and peer are not supported/ },
      // Follower configuring followers gateway
      {
        config: { peers: [leader], followers: gateway },
        error: /a follower \(peers has a leader entry\) cannot configure followers gateway/,
      },
      // Leader entry alongside follower entries
      {
        config: { rootActor, peers: [leader, { id: "follower-a", type: "follower" }] },
        error: /cannot contain both a leader entry and follower entries/,
      },
      // More than one leader
      { config: { peers: [leader, { ...leader }] }, error: /at most one leader entry/ },
      // True peers are not supported yet
      {
        config: { rootActor, peers: [{ id: "other", type: "peer" }] },
        error: /type peer is not supported yet/,
      },
      // Followers gateway without the required follower allowlist
      {
        config: { rootActor, github: { account: "x" }, followers: gateway },
        error: /followers gateway requires at least one peers entry with type: follower/,
      },
      // Leader entry configuring both token and tokenFile
      {
        config: { peers: [{ ...leader, tokenFile: "/path/to/token" }] },
        error: /cannot configure both token and tokenFile/,
      },
    ];
    for (const { config, error } of cases) {
      const home = makeTempHome();
      writeConfigFile(home, { providers: { codex: { cliCommand: "codex" } }, ...config });
      expect(() => loadConfig(home)).toThrow(error);
      process.env.RUSA_HOME = home;
      vi.mocked(process.exit).mockClear();
      await runStart();
      expect(process.exit).toHaveBeenCalledWith(1);
      expect(existsSync(join(home, "data", "mesh.db"))).toBe(false);
    }
  });

  it("executes actor through runStart follower composition with synthetic peer, recording local execution state and draining cleanly on shutdown", async () => {
    const home = makeTempHome();
    process.env.RUSA_HOME = home;

    const eventsReceived: SyntheticEvent[] = [];
    const pollCommands: FollowerCommand[] = [];
    let pollRequests = 0;
    let registeredHeaders: Record<string, string | string[] | undefined> | undefined;
    let registeredBody: Record<string, unknown> | undefined;
    let unregisteredCalled = false;
    let followerHandles:
      | {
          instance: FollowerInstance;
          instanceIdentity: InstanceIdentity;
          shutdown: () => Promise<void>;
        }
      | undefined;

    // The leader's prompt for each admitted run. From run 2 it has run 1's
    // terminal and carries its own portable section: run 1 is larger than the
    // budget, so the leader renders it tail-truncated at its own timestamp and
    // names it by run id in the inject record (#1024). Each build reaches the
    // follower as JSON through the real /poll reply, where an explicit empty
    // read window and a missing one must stay distinct.
    const leaderInstructions = [
      "# Synthetic leader worker instructions and tools",
      "Leader charter: manage distributed tasks.",
      "## Charter notes",
      "---",
      "Begin by listing work from the durable inbox.",
    ].join("\n");
    const run1Output = `Synthetic run 1 opening ${"x".repeat(PORTABLE_CONTEXT_MAX_BYTES)} Synthetic run 1 closing`;
    const runStarts = () =>
      eventsReceived.flatMap((e) =>
        e.actorId === "actor-synthetic-1" && e.message?.type === "runStart" ? [e.message] : []
      );
    const leaderBuilds: PromptBuild[] = [];
    const nextLeaderBuild = (): PromptBuild => {
      const run1Id = runStarts()[0]?.runId;
      const index = leaderBuilds.length;
      // Build 1 reads nothing; builds 2-4 have read only run 1, and build 4 is
      // an older leader without a read window; build 5 has lost its history.
      const leaderRead =
        index >= 1 && index <= 3 && typeof run1Id === "string"
          ? [{ id: run1Id, ts: "2026-10-18T09:00:00.000Z", body: run1Output }]
          : [];
      const leaderSection = assemblePortableContext(leaderRead);
      const build: PromptBuild = leaderSection
        ? {
            prompt: `${leaderInstructions}\n\n---\n${leaderSection.section}`,
            injectRecord: leaderSection.record,
          }
        : { prompt: leaderInstructions };
      if (index !== 3) build.readRunIds = portableReadWindow(leaderRead);
      leaderBuilds.push(build);
      return build;
    };

    const leaderServer = createServer((req, res) => {
      const url = new URL(req.url ?? "/", `http://${req.headers.host}`);
      let raw = "";
      req.on("data", (chunk) => {
        raw += chunk;
      });
      req.on("end", () => {
        const body = raw ? (JSON.parse(raw) as Record<string, unknown>) : {};

        if (url.pathname === "/register" && req.method === "POST") {
          registeredHeaders = req.headers;
          registeredBody = body;
          pollCommands.push({ type: "update", updateId: "start-follower-no-update-source" });
          pollCommands.push({
            actorId: "actor-synthetic-1",
            message: {
              type: "init",
              bootstrap: {
                id: "actor-synthetic-1",
                cwd: home,
                sessionId: "leader-native-session",
                modelConfig: [{ provider: "codex", model: "gpt-5.6-sol" }],
                // The leader still owns the admitted provider/model tuple, but
                // a follower must not execute it through the leader's local
                // CLI configuration.
                providerOptions: {
                  providers: { codex: { cliCommand: "leader-codex" } },
                },
              },
            },
          });
          res.writeHead(200, { "content-type": "application/json" });
          res.end(
            JSON.stringify({
              session: "synth-sess-42",
              protocolVersion: INSTANCE_PROTOCOL_VERSION,
              leaderToken: "synth-leader-tok-99",
            })
          );
          return;
        }

        if (url.pathname === "/poll" && req.method === "POST") {
          pollRequests++;
          const commands = pollCommands.splice(0);
          res.writeHead(200, { "content-type": "application/json" });
          res.end(JSON.stringify(commands));
          return;
        }

        if (url.pathname === "/events" && req.method === "POST") {
          const batch = body as { id: string; session: string; events?: SyntheticEvent[] };
          if (Array.isArray(batch.events)) {
            for (const ev of batch.events) {
              eventsReceived.push(ev);
              if (
                ev.message?.type === "request" &&
                ev.message.requestId !== undefined &&
                ev.actorId === "actor-synthetic-1"
              ) {
                const reqId = ev.message.requestId;
                const op = ev.message.request?.op;
                if (op === "beforeRun") {
                  pollCommands.push({
                    actorId: ev.actorId,
                    message: {
                      type: "reply",
                      requestId: reqId,
                      value: { allowed: true, sessionId: "leader-native-session" },
                    },
                  });
                } else if (op === "prepareMount") {
                  pollCommands.push({
                    actorId: ev.actorId,
                    message: {
                      type: "reply",
                      requestId: reqId,
                      value: undefined,
                    },
                  });
                } else if (op === "admit") {
                  pollCommands.push({
                    actorId: ev.actorId,
                    message: {
                      type: "reply",
                      requestId: reqId,
                      value: {
                        record: {
                          id: ev.actorId,
                          charter: "Synthetic follower test charter",
                          status: "active",
                          createdAt: new Date().toISOString(),
                          context: { type: "portable", mode: "tail" },
                        },
                        prompt: "",
                        promptBuild: nextLeaderBuild(),
                        selected: { provider: "codex", model: "gpt-5.6-sol" },
                      },
                    },
                  });
                } else {
                  pollCommands.push({
                    actorId: ev.actorId,
                    message: {
                      type: "reply",
                      requestId: reqId,
                    },
                  });
                }
              }
            }
          }
          res.writeHead(200, { "content-type": "application/json" });
          res.end(JSON.stringify({ ok: true }));
          return;
        }

        if (url.pathname === "/unregister" && req.method === "POST") {
          unregisteredCalled = true;
          res.writeHead(200, { "content-type": "application/json" });
          res.end(JSON.stringify({ ok: true }));
          return;
        }

        res.writeHead(404);
        res.end();
      });
    });

    await new Promise<void>((resolve) => leaderServer.listen(0, "127.0.0.1", resolve));
    const port = (leaderServer.address() as AddressInfo).port;
    const leaderUrl = `http://127.0.0.1:${port}`;

    writeConfigFile(home, {
      providers: { codex: { cliCommand: "follower-codex" } },
      peers: [{ type: "leader", url: leaderUrl, token: "token-synthetic-xyz" }],
      instance: {
        id: "follower-node-synthetic",
      },
    });

    const observedPrompts: string[] = [];
    const observedSessionIds: Array<string | undefined> = [];
    const observedProviderOptions: Array<Record<string, unknown>> = [];
    let runCount = 0;
    const mockProviderFactory: ProviderFactory = vi.fn((_bridge, options, selected) => {
      observedProviderOptions.push(options);
      return {
        name: "mock-follower-provider",
        providerName: "mock-follower-provider",
        model: selected?.model,
        async run(run: RunOptions) {
          observedPrompts.push(run.prompt);
          observedSessionIds.push(run.session?.id);
          runCount++;
          run.onPromptLaunched?.(run.prompt);
          return {
            success: true,
            output: runCount === 1 ? run1Output : `Synthetic run ${runCount} output`,
            exitCode: 0,
            sessionId: `sess-mock-run-${runCount}`,
            model: selected?.model,
          };
        },
      };
    });

    await runStart({
      e2e: {
        connectPeer: true,
        followerPolling: true,
        followerProviderFactory: mockProviderFactory,
        onFollowerReady: (handles) => {
          followerHandles = handles;
        },
      },
    });

    expect(followerHandles).toBeDefined();
    if (!followerHandles) {
      throw new Error("followerHandles not initialized");
    }
    const handles = followerHandles;

    expect(registeredHeaders?.authorization).toBe("Bearer token-synthetic-xyz");
    expect(registeredBody?.id).toBe("follower-node-synthetic");
    expect(registeredBody).not.toHaveProperty("instanceId");
    expect(registeredBody).not.toHaveProperty("bootId");
    expect(handles.instanceIdentity.instanceId).toBe("follower-node-synthetic");
    expect(handles.instanceIdentity.role).toBe("follower");
    expect(handles.instance.isReconciled).toBe(true);

    // The synthetic leader delivers every actor command and reply through the
    // real follower /poll loop; this is intentionally distinct from the
    // focused direct-runtime fixtures elsewhere in this file.
    await waitUntil(() =>
      eventsReceived.some((e) => e.actorId === "actor-synthetic-1" && e.message?.type === "ready")
    );
    await waitUntil(() =>
      eventsReceived.some((e) => e.actorId === "$instance" && e.message?.type === "update_status")
    );
    pollCommands.push({
      actorId: "actor-synthetic-1",
      message: { type: "wake" },
    });

    await waitUntil(() =>
      eventsReceived.some(
        (e) =>
          e.actorId === "actor-synthetic-1" &&
          e.message?.type === "request" &&
          e.message?.request?.op === "complete"
      )
    );

    expect(observedPrompts).toHaveLength(1);
    expect(observedProviderOptions[0]).toMatchObject({
      providers: { codex: { cliCommand: "follower-codex" } },
    });
    // No prior run anywhere: the leader prompt is used byte for byte.
    expect(observedPrompts[0]).toBe(leaderBuilds[0].prompt);
    expect(runStarts()[0]?.injectRecord).toBeUndefined();
    // Admission snapshots the portable record, so the native session returned
    // by the earlier beforeRun gate cannot leak into this provider attempt.
    expect(observedSessionIds[0]).toBeUndefined();

    const wakeAndComplete = async (runs: number) => {
      pollCommands.push({ actorId: "actor-synthetic-1", message: { type: "wake" } });
      await waitUntil(() => observedPrompts.length === runs);
      await waitUntil(
        () =>
          eventsReceived.filter(
            (e) =>
              e.actorId === "actor-synthetic-1" &&
              e.message?.type === "request" &&
              e.message?.request?.op === "complete"
          ).length === runs
      );
    };
    const count = (haystack: string, needle: string) => haystack.split(needle).length - 1;

    // Run 2: the leader renders run 1 truncated, so its text differs from the
    // follower's row. The follower recognizes it by run id, not by heading or
    // body text, and adds nothing: the leader build is used byte for byte.
    await wakeAndComplete(2);
    const [run1Id, run2Id] = runStarts().map((event) => event.runId);
    expect(leaderBuilds[1].injectRecord?.sourceEventIds).toEqual([run1Id]);
    expect(leaderBuilds[1].prompt).not.toContain("Synthetic run 1 opening");
    expect(observedPrompts[1]).toBe(leaderBuilds[1].prompt);
    expect(count(observedPrompts[1], "Synthetic run 1 closing")).toBe(1);
    expect(runStarts()[1]?.injectRecord).toEqual(leaderBuilds[1].injectRecord);

    // Run 3: run 2's terminal has not reached this leader's prompt, so it is
    // genuinely local. The follower reads it back from its own mesh.db and
    // appends it once after the unchanged leader prompt.
    await wakeAndComplete(3);
    expect(leaderBuilds[2].injectRecord?.sourceEventIds).toEqual([run1Id]);
    expect(observedPrompts[2].startsWith(leaderBuilds[2].prompt)).toBe(true);
    expect(count(observedPrompts[2], "Synthetic run 1 closing")).toBe(1);
    expect(count(observedPrompts[2], "Synthetic run 2 output")).toBe(1);
    expect(runStarts()[2]?.injectRecord?.sourceEventIds).toEqual([run2Id]);
    expect(
      Buffer.byteLength(observedPrompts[2], "utf8") - Buffer.byteLength(leaderBuilds[2].prompt)
    ).toBeLessThanOrEqual(PORTABLE_CONTEXT_MAX_BYTES + "\n\n---\n".length);

    // Run 4: an older leader sends no read window. Its rendered ids cannot
    // separate runs it dropped from local ones, so the follower adds nothing
    // and the leader prompt and record are used byte for byte.
    await wakeAndComplete(4);
    expect(leaderBuilds[3]).not.toHaveProperty("readRunIds");
    expect(leaderBuilds[3].injectRecord?.sourceEventIds).toEqual([run1Id]);
    expect(observedPrompts[3]).toBe(leaderBuilds[3].prompt);
    expect(count(observedPrompts[3], "Synthetic run 2 output")).toBe(0);
    expect(count(observedPrompts[3], "Synthetic run 3 output")).toBe(0);
    expect(runStarts()[3]?.injectRecord).toEqual(leaderBuilds[3].injectRecord);

    // Run 5: an explicit empty window means the leader read no runs, so every
    // host run is local and appended once, newest first within the budget.
    await wakeAndComplete(5);
    const run4Id = runStarts()[3]?.runId;
    expect(leaderBuilds[4]).toEqual({ prompt: leaderInstructions, readRunIds: [] });
    expect(observedPrompts[4].startsWith(`${leaderInstructions}\n\n---\n`)).toBe(true);
    for (const output of [
      "Synthetic run 2 output",
      "Synthetic run 3 output",
      "Synthetic run 4 output",
    ])
      expect(count(observedPrompts[4], output)).toBe(1);
    // Run 1 alone fills a budget, so it is the oldest run the cap drops.
    expect(count(observedPrompts[4], "Synthetic run 1 closing")).toBe(0);
    expect(runStarts()[4]?.injectRecord?.sourceEventIds).toEqual([
      run2Id,
      runStarts()[2]?.runId,
      run4Id,
    ]);
    expect(observedSessionIds).toEqual(Array(5).fill(undefined));
    expect(pollRequests).toBeGreaterThan(3);

    await handles.shutdown();
    expect(unregisteredCalled).toBe(true);

    await new Promise<void>((resolve, reject) =>
      leaderServer.close((err) => (err ? reject(err) : resolve()))
    );

    const dbPath = join(home, "data", "mesh.db");
    expect(existsSync(dbPath)).toBe(true);
    const db = new Database(dbPath);

    const runs = db
      .prepare("SELECT * FROM actor_runs WHERE actor_id = ? ORDER BY started_at ASC")
      .all("actor-synthetic-1") as ActorRunRow[];
    expect(runs.map((run) => [run.id, run.outcome, run.success, run.output])).toEqual([
      [run1Id, "completed", 1, run1Output],
      [run2Id, "completed", 1, "Synthetic run 2 output"],
      [runStarts()[2]?.runId, "completed", 1, "Synthetic run 3 output"],
      [runStarts()[3]?.runId, "completed", 1, "Synthetic run 4 output"],
      [runStarts()[4]?.runId, "completed", 1, "Synthetic run 5 output"],
    ]);

    const prompts = db
      .prepare("SELECT * FROM run_prompts ORDER BY created_at ASC")
      .all() as RunPromptRow[];
    expect(prompts.map((row) => row.prompt)).toEqual(observedPrompts);

    // Host context is derived from actor_runs; no local portable snapshot is written.
    expect(
      db
        .prepare("SELECT 1 FROM portable_context_snapshots WHERE actor_id = ?")
        .get("actor-synthetic-1")
    ).toBeUndefined();

    db.close();
  }, 20_000);

  it("fences queued events when a re-registration reports a new leader token", async () => {
    const home = makeTempHome();
    process.env.RUSA_HOME = home;

    let registrations = 0;
    let initSent = false;
    const eventSessions: string[] = [];
    let followerShutdown: (() => Promise<void>) | undefined;

    const leaderServer = createServer((req, res) => {
      const url = new URL(req.url ?? "/", `http://${req.headers.host}`);
      let raw = "";
      req.on("data", (chunk) => {
        raw += chunk;
      });
      req.on("end", () => {
        const body = raw ? (JSON.parse(raw) as Record<string, unknown>) : {};
        if (url.pathname === "/register" && req.method === "POST") {
          registrations++;
          res.writeHead(200, { "content-type": "application/json" });
          res.end(
            JSON.stringify({
              session: `fence-session-${registrations}`,
              protocolVersion: INSTANCE_PROTOCOL_VERSION,
              leaderToken: `fence-leader-${registrations}`,
            })
          );
          return;
        }
        if (url.pathname === "/poll" && req.method === "POST") {
          const commands: FollowerCommand[] = [];
          if (!initSent && body.session === "fence-session-1") {
            initSent = true;
            commands.push({
              actorId: "actor-fence-1",
              message: {
                type: "init",
                bootstrap: {
                  id: "actor-fence-1",
                  cwd: home,
                  modelConfig: [{ provider: "codex", model: "gpt-5.6-sol" }],
                },
              },
            });
          }
          res.writeHead(200, { "content-type": "application/json" });
          res.end(JSON.stringify(commands));
          return;
        }
        if (url.pathname === "/events" && req.method === "POST") {
          eventSessions.push(String(body.session));
          // Reject the ready event in the first epoch. It remains queued until
          // the follower observes the next leader token and fences it.
          if (body.session === "fence-session-1") {
            res.writeHead(410, { "content-type": "application/json" });
            res.end(JSON.stringify({ error: "leader restarted" }));
            return;
          }
          res.writeHead(200, { "content-type": "application/json" });
          res.end(JSON.stringify({ ok: true }));
          return;
        }
        if (url.pathname === "/unregister" && req.method === "POST") {
          res.writeHead(200, { "content-type": "application/json" });
          res.end(JSON.stringify({ ok: true }));
          return;
        }
        res.writeHead(404);
        res.end();
      });
    });

    await new Promise<void>((resolve) => leaderServer.listen(0, "127.0.0.1", resolve));
    const port = (leaderServer.address() as AddressInfo).port;
    writeConfigFile(home, {
      providers: { codex: { cliCommand: "codex" } },
      peers: [{ type: "leader", url: `http://127.0.0.1:${port}`, token: "token-synthetic-fence" }],
      instance: { id: "follower-node-fence" },
    });

    const providerFactory: ProviderFactory = vi.fn((_bridge, _options, selected) => ({
      name: "mock-fence-provider",
      providerName: "mock-fence-provider",
      model: selected?.model,
      async run() {
        throw new Error("the fencing fixture never wakes its actor");
      },
    }));

    await runStart({
      e2e: {
        connectPeer: true,
        followerPolling: true,
        followerProviderFactory: providerFactory,
        onFollowerReady: (handles) => {
          followerShutdown = handles.shutdown;
        },
      },
    });

    await waitUntil(() => registrations >= 2 && eventSessions.includes("fence-session-1"));
    await new Promise((resolve) => setTimeout(resolve, 30));

    // The old queued ready event may reach its own epoch once, but cannot be
    // replayed through the second leader registration.
    expect(eventSessions).toEqual(["fence-session-1"]);

    await followerShutdown?.();
    await new Promise<void>((resolve, reject) =>
      leaderServer.close((error) => (error ? reject(error) : resolve()))
    );
  }, 20_000);

  it("drains active actor run and records truthful terminal outcome on shutdown before database closes", async () => {
    const home = makeTempHome();
    process.env.RUSA_HOME = home;

    const eventsReceived: SyntheticEvent[] = [];
    let followerHandles:
      | {
          instance: FollowerInstance;
          instanceIdentity: InstanceIdentity;
          shutdown: () => Promise<void>;
        }
      | undefined;
    let startedRuns = 0;
    let resolveBothRunsStarted: (() => void) | undefined;
    const bothRunsStarted = new Promise<void>((resolve) => {
      resolveBothRunsStarted = resolve;
    });

    const leaderServer = createServer((req, res) => {
      const url = new URL(req.url ?? "/", `http://${req.headers.host}`);
      let raw = "";
      req.on("data", (chunk) => {
        raw += chunk;
      });
      req.on("end", () => {
        const body = raw ? (JSON.parse(raw) as Record<string, unknown>) : {};

        if (url.pathname === "/register" && req.method === "POST") {
          res.writeHead(200, { "content-type": "application/json" });
          res.end(
            JSON.stringify({
              session: "synth-sess-drain",
              protocolVersion: INSTANCE_PROTOCOL_VERSION,
              leaderToken: "synth-leader-tok-drain",
            })
          );
          return;
        }

        if (url.pathname === "/events" && req.method === "POST") {
          const batch = body as { id: string; session: string; events?: SyntheticEvent[] };
          if (Array.isArray(batch.events)) {
            for (const ev of batch.events) {
              eventsReceived.push(ev);
              if (ev.message?.type === "request" && ev.message.requestId !== undefined) {
                const reqId = ev.message.requestId;
                const op = ev.message.request?.op;
                if (op === "beforeRun") {
                  queueMicrotask(() => {
                    followerHandles?.instance.dispatch({
                      actorId: ev.actorId,
                      message: {
                        type: "reply",
                        requestId: reqId,
                        value: { allowed: true },
                      },
                    });
                  });
                } else if (op === "prepareMount") {
                  queueMicrotask(() => {
                    followerHandles?.instance.dispatch({
                      actorId: ev.actorId,
                      message: {
                        type: "reply",
                        requestId: reqId,
                        value: undefined,
                      },
                    });
                  });
                } else if (op === "admit") {
                  queueMicrotask(() => {
                    followerHandles?.instance.dispatch({
                      actorId: ev.actorId,
                      message: {
                        type: "reply",
                        requestId: reqId,
                        value: {
                          record: {
                            id: ev.actorId,
                            charter: "Drain test charter",
                            status: "active",
                            createdAt: new Date().toISOString(),
                          },
                          prompt: "Drain test prompt",
                          selected: { provider: "codex", model: "gpt-5.6-sol" },
                        },
                      },
                    });
                  });
                } else {
                  queueMicrotask(() => {
                    followerHandles?.instance.dispatch({
                      actorId: ev.actorId,
                      message: {
                        type: "reply",
                        requestId: reqId,
                      },
                    });
                  });
                }
              }
            }
          }
          res.writeHead(200, { "content-type": "application/json" });
          res.end(JSON.stringify({ ok: true }));
          return;
        }

        if (url.pathname === "/unregister" && req.method === "POST") {
          res.writeHead(200, { "content-type": "application/json" });
          res.end(JSON.stringify({ ok: true }));
          return;
        }

        res.writeHead(404);
        res.end();
      });
    });

    await new Promise<void>((resolve) => leaderServer.listen(0, "127.0.0.1", resolve));
    const port = (leaderServer.address() as AddressInfo).port;
    const leaderUrl = `http://127.0.0.1:${port}`;

    writeConfigFile(home, {
      providers: { codex: { cliCommand: "codex" } },
      peers: [{ type: "leader", url: leaderUrl, token: "token-synthetic-drain" }],
      instance: {
        id: "follower-node-drain",
      },
    });

    const mockDrainProviderFactory: ProviderFactory = vi.fn((_bridge, _opts, selected) => ({
      name: "mock-drain-provider",
      providerName: "mock-drain-provider",
      model: selected?.model,
      async run(run: RunOptions) {
        run.onPromptLaunched?.(run.prompt);
        startedRuns++;
        if (startedRuns === 2) resolveBothRunsStarted?.();
        if (run.cwd.endsWith("actor-drain-2")) {
          // This provider ignores interruption, exercising the bounded shutdown
          // path that must make its open local row truthful before DB close.
          await new Promise<void>(() => {});
        }
        // Wait until aborted by shutdown
        await new Promise<void>((resolve) => {
          const sig = run.signal;
          if (!sig || sig.aborted) {
            resolve();
          } else {
            sig.addEventListener("abort", () => resolve(), { once: true });
          }
        });
        return {
          success: false,
          output: "Aborted during shutdown drain",
          exitCode: 1,
          sessionId: "sess-drain-interrupted",
          model: selected?.model,
        };
      },
    }));

    await runStart({
      e2e: {
        connectPeer: true,
        followerProviderFactory: mockDrainProviderFactory,
        onFollowerReady: (handles) => {
          followerHandles = handles;
        },
      },
    });

    if (!followerHandles) {
      throw new Error("followerHandles not initialized");
    }
    const handles = followerHandles;

    handles.instance.dispatch({
      actorId: "actor-drain-1",
      message: {
        type: "init",
        bootstrap: {
          id: "actor-drain-1",
          cwd: home,
          modelConfig: [{ provider: "codex", model: "gpt-5.6-sol" }],
        },
      },
    });
    handles.instance.dispatch({
      actorId: "actor-drain-2",
      message: {
        type: "init",
        bootstrap: {
          id: "actor-drain-2",
          cwd: home,
          modelConfig: [{ provider: "codex", model: "gpt-5.6-sol" }],
        },
      },
    });

    await waitUntil(() =>
      ["actor-drain-1", "actor-drain-2"].every((actorId) =>
        eventsReceived.some((e) => e.actorId === actorId && e.message?.type === "ready")
      )
    );

    for (const actorId of ["actor-drain-1", "actor-drain-2"]) {
      handles.instance.dispatch({ actorId, message: { type: "wake" } });
    }

    // Wait until both provider executions are in flight: one respects the
    // shutdown abort, and one forces the bounded timeout branch.
    await bothRunsStarted;

    // Shutdown during active execution: must drain actor and flush terminal record before DB close
    await handles.shutdown();

    await new Promise<void>((resolve, reject) =>
      leaderServer.close((err) => (err ? reject(err) : resolve()))
    );

    // Verify local DB retained the terminal record cleanly without DB-closed corruption
    const dbPath = join(home, "data", "mesh.db");
    expect(existsSync(dbPath)).toBe(true);
    const db = new Database(dbPath);

    const runRow = db.prepare("SELECT * FROM actor_runs WHERE actor_id = ?").get("actor-drain-1") as
      | ActorRunRow
      | undefined;
    expect(runRow).toBeDefined();
    // The Actor translates the fixture's interruption into its stable signal
    // result; shutdown must retain that specific failed terminal outcome.
    expect(runRow).toMatchObject({
      outcome: "completed",
      success: 0,
      exit_code: 143,
    });
    expect(runRow?.output).toContain("Aborted during shutdown drain");
    expect(runRow?.output).toContain("Task interrupted by instance-actor-retirement");

    const timedOutRow = db
      .prepare("SELECT * FROM actor_runs WHERE actor_id = ?")
      .get("actor-drain-2") as ActorRunRow | undefined;
    expect(timedOutRow).toMatchObject({
      outcome: "abandoned",
      abandon_reason: "follower shutdown drain timed out",
    });

    const promptRow = db.prepare("SELECT * FROM run_prompts WHERE run_id = ?").get(runRow?.id) as
      | RunPromptRow
      | undefined;
    expect(promptRow).toBeDefined();
    expect(promptRow?.prompt).toBe("Drain test prompt");

    db.close();
  }, 20_000);

  it("reconciles a terminal accounting write failure after a quiescent shutdown", async () => {
    const home = makeTempHome();
    process.env.RUSA_HOME = home;

    let followerHandles:
      | {
          instance: FollowerInstance;
          shutdown: () => Promise<void>;
        }
      | undefined;
    let actorReady = false;
    let resolveProviderStarted: (() => void) | undefined;
    const providerStarted = new Promise<void>((resolve) => {
      resolveProviderStarted = resolve;
    });

    const leaderServer = createServer((req, res) => {
      const url = new URL(req.url ?? "/", `http://${req.headers.host}`);
      let raw = "";
      req.on("data", (chunk) => {
        raw += chunk;
      });
      req.on("end", () => {
        const body = raw ? (JSON.parse(raw) as Record<string, unknown>) : {};
        if (url.pathname === "/register" && req.method === "POST") {
          res.writeHead(200, { "content-type": "application/json" });
          res.end(
            JSON.stringify({
              session: "synth-sess-accounting-fault",
              protocolVersion: INSTANCE_PROTOCOL_VERSION,
              leaderToken: "synth-leader-accounting-fault",
            })
          );
          return;
        }
        if (url.pathname === "/events" && req.method === "POST") {
          const batch = body as { events?: SyntheticEvent[] };
          for (const event of batch.events ?? []) {
            if (event.message?.type === "ready") actorReady = true;
            if (event.message?.type !== "request" || event.message.requestId === undefined)
              continue;
            const requestId = event.message.requestId;
            const op = event.message.request?.op;
            const value =
              op === "beforeRun"
                ? { allowed: true }
                : op === "admit"
                  ? {
                      record: {
                        id: event.actorId,
                        charter: "Accounting fault charter",
                        status: "active",
                        createdAt: new Date().toISOString(),
                      },
                      prompt: "Accounting fault prompt",
                      selected: { provider: "codex", model: "gpt-5.6-sol" },
                    }
                  : undefined;
            queueMicrotask(() => {
              followerHandles?.instance.dispatch({
                actorId: event.actorId,
                message: { type: "reply", requestId, value },
              });
            });
          }
          res.writeHead(200, { "content-type": "application/json" });
          res.end(JSON.stringify({ ok: true }));
          return;
        }
        if (url.pathname === "/unregister" && req.method === "POST") {
          res.writeHead(200, { "content-type": "application/json" });
          res.end(JSON.stringify({ ok: true }));
          return;
        }
        res.writeHead(404);
        res.end();
      });
    });
    await new Promise<void>((resolve) => leaderServer.listen(0, "127.0.0.1", resolve));
    const port = (leaderServer.address() as AddressInfo).port;
    writeConfigFile(home, {
      providers: { codex: { cliCommand: "codex" } },
      peers: [{ type: "leader", url: `http://127.0.0.1:${port}`, token: "token-accounting-fault" }],
      instance: { id: "follower-node-accounting-fault" },
    });

    const providerFactory: ProviderFactory = vi.fn((_bridge, _options, selected) => ({
      name: "mock-accounting-fault-provider",
      providerName: "mock-accounting-fault-provider",
      model: selected?.model,
      async run(run: RunOptions) {
        run.onPromptLaunched?.(run.prompt);
        resolveProviderStarted?.();
        await new Promise<void>((resolve) => {
          const signal = run.signal;
          if (!signal || signal.aborted) resolve();
          else signal.addEventListener("abort", () => resolve(), { once: true });
        });
        return {
          success: false,
          output: "Aborted during accounting-fault shutdown",
          exitCode: 1,
          sessionId: "sess-accounting-fault",
          model: selected?.model,
        };
      },
    }));

    await runStart({
      e2e: {
        connectPeer: true,
        followerProviderFactory: providerFactory,
        onFollowerReady: (handles) => {
          followerHandles = handles;
        },
      },
    });
    if (!followerHandles) throw new Error("followerHandles not initialized");
    const handles = followerHandles;
    const complete = vi.spyOn(ActorRunRepository.prototype, "complete").mockImplementation(() => {
      throw new Error("synthetic terminal accounting write failure");
    });

    handles.instance.dispatch({
      actorId: "actor-accounting-fault",
      message: {
        type: "init",
        bootstrap: {
          id: "actor-accounting-fault",
          cwd: home,
          modelConfig: [{ provider: "codex", model: "gpt-5.6-sol" }],
        },
      },
    });
    await waitUntil(() => actorReady);
    handles.instance.dispatch({ actorId: "actor-accounting-fault", message: { type: "wake" } });
    await providerStarted;

    await handles.shutdown();
    await new Promise<void>((resolve, reject) =>
      leaderServer.close((error) => (error ? reject(error) : resolve()))
    );
    expect(complete).toHaveBeenCalledTimes(1);

    const db = new Database(join(home, "data", "mesh.db"));
    const runRow = db
      .prepare("SELECT * FROM actor_runs WHERE actor_id = ?")
      .get("actor-accounting-fault") as ActorRunRow | undefined;
    expect(runRow).toMatchObject({
      outcome: "abandoned",
      abandon_reason: "follower shutdown accounting reconciliation",
    });
    db.close();
  });
  it("sends an event over the HTTP envelope through the leader's advertised transfer, ahead of later events", async () => {
    const home = makeTempHome();
    process.env.RUSA_HOME = home;
    // An update command is the smallest leader input that makes this entry
    // point emit an event; a 9 MiB id makes its update_status event larger
    // than one /events request may carry.
    const oversizedId = "u".repeat(9 * 1024 * 1024);
    const delivered: { route: string; updateId: unknown }[] = [];
    const fragments = new Map<string, Buffer[]>();
    let polled = false;
    const leader = await startSyntheticLeader((path, body, res) => {
      if (path === "/register") {
        return replyJson(res, {
          session: "transfer-session",
          protocolVersion: INSTANCE_PROTOCOL_VERSION,
          eventTransfer: EVENT_TRANSFER_CAPABILITY,
        });
      }
      if (path === "/poll") {
        const commands: FollowerCommand[] = polled
          ? []
          : [
              { type: "update", updateId: oversizedId },
              { type: "update", updateId: "after-oversized" },
            ];
        polled = true;
        return replyJson(res, commands);
      }
      if (path === "/events") {
        for (const event of body.events as SyntheticEvent[]) {
          delivered.push({ route: "events", updateId: event.message?.updateId });
        }
        return replyJson(res, {});
      }
      if (path === "/events/transfer") {
        const fragment = body as unknown as EventTransferFragment;
        const parts = fragments.get(fragment.transferId) ?? [];
        parts.push(Buffer.from(fragment.data, "base64"));
        fragments.set(fragment.transferId, parts);
        const bytes = Buffer.concat(parts);
        if (bytes.length < fragment.totalBytes) {
          return replyJson(res, { status: "fragment", receivedBytes: bytes.length });
        }
        const event = JSON.parse(bytes.toString("utf8")) as SyntheticEvent;
        // Verify the 9 MiB payload in this test-local sink without passing the
        // raw 9 MiB string into delivered assertions or runner diffs.
        const rawId = event.message?.updateId;
        const matchesOversized = rawId === oversizedId;
        delivered.push({
          route: "transfer",
          updateId: matchesOversized
            ? "oversized-matched"
            : `mismatch(len=${typeof rawId === "string" ? rawId.length : "non-string"})`,
        });
        return replyJson(res, { status: "complete" });
      }
      replyJson(res, {});
    });
    writeConfigFile(home, {
      providers: { codex: { cliCommand: "codex" } },
      peers: [{ type: "leader", url: leader.url, token: "token-synthetic-transfer" }],
      instance: { id: "follower-node-transfer" },
      observability: { logging: { level: "error" } },
    });

    const prevLogLevel = process.env.RUSA_LOG_LEVEL;
    process.env.RUSA_LOG_LEVEL = "error";
    let shutdown: (() => Promise<void>) | undefined;
    try {
      await runStart({
        e2e: {
          connectPeer: true,
          followerPolling: true,
          onFollowerReady: (handles) => {
            shutdown = handles.shutdown;
          },
        },
      });

      // 20s bounded wait deadline provides a 10s explicit margin under the 30s outer timeout.
      await waitUntil(() => delivered.length >= 2, 20_000);
      expect(delivered).toEqual([
        { route: "transfer", updateId: "oversized-matched" },
        { route: "events", updateId: "after-oversized" },
      ]);
    } finally {
      if (prevLogLevel !== undefined) {
        process.env.RUSA_LOG_LEVEL = prevLogLevel;
      } else {
        delete process.env.RUSA_LOG_LEVEL;
      }
      try {
        await shutdown?.();
      } finally {
        await leader.close().catch(() => {});
      }
    }
  }, 30_000);

  it("dispatches nothing from a poll answered after shutdown begins", async () => {
    const home = makeTempHome();
    process.env.RUSA_HOME = home;
    let heldPoll: ServerResponse | undefined;
    let unregistered = false;
    const leader = await startSyntheticLeader((path, _body, res) => {
      if (path === "/register") {
        return replyJson(res, {
          session: "late-poll-session",
          protocolVersion: INSTANCE_PROTOCOL_VERSION,
        });
      }
      if (path === "/poll") {
        heldPoll = res;
        return;
      }
      if (path === "/unregister") {
        // Answer the poll held since before shutdown, while it awaits this.
        const init: FollowerCommand = {
          actorId: "actor-late-poll",
          message: {
            type: "init",
            bootstrap: {
              id: "actor-late-poll",
              cwd: home,
              modelConfig: [{ provider: "codex", model: "gpt-5.6-sol" }],
            },
          },
        };
        if (heldPoll?.writable) replyJson(heldPoll, [init]);
        setTimeout(() => {
          unregistered = true;
          replyJson(res, {});
        }, 50);
        return;
      }
      replyJson(res, {});
    });
    writeConfigFile(home, {
      providers: { codex: { cliCommand: "codex" } },
      peers: [{ type: "leader", url: leader.url, token: "token-synthetic-late-poll" }],
      instance: { id: "follower-node-late-poll" },
    });

    let handles: { instance: FollowerInstance; shutdown: () => Promise<void> } | undefined;
    try {
      await runStart({
        e2e: {
          connectPeer: true,
          followerPolling: true,
          onFollowerReady: (ready) => {
            handles = ready;
          },
        },
      });
      await waitUntil(() => heldPoll !== undefined, 10_000);
      const dispatch = vi.spyOn(handles?.instance as FollowerInstance, "dispatch");

      await handles?.shutdown();
      await new Promise((resolve) => setTimeout(resolve, 30));
      expect(unregistered).toBe(true);
      expect(dispatch).not.toHaveBeenCalled();
    } finally {
      try {
        await handles?.shutdown();
      } finally {
        await leader.close().catch(() => {});
      }
    }
  }, 20_000);

  it("unregisters a registration that completes after shutdown begins", async () => {
    const home = makeTempHome();
    process.env.RUSA_HOME = home;
    let heldRegister: ServerResponse | undefined;
    const unregisteredSessions: unknown[] = [];
    const leader = await startSyntheticLeader((path, body, res) => {
      if (path === "/register") {
        heldRegister = res;
        return;
      }
      if (path === "/unregister") unregisteredSessions.push(body.session);
      replyJson(res, path === "/poll" ? [] : {});
    });
    writeConfigFile(home, {
      providers: { codex: { cliCommand: "codex" } },
      peers: [{ type: "leader", url: leader.url, token: "token-synthetic-late-register" }],
      instance: { id: "follower-node-late-register" },
    });

    let shutdown: (() => Promise<void>) | undefined;
    try {
      await runStart({
        e2e: {
          connectPeer: false,
          followerPolling: true,
          onFollowerReady: (ready) => {
            shutdown = ready.shutdown;
          },
        },
      });
      await waitUntil(() => heldRegister !== undefined, 10_000);

      const closing = shutdown?.();
      await new Promise((resolve) => setTimeout(resolve, 20));
      replyJson(heldRegister as ServerResponse, {
        session: "late-register-session",
        protocolVersion: INSTANCE_PROTOCOL_VERSION,
      });
      await closing;
      await new Promise((resolve) => setTimeout(resolve, 30));
      expect(unregisteredSessions).toEqual(["late-register-session"]);
    } finally {
      try {
        if (heldRegister && !heldRegister.writableEnded) {
          heldRegister.destroy();
        }
        await shutdown?.();
      } finally {
        await leader.close().catch(() => {});
      }
    }
  }, 20_000);

  it("keeps a crashed run unresolved across boot and shutdown and redelivers a pending receipt after a lost acknowledgment (#1020)", async () => {
    const home = makeTempHome();
    process.env.RUSA_HOME = home;
    // A previous follower process completed one receipt-backed run, without
    // delivering its receipt, and died with another open.
    initDb(home);
    const previous = new HostRunReceiptRepository(getDb(), "follower-node-receipts");
    const modelConfig = { version: 1 as const, provider: "codex", model: "gpt-5.6-sol" };
    previous.start({ id: "run-done", actorId: "actor-done", modelConfig });
    previous.complete(
      "run-done",
      "actor-done",
      { success: true, exitCode: 0, output: "done" },
      "observed"
    );
    previous.start({ id: "run-crashed", actorId: "actor-crashed", modelConfig });
    closeDb();

    const registerBodies: Record<string, unknown>[] = [];
    const posted: Array<{ session: unknown; receipts: Array<Record<string, unknown>> }> = [];
    let registrations = 0;
    let shutdown: (() => Promise<void>) | undefined;
    const leader = await startSyntheticLeader((path, body, res) => {
      if (path === "/register") {
        registrations++;
        registerBodies.push(body);
        // Each registration is a new leader incarnation; receipts survive it.
        replyJson(res, {
          session: `receipt-session-${registrations}`,
          protocolVersion: INSTANCE_PROTOCOL_VERSION,
          leaderToken: `receipt-leader-${registrations}`,
          runReceipts: { version: 1 },
        });
        return;
      }
      if (path === "/receipts") {
        const receipts = body.receipts as Array<Record<string, unknown>>;
        posted.push({ session: body.session, receipts });
        // The first answer is lost in transport after the leader recorded it.
        if (posted.length === 1) {
          replyJson(res, { error: "synthetic lost acknowledgment" }, 503);
          return;
        }
        replyJson(res, {
          results: receipts.map((r) => ({
            runId: r.runId,
            status: posted.length === 2 ? "duplicate" : "applied",
          })),
        });
        return;
      }
      if (path === "/poll") {
        setTimeout(() => replyJson(res, []), 20);
        return;
      }
      replyJson(res, {});
    });
    try {
      writeConfigFile(home, {
        providers: { codex: { cliCommand: "codex" } },
        peers: [{ type: "leader", url: leader.url, token: "token-synthetic-receipts" }],
        instance: { id: "follower-node-receipts" },
      });
      await runStart({
        e2e: {
          connectPeer: true,
          followerPolling: true,
          onFollowerReady: (ready) => {
            shutdown = ready.shutdown;
          },
        },
      });
      await waitUntil(() => posted.length >= 2, 10_000);

      expect(registerBodies[0]).toMatchObject({
        id: "follower-node-receipts",
        runReceipts: { version: 1 },
      });
      // The retry carries the same identity: run ID, digest and bytes.
      expect(posted[1].receipts).toEqual(posted[0].receipts);
      // Only the completed run's receipt travels; nothing saw the crashed
      // run's provider end, so boot wrote it no receipt.
      expect(posted[0].receipts).toHaveLength(1);
      const [envelope] = posted[0].receipts;
      expect(Object.keys(envelope).sort()).toEqual(["digest", "receipt", "runId"]);
      expect(envelope.runId).toBe("run-done");
      expect(JSON.parse(String(envelope.receipt))).toMatchObject({
        instanceId: "follower-node-receipts",
        runId: "run-done",
        outcome: "completed",
        exitCode: 0,
      });
    } finally {
      await shutdown?.();
      await leader.close().catch(() => {});
    }
    expect(posted.flatMap((p) => p.receipts.map((r) => r.runId))).not.toContain("run-crashed");

    // After boot and shutdown, the crashed run is still open and owes nothing yet.
    const db = new Database(join(home, "data", "mesh.db"), { readonly: true });
    try {
      expect(db.prepare("SELECT id, outcome FROM actor_runs ORDER BY id").all()).toEqual([
        { id: "run-crashed", outcome: null },
        { id: "run-done", outcome: "completed" },
      ]);
      // The acknowledged receipt is dropped; the closed row is the host's record.
      expect(db.prepare("SELECT run_id FROM host_run_receipts").all()).toEqual([]);
    } finally {
      db.close();
    }
  }, 20_000);
});
