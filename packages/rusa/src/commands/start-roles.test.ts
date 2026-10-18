import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { stringify as toYaml } from "yaml";
import { loadConfig } from "../config/index.js";
import { closeDb, getRepositories, initDb } from "../db/index.js";
import { getInstanceIdentity, type InstanceIdentity } from "../db/instance-identity.js";
import { RoleAuthorityError } from "../db/repositories/index.js";
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
  [key: string]: unknown;
}

interface SyntheticEvent {
  eventId: string;
  actorId: string;
  message?: SyntheticRequestMessage;
}

interface InstanceIdentityRow {
  instance_id: string;
  role: string;
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
  it("initializes mesh.db and writes stable instance identity on leader boot", async () => {
    const home = makeTempHome();
    process.env.RUSA_HOME = home;

    writeConfigFile(home, {
      providers: { codex: { cliCommand: "codex" } },
      rootActor: { provider: "codex", model: "gpt-5.6-sol" },
      github: { account: "test-account" },
      webhook: { port: 9742, secret: "secret" },
    });

    // First leader boot
    const ready1 = new Promise<void>((resolve) => {
      void runStart({
        e2e: {
          onReady: async (handles) => {
            await handles.shutdown();
            resolve();
          },
        },
      });
    });
    await ready1;

    const dbPath = join(home, "data", "mesh.db");
    expect(existsSync(dbPath)).toBe(true);

    const db1 = new Database(dbPath);
    const id1 = getInstanceIdentity(db1);
    expect(id1).not.toBeNull();
    expect(id1?.role).toBe("leader");
    expect(id1?.instanceId).toBeTruthy();
    expect(id1?.bootId).toBeTruthy();
    db1.close();

    // Restart leader over same database
    const ready2 = new Promise<void>((resolve) => {
      void runStart({
        e2e: {
          onReady: async (handles) => {
            await handles.shutdown();
            resolve();
          },
        },
      });
    });
    await ready2;

    const db2 = new Database(dbPath);
    const id2 = getInstanceIdentity(db2);
    expect(id2).not.toBeNull();
    expect(id2?.instanceId).toBe(id1?.instanceId);
    expect(id2?.role).toBe("leader");
    expect(id2?.bootId).not.toBe(id1?.bootId);
    db2.close();
  }, 20_000);

  it("initializes mesh.db and writes stable instance identity on follower boot without rootActor", async () => {
    const home = makeTempHome();
    process.env.RUSA_HOME = home;

    writeConfigFile(home, {
      providers: { codex: { cliCommand: "codex" } },
      peers: [{ type: "leader", url: "http://127.0.0.1:8190", token: "test-follower-token" }],
      instance: {
        id: "worker-node-alpha",
      },
    });

    let followerShutdown: (() => Promise<void>) | undefined;
    await runStart({
      e2e: {
        connectPeer: false,
        onFollowerReady: (handles) => {
          expect(handles.instanceIdentity.instanceId).toBe("worker-node-alpha");
          expect(handles.instanceIdentity.role).toBe("follower");
          followerShutdown = handles.shutdown;
        },
      },
    });
    if (followerShutdown) await followerShutdown();

    const dbPath = join(home, "data", "mesh.db");
    expect(existsSync(dbPath)).toBe(true);

    const db1 = new Database(dbPath);
    const id1 = getInstanceIdentity(db1);
    expect(id1?.instanceId).toBe("worker-node-alpha");
    expect(id1?.role).toBe("follower");
    const bootId1 = id1?.bootId;
    db1.close();

    // Second boot of follower
    await runStart({
      e2e: {
        connectPeer: false,
        onFollowerReady: (handles) => {
          expect(handles.instanceIdentity.instanceId).toBe("worker-node-alpha");
          expect(handles.instanceIdentity.role).toBe("follower");
          followerShutdown = handles.shutdown;
        },
      },
    });
    if (followerShutdown) await followerShutdown();

    const db2 = new Database(dbPath);
    const id2 = getInstanceIdentity(db2);
    expect(id2?.instanceId).toBe("worker-node-alpha");
    expect(id2?.role).toBe("follower");
    expect(id2?.bootId).not.toBe(bootId1);
    db2.close();
  }, 20_000);

  it("fails a follower boot without bwrap before mesh.db binds an identity or enrollment starts", async () => {
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

    // Global control writes are forbidden on follower
    expect(() => {
      repos.obligations.create({
        title: "Forbidden follower obligation",
        ownerId: "system:mesh",
      });
    }).toThrow(RoleAuthorityError);

    expect(() => {
      repos.obligations.setSnooze("ob-1", new Date().toISOString(), "system:mesh");
    }).toThrow(RoleAuthorityError);

    expect(() => {
      repos.actors.upsert({
        id: "actor-forbidden",
        charter: "charter",
        parentId: null,
        status: "active",
        createdAt: new Date().toISOString(),
      });
    }).toThrow(RoleAuthorityError);

    expect(() => {
      repos.principals.createUser({
        email: "forbidden@example.test",
        createdAt: new Date().toISOString(),
      });
    }).toThrow(RoleAuthorityError);

    expect(() => {
      repos.capabilityGrants.grant({
        actorId: "actor-1",
        capability: "test",
        grantedBy: "system",
        grantedAt: new Date().toISOString(),
      });
    }).toThrow(RoleAuthorityError);

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

    const promptRecord = repos.runPrompts.getById(run.id);
    expect(promptRecord).not.toBeNull();
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
    vi.spyOn(repos.actorRuns, "start").mockImplementation(() => {
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
                      value: { allowed: true },
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
                          context: { type: "native" },
                        },
                        prompt: [
                          "# Synthetic leader worker instructions and tools",
                          "Leader charter: manage distributed tasks.",
                          "",
                          "## Portable context (mesh-managed)",
                          "",
                          "You were started fresh for this run. The mesh preserved durable intent and a",
                          "bounded recent journal below. Active durable items remain in force until a newer",
                          "source explicitly supersedes or resolves them. Re-derive external state with tools.",
                          "",
                          "### Durable intent",
                          "- [MUST] [constraint] Leader policy: preserve mesh protocol",
                          '  Source leader-coordinator at 2026-10-12T10:00:00.000Z: "preserve mesh protocol"',
                        ].join("\n"),
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

    // Pre-seed host-local portable context memory in follower local database (#1019)
    initDb(home);
    const preRepos = getRepositories();
    preRepos.actors.upsert({
      id: "actor-synthetic-1",
      charter: "Synthetic follower test charter",
      parentId: null,
      status: "active",
      createdAt: new Date().toISOString(),
    });
    preRepos.portableContext.save({
      schemaVersion: 4,
      actorId: "actor-synthetic-1",
      generation: 1,
      updatedAt: "2026-10-12T12:00:00.000Z",
      lastFoldedSourceId: null,
      brief: null,
      compactor: null,
      items: [
        {
          id: "mem-host-1",
          kind: "constraint",
          priority: "must",
          status: "active",
          statement: "Host-local boundary: preserve private workdir mount",
          evidence: [
            {
              eventId: "ev-host-1",
              sender: "host-manager",
              ts: "2026-10-12T12:00:00.000Z",
              quote: "preserve private workdir mount",
            },
          ],
          updatedAt: "2026-10-12T12:00:00.000Z",
        },
      ],
    });
    closeDb();

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
            output: `Synthetic run ${runCount} output`,
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
    expect(registeredBody?.instanceId).toBe("follower-node-synthetic");
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
    // Leader instructions/tools remain leader-authoritative
    expect(observedPrompts[0]).toContain("Synthetic leader worker instructions and tools");
    expect(observedPrompts[0]).toContain("Leader charter: manage distributed tasks.");
    // Preexisting leader portable section remains intact
    expect(observedPrompts[0]).toContain("Leader policy: preserve mesh protocol");
    // Host-owned memory is additive and observed directly at the adapter alongside leader context
    expect(observedPrompts[0]).toContain("## Portable context (mesh-managed)");
    expect(observedPrompts[0]).toContain("### Durable intent");
    expect(observedPrompts[0]).toContain("Host-local boundary: preserve private workdir mount");
    // A host-local portable row augments the prompt but cannot override the
    // leader-selected native session policy.
    expect(observedSessionIds[0]).toBe("leader-native-session");

    // Run 2: Next run includes prior run output from local actor_runs alongside leader context
    pollCommands.push({
      actorId: "actor-synthetic-1",
      message: { type: "wake" },
    });

    await waitUntil(() => observedPrompts.length === 2);
    await waitUntil(
      () =>
        eventsReceived.filter(
          (e) =>
            e.actorId === "actor-synthetic-1" &&
            e.message?.type === "request" &&
            e.message?.request?.op === "complete"
        ).length === 2
    );

    expect(observedPrompts[1]).toContain("Synthetic leader worker instructions and tools");
    expect(observedPrompts[1]).toContain("Leader policy: preserve mesh protocol");
    expect(observedPrompts[1]).toContain("Host-local boundary: preserve private workdir mount");
    expect(observedPrompts[1]).toContain("### Recent run outcomes");
    expect(observedPrompts[1]).toContain("Synthetic run 1 output");
    expect(pollRequests).toBeGreaterThan(3);

    await handles.shutdown();
    expect(unregisteredCalled).toBe(true);

    await new Promise<void>((resolve, reject) =>
      leaderServer.close((err) => (err ? reject(err) : resolve()))
    );

    const dbPath = join(home, "data", "mesh.db");
    expect(existsSync(dbPath)).toBe(true);
    const db = new Database(dbPath);

    const idRow = db.prepare("SELECT * FROM instance_identity WHERE singleton = 1").get() as
      | InstanceIdentityRow
      | undefined;
    expect(idRow?.instance_id).toBe("follower-node-synthetic");
    expect(idRow?.role).toBe("follower");

    const runs = db
      .prepare("SELECT * FROM actor_runs WHERE actor_id = ? ORDER BY started_at ASC")
      .all("actor-synthetic-1") as ActorRunRow[];
    expect(runs).toHaveLength(2);
    expect(runs[0].outcome).toBe("completed");
    expect(runs[0].success).toBe(1);
    expect(runs[0].output).toBe("Synthetic run 1 output");
    expect(runs[1].outcome).toBe("completed");
    expect(runs[1].success).toBe(1);
    expect(runs[1].output).toBe("Synthetic run 2 output");

    const prompts = db
      .prepare("SELECT * FROM run_prompts ORDER BY created_at ASC")
      .all() as RunPromptRow[];
    expect(prompts).toHaveLength(2);
    expect(prompts[0].prompt).toContain("Host-local boundary: preserve private workdir mount");
    expect(prompts[1].prompt).toContain("Synthetic run 1 output");

    const contextRow = db
      .prepare("SELECT snapshot FROM portable_context_snapshots WHERE actor_id = ?")
      .get("actor-synthetic-1") as { snapshot: string } | undefined;
    expect(contextRow).toBeDefined();
    expect(contextRow?.snapshot).toContain("Host-local boundary: preserve private workdir mount");

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
    const complete = vi
      .spyOn(getRepositories("follower").actorRuns, "complete")
      .mockImplementation(() => {
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
});
