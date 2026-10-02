import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import http from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { writeBuildSentinel } from "./build-sentinel.js";
import {
  READY_ENVELOPE_MAX_BYTES,
  readReadyRevision,
  resolvePoolCoordinatorOwnership,
  SystemdCoordinatorRestarter,
  waitForCoordinatorRevision,
} from "./coordinator-restart.js";
import { type BuildSeam, executeUpdate, type GitSeam, type UpdateDeps } from "./orchestrator.js";

const SHA = "1".repeat(40);
const testDirs: string[] = [];

afterEach(() => {
  for (const dir of testDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

async function listen(socketPath: string, handler: http.RequestListener): Promise<http.Server> {
  const server = http.createServer(handler);
  await new Promise<void>((resolve, reject) => {
    server.listen(socketPath, resolve);
    server.on("error", reject);
  });
  return server;
}

function startReadyServer(
  socketPath: string,
  revision: string | (() => string | null)
): Promise<http.Server> {
  return listen(socketPath, (_request, response) => {
    response.setHeader("content-type", "application/json");
    const loadedRevision = typeof revision === "function" ? revision() : revision;
    response.end(JSON.stringify({ service: { loadedRevision } }));
  });
}

function close(server: http.Server): Promise<void> {
  server.closeAllConnections();
  return new Promise((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve()))
  );
}

function socketDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "rusa-coordinator-restart-"));
  testDirs.push(dir);
  return dir;
}

describe("coordinator restart verification", () => {
  it("requires readyz to name the expected loaded revision", async () => {
    const dir = mkdtempSync(join(tmpdir(), "rusa-coordinator-restart-"));
    testDirs.push(dir);
    const socketPath = join(dir, "coordinator.sock");
    const server = await startReadyServer(socketPath, SHA);
    try {
      await expect(
        waitForCoordinatorRevision({ socketPath, expectedRevision: SHA, timeoutMs: 100 })
      ).resolves.toBeUndefined();
    } finally {
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve()))
      );
    }
  });

  it("does not accept an otherwise healthy coordinator running a different build", async () => {
    const dir = mkdtempSync(join(tmpdir(), "rusa-coordinator-restart-"));
    testDirs.push(dir);
    const socketPath = join(dir, "coordinator.sock");
    const server = await startReadyServer(socketPath, "2".repeat(40));
    try {
      await expect(
        waitForCoordinatorRevision({
          socketPath,
          expectedRevision: SHA,
          timeoutMs: 50,
          pollIntervalMs: 1,
        })
      ).rejects.toThrow(/did not report loaded revision/);
    } finally {
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve()))
      );
    }
  });

  it("restarts the target unit and waits on that coordinator's own socket", async () => {
    const dir = mkdtempSync(join(tmpdir(), "rusa-coordinator-restart-"));
    testDirs.push(dir);
    const socketPath = join(dir, "coordinator.sock");
    const server = await startReadyServer(socketPath, SHA);
    const restarted: string[] = [];
    try {
      const restarter = new SystemdCoordinatorRestarter({
        cliPath: join(dir, "dist", "cli.js"),
        restartUnit: async (unit) => void restarted.push(unit),
        timeoutMs: 100,
      });
      await restarter.restart(
        { unit: "rusa-quota-coordinator.service", home: dir, socketPath },
        SHA
      );
      expect(restarted).toEqual(["rusa-quota-coordinator.service"]);
    } finally {
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve()))
      );
    }
  });
});

describe("readiness reads are bounded in total, not by inactivity", () => {
  it("gives up on a response that keeps streaming without ending", async () => {
    const socketPath = join(socketDir(), "coordinator.sock");
    const server = await listen(socketPath, (_request, response) => {
      response.writeHead(200, { "content-type": "application/json" });
      response.write('{"service":');
      // A byte every 20ms resets any inactivity timer forever.
      const drip = setInterval(() => response.write(" "), 20);
      response.on("close", () => clearInterval(drip));
    });
    try {
      const started = Date.now();
      await expect(
        waitForCoordinatorRevision({
          socketPath,
          expectedRevision: SHA,
          timeoutMs: 300,
          pollIntervalMs: 10,
        })
      ).rejects.toThrow(/did not report loaded revision/);
      expect(Date.now() - started).toBeLessThan(1_500);
    } finally {
      await close(server);
    }
  });

  it("settles when the response is aborted mid-body", async () => {
    const socketPath = join(socketDir(), "coordinator.sock");
    const server = await listen(socketPath, (_request, response) => {
      response.writeHead(200, { "content-type": "application/json" });
      response.write('{"service":{"loadedRevision":"');
      setTimeout(() => response.socket?.destroy(), 10);
    });
    try {
      const started = Date.now();
      await expect(readReadyRevision(socketPath, 5_000)).resolves.toBeNull();
      expect(Date.now() - started).toBeLessThan(1_000);
    } finally {
      await close(server);
    }
  });

  it("refuses an envelope larger than a ready response could be", async () => {
    const socketPath = join(socketDir(), "coordinator.sock");
    const padding = "x".repeat(READY_ENVELOPE_MAX_BYTES);
    const server = await listen(socketPath, (_request, response) => {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ padding, service: { loadedRevision: SHA } }));
    });
    try {
      await expect(readReadyRevision(socketPath)).resolves.toBeNull();
    } finally {
      await close(server);
    }
  });
});

/**
 * A synthetic host with two checkouts — the pool owner's and a client's — and
 * one coordinator home. `show` renders what `systemctl --user show` prints for
 * a loaded pool unit, so ownership is decided from effective settings.
 */
function syntheticHost(opts: { socketPath?: string } = {}) {
  const root = mkdtempSync(join(tmpdir(), "rusa-coordinator-owner-"));
  testDirs.push(root);
  const owner = join(root, "owner-checkout");
  const client = join(root, "client-checkout");
  const home = join(root, "coordinator-home");
  const runtime = join(root, "runtime");
  const distDir = (c: string) => join(c, "packages/rusa/dist");
  const cliPath = (c: string) => join(distDir(c), "cli.js");
  for (const c of [owner, client]) {
    mkdirSync(distDir(c), { recursive: true });
    writeFileSync(cliPath(c), "");
  }
  mkdirSync(home, { recursive: true });
  const coordinatorConfig = [
    "github:",
    "  account: synthetic-bot",
    "rootActor:",
    "  provider: claude",
    "  model: synthetic-model",
    "providers:",
    "  claude:",
    "    cliCommand: claude",
    "quota:",
    "  coordinator:",
    "    databasePath: data/quota.db",
    ...(opts.socketPath ? [`    socketPath: ${opts.socketPath}`] : []),
  ];
  writeFileSync(join(home, "config.yaml"), `${coordinatorConfig.join("\n")}\n`);
  const exec = (cli: string, extra = "") =>
    `{ path=/synthetic/node ; argv[]=/synthetic/node ${cli} quota-coordinator --home ${home}${extra} ; ignore_errors=no ; start_time=[n/a] ; stop_time=[n/a] ; pid=0 ; code=(null) ; status=0/0 }`;
  const show = (
    over: {
      cli?: string;
      loadState?: string;
      needReload?: string;
      execStart?: string[];
      environment?: string;
    } = {}
  ) =>
    [
      `LoadState=${over.loadState ?? "loaded"}`,
      `NeedDaemonReload=${over.needReload ?? "no"}`,
      ...(over.execStart ?? [exec(over.cli ?? cliPath(owner))]).map((e) => `ExecStart=${e}`),
      `Environment=${over.environment ?? `RUSA_HOME=${home} PATH=/usr/bin:/bin XDG_RUNTIME_DIR=${runtime}`}`,
      "",
    ].join("\n");
  return { root, owner, client, home, runtime, distDir, cliPath, exec, show };
}

describe("pool coordinator ownership from effective systemd settings", () => {
  it("is not-owner on a client-only host with no pool unit loaded", () => {
    const host = syntheticHost();
    const resolved = resolvePoolCoordinatorOwnership({
      cliPath: host.cliPath(host.client),
      show: "LoadState=not-found\nNeedDaemonReload=no\n",
    });
    expect(resolved).toEqual({
      ownership: "not-owner",
      reason: expect.stringMatching(/client-only/),
    });
  });

  it("is not-owner when the effective ExecStart runs the other checkout's build", () => {
    const host = syntheticHost();
    expect(
      resolvePoolCoordinatorOwnership({ cliPath: host.cliPath(host.client), show: host.show() })
    ).toEqual({
      ownership: "not-owner",
      reason: expect.stringContaining(host.cliPath(host.owner)),
    });
  });

  it("targets the owned unit at the socket its own home configures", () => {
    const socketPath = "/synthetic/pool/coordinator.sock";
    const host = syntheticHost({ socketPath });
    expect(
      resolvePoolCoordinatorOwnership({ cliPath: host.cliPath(host.owner), show: host.show() })
    ).toEqual({
      ownership: "owner",
      target: { unit: "rusa-quota-coordinator.service", home: host.home, socketPath },
    });
  });

  it("falls back to the socket under the unit's effective runtime dir, not the caller's", () => {
    const host = syntheticHost();
    expect(
      resolvePoolCoordinatorOwnership({
        cliPath: host.cliPath(host.owner),
        show: host.show(),
        fallbackRuntimeDir: "/caller/runtime",
      })
    ).toMatchObject({
      target: { socketPath: join(host.runtime, "rusa-quota", "coordinator.sock") },
    });
  });

  it("follows a drop-in that repoints the effective ExecStart, whatever the base file says", () => {
    // systemd folds the drop-in into `show`; the base file naming the client
    // checkout is not what a restart would launch.
    const host = syntheticHost();
    const show = host.show({ cli: host.cliPath(host.owner) });
    expect(
      resolvePoolCoordinatorOwnership({ cliPath: host.cliPath(host.owner), show })
    ).toMatchObject({ ownership: "owner" });
    expect(
      resolvePoolCoordinatorOwnership({ cliPath: host.cliPath(host.client), show })
    ).toMatchObject({ ownership: "not-owner" });
  });

  it.each([
    ["systemd cannot be asked", { show: null }, /could not be asked/],
    ["a daemon-reload is pending", { needReload: "yes" }, /daemon-reload pending/],
    ["the unit failed to load", { loadState: "bad-setting" }, /load state is bad-setting/],
    ["it has no ExecStart command", { execStart: [] }, /found 0/],
    ["it has two ExecStart commands", { twoCommands: true }, /found 2/],
    [
      "its argv is not a coordinator launch",
      { execStart: ["{ path=/x ; argv[]=/x ; ignore_errors=no }"] },
      /cannot split/,
    ],
    ["its executable path has a space", { spacedCli: true }, /cannot split|does not exist/],
    ["--home and RUSA_HOME disagree", { environment: "RUSA_HOME=/elsewhere" }, /disagrees/],
  ] as const)("is unknown when %s", (_label, over, reason) => {
    const host = syntheticHost();
    const o = over as Record<string, unknown>;
    const show =
      o.show === null
        ? null
        : host.show({
            needReload: o.needReload as string | undefined,
            loadState: o.loadState as string | undefined,
            environment: o.environment as string | undefined,
            execStart: o.twoCommands
              ? [host.exec(host.cliPath(host.owner)), host.exec(host.cliPath(host.owner))]
              : o.spacedCli
                ? [host.exec(join(host.root, "spaced checkout", "dist", "cli.js"))]
                : (o.execStart as string[] | undefined),
          });
    expect(resolvePoolCoordinatorOwnership({ cliPath: host.cliPath(host.owner), show })).toEqual({
      ownership: "unknown",
      reason: expect.stringMatching(reason),
    });
  });

  it("is unknown when the coordinator home config is malformed", () => {
    const host = syntheticHost();
    writeFileSync(join(host.home, "config.yaml"), "quota: [unterminated\n");
    expect(
      resolvePoolCoordinatorOwnership({ cliPath: host.cliPath(host.owner), show: host.show() })
    ).toEqual({ ownership: "unknown", reason: expect.stringMatching(/home config/) });
  });

  it("backs up an existing database into its own pre-deploy retention directory", async () => {
    const host = syntheticHost();
    const backups: [string, string][] = [];
    const restarter = new SystemdCoordinatorRestarter({
      cliPath: host.cliPath(host.owner),
      runBackup: async (home, backupDir) => void backups.push([home, backupDir]),
    });
    const target = { unit: "rusa-quota-coordinator.service", home: host.home, socketPath: "" };

    await restarter.backup(target);
    expect(backups).toEqual([]); // no database yet: nothing to protect

    mkdirSync(join(host.home, "data"), { recursive: true });
    writeFileSync(join(host.home, "data", "quota.db"), "");
    await restarter.backup(target);
    expect(backups).toEqual([[host.home, join(host.home, "data", "backups", "pre-deploy")]]);
  });
});

const CHECKOUT_A = "a".repeat(40);
const RETAINED_B = "b".repeat(40);
const LOADED_C = "c".repeat(40);
const BUILT_D = "d".repeat(40);

/**
 * Compose the real restarter with executeUpdate against one synthetic host.
 * The fake systemd "restart" loads whatever the unit's dist sentinel says at
 * that moment, so readiness reports what a real restart would have loaded.
 */
async function composedUpdate(opts: {
  updating: "owner" | "client";
  failDrain?: boolean;
  /** What the running coordinator reports before the update (default C, distinct from B). */
  loadedAtStart?: string | null;
  /** Overwrites the restored dist's sentinel during rollback (null removes it). */
  retainedSentinel?: string | null;
  /** Whether the updating instance has a `quota.coordinator.socketPath` to dial. */
  dials?: boolean;
}) {
  const host = syntheticHost({ socketPath: join(socketDir(), "coordinator.sock") });
  const ownerDist = host.distDir(host.owner);
  const updatingCheckout = opts.updating === "owner" ? host.owner : host.client;
  const updatingDist = host.distDir(updatingCheckout);
  // Identities: checkout HEAD A, live dist B (retained by the build), loaded C.
  writeBuildSentinel(ownerDist, RETAINED_B);
  if (opts.updating === "client") writeBuildSentinel(updatingDist, RETAINED_B);
  let loaded: string | null = opts.loadedAtStart === undefined ? LOADED_C : opts.loadedAtStart;
  const configuredSocket = (
    resolvePoolCoordinatorOwnership({ cliPath: host.cliPath(host.owner), show: host.show() }) as {
      target: { socketPath: string };
    }
  ).target.socketPath;
  const server = await startReadyServer(configuredSocket, () => loaded ?? "");
  const restarts: string[] = [];
  const restarter = new SystemdCoordinatorRestarter({
    cliPath: host.cliPath(updatingCheckout),
    timeoutMs: 500,
    dialedSocketPath: opts.dials === false ? undefined : configuredSocket,
    showUnit: async () => host.show(),
    restartUnit: async (unit) => {
      restarts.push(unit);
      loaded = readFileSync(join(ownerDist, ".build-ok"), "utf8").trim() || null;
    },
    runBackup: async () => {},
  });
  const git: GitSeam & { resets: string[] } = {
    resets: [],
    async headSha() {
      return CHECKOUT_A;
    },
    async fetch() {},
    async remoteSha() {
      return BUILT_D;
    },
    async resetHard(sha: string) {
      this.resets.push(sha);
    },
    async subject() {
      return "synthetic subject";
    },
    async updateSubmodules() {},
  };
  // The build promotes D over the live dist and retains the previous tree.
  const builds: string[] = [];
  const build: BuildSeam = {
    async build(sha) {
      builds.push(sha);
      cpSync(updatingDist, `${updatingDist}.old`, { recursive: true });
      writeBuildSentinel(updatingDist, sha);
    },
    async rollback() {
      rmSync(updatingDist, { recursive: true, force: true });
      cpSync(`${updatingDist}.old`, updatingDist, { recursive: true });
      if (opts.retainedSentinel === null) rmSync(join(updatingDist, ".build-ok"));
      else if (opts.retainedSentinel) writeBuildSentinel(updatingDist, opts.retainedSentinel);
    },
  };
  const exits: number[] = [];
  const deps: UpdateDeps = {
    git,
    build,
    coordinator: restarter,
    drain: {
      engage() {},
      cancel() {},
      async waitForQuiescence() {
        if (opts.failDrain) throw new Error("drain exploded");
        return { quiesced: true, waitedMs: 0 };
      },
    },
    exit: (code) => void exits.push(code),
    alertMarker: () => {},
  };
  const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
  try {
    const result = await executeUpdate({ branch: "staging", drainTimeoutMs: 10 }, deps);
    return { result, restarts, exits, git, builds, loaded };
  } finally {
    errorSpy.mockRestore();
    await close(server);
  }
}

describe("composed update across an owner and a client checkout", () => {
  it("a client checkout's update restarts the coordinator zero times and reports its loaded revision", async () => {
    const { result, restarts, exits, loaded } = await composedUpdate({ updating: "client" });
    expect(result.ok).toBe(true);
    // C differs from the client's build D: drift, reported, not acted on.
    expect(result.coordinator).toEqual({
      outcome: "not-owner",
      reason: expect.stringContaining("owner-checkout"),
      loadedRevision: LOADED_C,
    });
    expect(restarts).toEqual([]);
    expect(loaded).toBe(LOADED_C);
    expect(exits).toEqual([0]);
  });

  it("a client that dials no coordinator reports its loaded revision as unknown", async () => {
    const { result, restarts } = await composedUpdate({ updating: "client", dials: false });
    expect(result.ok).toBe(true);
    expect(result.coordinator).toMatchObject({ outcome: "not-owner", loadedRevision: null });
    expect(restarts).toEqual([]);
  });

  it.each([
    [
      "is not the live dist B",
      LOADED_C,
      "the live dist is not the artifact the coordinator has loaded",
    ],
    ["cannot be identified", null, "the running coordinator does not report its loaded revision"],
  ] as const)("the owner's update stops before building when loaded C %s, with zero restarts", async (_label, loadedAtStart, reason) => {
    const { result, restarts, git, builds, loaded, exits } = await composedUpdate({
      updating: "owner",
      loadedAtStart,
    });
    expect(result).toMatchObject({
      ok: false,
      failedStep: "coordinator",
      error: `rollback protection unavailable: ${reason}`,
      rollbackFailed: false,
    });
    expect(result.coordinator).toEqual({
      outcome: "rollback-unavailable",
      reason,
      loadedRevision: loadedAtStart,
      artifactRevision: RETAINED_B,
    });
    expect(restarts).toEqual([]);
    expect(builds).toEqual([]);
    expect(git.resets).toEqual([]);
    expect(loaded).toBe(loadedAtStart); // the running coordinator was never disturbed
    expect(exits).toEqual([]);
  });

  it("the owner's update with B = C confirms the built artifact and records what was loaded before", async () => {
    const { result, restarts, loaded } = await composedUpdate({
      updating: "owner",
      loadedAtStart: RETAINED_B,
    });
    expect(result.ok).toBe(true);
    expect(result.coordinator).toEqual({
      outcome: "refreshed",
      previousLoadedRevision: RETAINED_B,
      loadedRevision: BUILT_D,
    });
    expect(restarts).toHaveLength(1);
    expect(loaded).toBe(BUILT_D);
  });

  it("with B = C a post-restart failure restores the coordinator to the artifact it had loaded", async () => {
    const { result, restarts, git, loaded } = await composedUpdate({
      updating: "owner",
      loadedAtStart: RETAINED_B,
      failDrain: true,
    });
    expect(result.ok).toBe(false);
    expect(result.rollbackFailed).toBe(false);
    expect(git.resets).toEqual([BUILT_D, CHECKOUT_A]);
    expect(restarts).toHaveLength(2);
    expect(loaded).toBe(RETAINED_B);
    expect(result.coordinator).toEqual({
      outcome: "restored",
      previousLoadedRevision: RETAINED_B,
      loadedRevision: RETAINED_B,
    });
  });

  it("a retained artifact that no longer matches C is degraded recovery, reported unsafe", async () => {
    const { result, restarts, loaded } = await composedUpdate({
      updating: "owner",
      loadedAtStart: RETAINED_B,
      failDrain: true,
      retainedSentinel: LOADED_C,
    });
    expect(result.rollbackFailed).toBe(true);
    expect(restarts).toHaveLength(2);
    expect(loaded).toBe(LOADED_C);
    expect(result.coordinator).toEqual({
      outcome: "degraded",
      previousLoadedRevision: RETAINED_B,
      loadedRevision: LOADED_C,
    });
  });

  it("a retained artifact with no identity is reported unsafe, not restarted onto", async () => {
    const { result, restarts, loaded } = await composedUpdate({
      updating: "owner",
      loadedAtStart: RETAINED_B,
      failDrain: true,
      retainedSentinel: null,
    });
    expect(result.rollbackFailed).toBe(true);
    expect(result.error).toBe("drain exploded");
    expect(restarts).toHaveLength(1); // the forward restart only
    expect(loaded).toBe(BUILT_D);
  });
});
