import { mkdtempSync, rmSync } from "node:fs";
import http from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { ProviderQuotaSnapshot } from "../mcp/quota-mcp.js";
import { QuotaCoordinatorClient } from "../quota/coordinator-client.js";
import { COORDINATOR_PROTOCOL_MAJOR } from "../quota/coordinator-protocol.js";
import { QuotaCoordinatorService } from "../quota/coordinator-service.js";
import { SharedQuotaStore } from "../quota/shared-store.js";
import { runQuotaSprintArm, runQuotaSprintCancel, runQuotaSprintStatus } from "./quota-sprint.js";

const T0 = Date.parse("2030-01-03T00:00:00.000Z");
const RESET = "2030-01-08T00:00:00.000Z";

const cleanups: Array<() => Promise<void> | void> = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

function tempRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "rusa-quota-sprint-cli-"));
  cleanups.push(() => rmSync(root, { recursive: true, force: true }));
  return root;
}

function output() {
  const out: string[] = [];
  const err: string[] = [];
  return {
    out,
    err,
    write: (text: string) => {
      out.push(text);
    },
    writeError: (text: string) => {
      err.push(text);
    },
  };
}

async function coordinator() {
  const root = tempRoot();
  const socketPath = join(root, "coordinator.sock");
  const store = new SharedQuotaStore(join(root, "quota.db"));
  store.configureController({ maxIntervalSeconds: 600 });
  for (const [atMs, percentLeft] of [
    [T0 - 3_600_000, 60],
    [T0, 58],
  ] as const) {
    const scrapedAt = new Date(atMs).toISOString();
    const state: ProviderQuotaSnapshot = {
      provider: "claude",
      status: "available",
      scrapedAt,
      limits: [
        { label: "Weekly", kind: "weekly", scope: "provider", percentLeft, resetAtIso: RESET },
      ],
    };
    store.recordParsed(
      store.recordRaw({ provider: "claude", scrapedAt, rawOutput: "raw" }),
      state,
      state
    );
  }
  const service = new QuotaCoordinatorService({
    socketPath,
    store,
    configuredProviders: ["claude"],
    maxIntervalSeconds: 600,
    now: () => T0 + 60_000,
    bootId: "boot-1",
  });
  await service.start();
  cleanups.push(async () => {
    await service.stop();
    store.close();
  });
  return { socketPath, client: new QuotaCoordinatorClient({ socketPath }) };
}

/** A coordinator built before the sprint minor: the route is an unknown v1 GET path to it. */
async function olderCoordinator(minor: number, major = COORDINATOR_PROTOCOL_MAJOR) {
  const root = tempRoot();
  const socketPath = join(root, "old.sock");
  const methods: string[] = [];
  const server = http.createServer((req, res) => {
    methods.push(req.method ?? "");
    req.resume();
    res.writeHead(req.method === "GET" ? 404 : 405, { "Content-Type": "application/json" });
    res.end(
      JSON.stringify({
        service: { protocolMajor: major, protocolMinor: minor },
        error: { code: "not_found", message: "Not found", retryable: false },
      })
    );
  });
  await new Promise<void>((resolve) => server.listen(socketPath, resolve));
  cleanups.push(() => new Promise<void>((resolve) => server.close(() => resolve())));
  return { methods, client: new QuotaCoordinatorClient({ socketPath }) };
}

describe("rusa quota-sprint (#861)", () => {
  it("reads status, arms and cancels over the socket, exiting 0 on success and 1 on refusal", async () => {
    const { client } = await coordinator();
    const io = output();
    expect(await runQuotaSprintStatus({ provider: "Claude", client, ...io })).toBe(0);
    const status = JSON.parse(io.out.join(""));
    expect(status).toMatchObject({ provider: "claude", boot: { id: "boot-1" }, policy: null });
    expect(status.buckets[0]).toMatchObject({ key: "claude:weekly", cycleAnchor: RESET });

    const armOptions = {
      provider: "claude",
      client,
      bootId: status.boot.id,
      revision: String(status.revision),
      bucket: "claude:weekly",
      cycleAnchor: status.buckets[0].cycleAnchor,
      generation: String(status.readingMode.generation),
      requestId: "cli-arm-1",
      expiresAt: "2030-01-05T00:00:00Z",
      confirmResetUsable: true,
    };
    const armIo = output();
    expect(await runQuotaSprintArm({ ...armOptions, ...armIo })).toBe(0);
    const armed = JSON.parse(armIo.out.join(""));
    expect(armed).toMatchObject({ action: "arm", duplicate: false, revision: 1 });

    // The same command again, as after a lost response: a recorded replay.
    const retryIo = output();
    expect(await runQuotaSprintArm({ ...armOptions, ...retryIo })).toBe(0);
    expect(JSON.parse(retryIo.out.join(""))).toMatchObject({ duplicate: true });

    const refusedIo = output();
    expect(await runQuotaSprintArm({ ...armOptions, requestId: "cli-arm-2", ...refusedIo })).toBe(
      1
    );
    expect(refusedIo.out).toEqual([]);
    expect(JSON.parse(refusedIo.err.join("")).error.code).toBe("sprint_revision_conflict");

    const cancelIo = output();
    expect(
      await runQuotaSprintCancel({
        provider: "claude",
        client,
        bootId: "boot-1",
        revision: 1,
        armId: armed.policy.armId,
        ...cancelIo,
      })
    ).toBe(0);
    expect(JSON.parse(cancelIo.out.join("")).lastEnded).toMatchObject({ reason: "cancelled" });
  });

  it("refuses an older coordinator without sending it a state-changing request", async () => {
    const old = await olderCoordinator(4);
    const statusIo = output();
    expect(
      await runQuotaSprintStatus({ provider: "claude", client: old.client, ...statusIo })
    ).toBe(1);
    expect(statusIo.err.join("")).toContain(
      "Coordinator protocol minor 4 predates the weekly sprint"
    );

    const armIo = output();
    expect(
      await runQuotaSprintArm({
        provider: "claude",
        client: old.client,
        bootId: "boot-1",
        revision: 0,
        bucket: "claude:weekly",
        cycleAnchor: RESET,
        generation: 0,
        requestId: "cli-arm-1",
        expiresAt: "2030-01-05T00:00:00Z",
        confirmResetUsable: true,
        ...armIo,
      })
    ).toBe(1);
    const cancelIo = output();
    expect(
      await runQuotaSprintCancel({
        provider: "claude",
        client: old.client,
        bootId: "boot-1",
        revision: 0,
        armId: "arm",
        ...cancelIo,
      })
    ).toBe(1);
    expect(armIo.err.join("")).toContain("predates the weekly sprint");
    expect(old.methods).toEqual(["GET", "GET", "GET"]);
  });

  it("refuses a different protocol major and an unreachable socket", async () => {
    const otherMajor = await olderCoordinator(5, COORDINATOR_PROTOCOL_MAJOR + 1);
    const majorIo = output();
    expect(
      await runQuotaSprintStatus({ provider: "claude", client: otherMajor.client, ...majorIo })
    ).toBe(1);
    expect(majorIo.err.join("")).toContain(
      `Coordinator protocol major ${COORDINATOR_PROTOCOL_MAJOR + 1} is not`
    );

    const unreachable = output();
    expect(
      await runQuotaSprintStatus({
        provider: "claude",
        client: new QuotaCoordinatorClient({ socketPath: join(tempRoot(), "missing.sock") }),
        ...unreachable,
      })
    ).toBe(1);
    expect(unreachable.err.join("")).toContain("Coordinator unreachable");
  });

  it("rejects bad arguments before contacting the coordinator", async () => {
    const old = await olderCoordinator(5);
    const base = {
      provider: "claude",
      client: old.client,
      bootId: "boot-1",
      revision: 0,
      bucket: "claude:weekly",
      cycleAnchor: RESET,
      generation: 0,
      requestId: "cli-arm-1",
      expiresAt: "2030-01-05T00:00:00Z",
      confirmResetUsable: true,
      ...output(),
    };
    await expect(runQuotaSprintArm({ ...base, confirmResetUsable: false })).rejects.toThrow(
      "--confirm-reset-usable is required"
    );
    await expect(runQuotaSprintArm({ ...base, provider: "nope" })).rejects.toThrow(
      "--provider must name a quota-paced provider"
    );
    await expect(runQuotaSprintArm({ ...base, revision: "1.5" })).rejects.toThrow(
      "--revision must be a non-negative integer"
    );
    await expect(runQuotaSprintArm({ ...base, generation: "-1" })).rejects.toThrow(
      "--generation must be a non-negative integer"
    );
    expect(old.methods).toEqual([]);
  });
});
