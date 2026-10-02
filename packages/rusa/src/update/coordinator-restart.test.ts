import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import http from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { buildQuotaCoordinatorUnit } from "../commands/install-service.js";
import {
  resolveOwnedPoolCoordinator,
  SystemdCoordinatorRestarter,
  waitForCoordinatorRevision,
} from "./coordinator-restart.js";

const SHA = "1".repeat(40);
const testDirs: string[] = [];

afterEach(() => {
  for (const dir of testDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

async function startReadyServer(socketPath: string, revision: string): Promise<http.Server> {
  const server = http.createServer((_request, response) => {
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify({ service: { loadedRevision: revision } }));
  });
  await new Promise<void>((resolve, reject) => {
    server.listen(socketPath, resolve);
    server.on("error", reject);
  });
  return server;
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
        systemdUserDir: dir,
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

/** A synthetic host: a checkout's built CLI, a coordinator home, a systemd user dir. */
function syntheticHost(opts: { socketPath?: string } = {}) {
  const root = mkdtempSync(join(tmpdir(), "rusa-coordinator-owner-"));
  testDirs.push(root);
  const checkout = join(root, "checkout");
  const otherCheckout = join(root, "other-checkout");
  const home = join(root, "coordinator-home");
  const systemdUserDir = join(root, "systemd-user");
  for (const dir of [checkout, otherCheckout].map((c) => join(c, "packages/rusa/dist"))) {
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "cli.js"), "");
  }
  mkdirSync(home, { recursive: true });
  mkdirSync(systemdUserDir, { recursive: true });
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
  const cliPath = (c: string) => join(c, "packages/rusa/dist/cli.js");
  const installUnit = (unitCheckout: string) =>
    writeFileSync(
      join(systemdUserDir, "rusa-quota-coordinator.service"),
      buildQuotaCoordinatorUnit({
        description: "synthetic pool coordinator",
        mcHome: home,
        cliPath: cliPath(unitCheckout),
        nodePath: "/synthetic/node",
        userPath: "/usr/bin:/bin",
        xdgRuntimeDir: join(root, "runtime"),
      })
    );
  return { root, checkout, otherCheckout, home, systemdUserDir, cliPath, installUnit };
}

describe("pool coordinator ownership", () => {
  it("skips a client-only host with no pool unit installed", () => {
    const host = syntheticHost();
    const resolved = resolveOwnedPoolCoordinator({
      systemdUserDir: host.systemdUserDir,
      cliPath: host.cliPath(host.checkout),
    });
    expect(resolved).toEqual({ skip: expect.stringMatching(/client-only/) });
  });

  it("skips a pool unit that runs another checkout's build", () => {
    const host = syntheticHost();
    host.installUnit(host.otherCheckout);
    const resolved = resolveOwnedPoolCoordinator({
      systemdUserDir: host.systemdUserDir,
      cliPath: host.cliPath(host.checkout),
    });
    expect(resolved).toEqual({ skip: expect.stringMatching(/another checkout/) });
  });

  it("targets the owned unit at the socket its own home configures", () => {
    const socketPath = "/synthetic/pool/coordinator.sock";
    const host = syntheticHost({ socketPath });
    host.installUnit(host.checkout);
    expect(
      resolveOwnedPoolCoordinator({
        systemdUserDir: host.systemdUserDir,
        cliPath: host.cliPath(host.checkout),
      })
    ).toEqual({ unit: "rusa-quota-coordinator.service", home: host.home, socketPath });
  });

  it("falls back to the socket under the unit's runtime directory, not the caller's", () => {
    const host = syntheticHost();
    host.installUnit(host.checkout);
    const resolved = resolveOwnedPoolCoordinator({
      systemdUserDir: host.systemdUserDir,
      cliPath: host.cliPath(host.checkout),
    });
    expect(resolved).toMatchObject({
      socketPath: join(host.root, "runtime", "rusa-quota", "coordinator.sock"),
    });
  });

  it("backs up an existing database into its own pre-deploy retention directory", async () => {
    const host = syntheticHost();
    const backups: [string, string][] = [];
    const restarter = new SystemdCoordinatorRestarter({
      systemdUserDir: host.systemdUserDir,
      cliPath: host.cliPath(host.checkout),
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
