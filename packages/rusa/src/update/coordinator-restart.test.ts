import http from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { SystemdCoordinatorRestarter, waitForCoordinatorRevision } from "./coordinator-restart.js";

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
      await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
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
      await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
    }
  });

  it("restarts the fixed pool unit before waiting for its exact revision", async () => {
    const dir = mkdtempSync(join(tmpdir(), "rusa-coordinator-restart-"));
    testDirs.push(dir);
    const socketPath = join(dir, "coordinator.sock");
    const server = await startReadyServer(socketPath, SHA);
    const restarted: string[] = [];
    try {
      const restarter = new SystemdCoordinatorRestarter({
        socketPath,
        restartUnit: async (unit) => void restarted.push(unit),
        timeoutMs: 100,
      });
      await restarter.restart(SHA);
      expect(restarted).toEqual(["rusa-quota-coordinator.service"]);
    } finally {
      await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
    }
  });
});
