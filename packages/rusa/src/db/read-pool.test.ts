// @vitest-environment node
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import Database from "better-sqlite3";
import { build } from "tsup";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type DashboardDataDeps, handleMeshApiRequest } from "../dashboard/api.js";
import { closeDb, getRepositories, initDb, meshDbPath } from "./index.js";
import {
  bundledReadWorker,
  DbReadPool,
  DbReadPoolClosedError,
  DbReadQueueFullError,
  DbReadUnavailableError,
  DbReadWorkerExitedError,
} from "./read-pool.js";

// These tests run the real pool, worker runtime, read-only connections and
// repositories against a real migrated database file (#1289). The worker is
// the production entry's runtime with two test operations added: `hold`, a
// database statement that occupies its connection for a given time, standing
// in for a long query; and `exit`, a worker that dies mid-request.

const here = dirname(fileURLToPath(import.meta.url));
const packageRoot = join(here, "..", "..");

const TEST_WORKER_SOURCE = (src: string) => `
import { parentPort, workerData } from "node:worker_threads";
import { READ_OPERATIONS } from ${JSON.stringify(join(src, "db/read-operations.ts"))};
import { openReadConnection, serveReads } from ${JSON.stringify(join(src, "db/read-worker-runtime.ts"))};

const db = openReadConnection(workerData.dbPath);
const pause = new Int32Array(new SharedArrayBuffer(4));
db.function("hold_ms", (ms) => {
  Atomics.wait(pause, 0, 0, Number(ms));
  return Number(ms);
});
const countObligations = () => db.prepare("SELECT COUNT(*) AS n FROM obligations").get().n;
if (!parentPort) throw new Error("not a worker");
serveReads(parentPort, db, {
  ...READ_OPERATIONS,
  hold: (_repos, input) => db.prepare("SELECT hold_ms(?) AS ms").get(input.ms).ms,
  countAcrossHold: (_repos, input) => {
    const before = countObligations();
    db.prepare("SELECT hold_ms(?)").get(input.ms);
    return { before, after: countObligations() };
  },
  exit: () => process.exit(7),
});
`;

/** The test worker's extra operations, which the production table does not name. */
interface TestReads {
  read(op: "hold", input: { ms: number }): Promise<number>;
  read(op: "countAcrossHold", input: { ms: number }): Promise<{ before: number; after: number }>;
  read(op: "exit", input: Record<string, never>): Promise<never>;
}
const testReads = (pool: DbReadPool) => pool as unknown as TestReads;

let home: string;
let buildDir: string;
/** Obligation owners: two user principals in the test database. */
let ownerA: string;
let ownerB: string;
let workerUrl: URL;

/** Largest gap between 5 ms ticks while `work` runs: how long the event loop was held. */
async function maxLoopGap<T>(work: () => Promise<T>): Promise<{ gap: number; value: T }> {
  let last = performance.now();
  let gap = 0;
  const timer = setInterval(() => {
    const now = performance.now();
    gap = Math.max(gap, now - last);
    last = now;
  }, 5);
  try {
    const value = await work();
    gap = Math.max(gap, performance.now() - last);
    return { gap, value };
  } finally {
    clearInterval(timer);
  }
}

beforeAll(async () => {
  home = mkdtempSync(join(tmpdir(), "rusa-read-pool-"));
  initDb(home);
  const repos = getRepositories();
  const createdAt = new Date().toISOString();
  ownerA = repos.principals.createUser({ email: "a@example.test", createdAt }).id;
  ownerB = repos.principals.createUser({ email: "b@example.test", createdAt }).id;
  repos.obligations.create({ id: "root-a", title: "Root A", ownerId: ownerA });
  repos.obligations.create({
    id: "child-a",
    parentId: "root-a",
    title: "Child A",
    ownerId: ownerA,
  });

  // Bundled beside the package's node_modules so better-sqlite3 resolves.
  buildDir = join(packageRoot, "node_modules", ".cache", `read-pool-test-${process.pid}`);
  mkdirSync(buildDir, { recursive: true });
  const entry = join(buildDir, "test-read-worker.ts");
  writeFileSync(entry, TEST_WORKER_SOURCE(join(packageRoot, "src")));
  await build({
    entry: { "test-read-worker": entry },
    outDir: buildDir,
    format: ["esm"],
    target: "node20",
    external: ["better-sqlite3"],
    silent: true,
    clean: false,
  });
  workerUrl = pathToFileURL(join(buildDir, "test-read-worker.js"));
}, 60_000);

afterAll(() => {
  closeDb();
  if (home) rmSync(home, { recursive: true, force: true });
  if (buildDir) rmSync(buildDir, { recursive: true, force: true });
});

const openPool = (options: { size?: number; maxQueued?: number; dbPath?: string } = {}) =>
  DbReadPool.open({ dbPath: meshDbPath(home), worker: workerUrl, ...options });

describe("DbReadPool", () => {
  it("control: the same long statement on the main thread holds the event loop", async () => {
    // Without this arm, the responsiveness test below could pass for a reason
    // other than the work having left the main thread.
    const db = new Database(meshDbPath(home), { readonly: true });
    const pause = new Int32Array(new SharedArrayBuffer(4));
    db.function("hold_ms", (ms) => {
      Atomics.wait(pause, 0, 0, Number(ms));
      return Number(ms);
    });
    try {
      const { gap } = await maxLoopGap(async () => {
        await new Promise((resolve) => setTimeout(resolve, 20));
        db.prepare("SELECT hold_ms(?)").get(800);
        await new Promise((resolve) => setTimeout(resolve, 20));
      });
      expect(gap).toBeGreaterThanOrEqual(750);
    } finally {
      db.close();
    }
  });

  it("serves an unrelated request and a short read on the other worker while a long read runs", async () => {
    const pool = await openPool({ size: 2 });
    const deps = {
      reads: pool,
      obligations: getRepositories().obligations,
    } as unknown as DashboardDataDeps;
    const server: Server = createServer((req, res) => {
      const url = new URL(req.url ?? "/", "http://localhost");
      if (url.pathname === "/ping") {
        res.end("pong");
        return;
      }
      void handleMeshApiRequest(req, res, url, deps);
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    try {
      const { gap, value } = await maxLoopGap(async () => {
        let longDone = false;
        const long = testReads(pool)
          .read("hold", { ms: 1500 })
          .then((ms) => {
            longDone = true;
            return ms;
          });
        await new Promise((resolve) => setTimeout(resolve, 50));

        const pingStart = performance.now();
        const ping = await (await fetch(`${base}/ping`)).text();
        const pingMs = performance.now() - pingStart;

        const pageStart = performance.now();
        const page = (await (
          await fetch(`${base}/api/mesh/obligations?rootsOnly=true`)
        ).json()) as {
          obligations: Array<{ id: string }>;
        };
        const pageMs = performance.now() - pageStart;
        const shortFinishedFirst = !longDone;

        return { ping, pingMs, page, pageMs, shortFinishedFirst, held: await long };
      });

      expect(value.ping).toBe("pong");
      expect(value.page.obligations.map((row) => row.id)).toEqual(["root-a"]);
      expect(value.shortFinishedFirst).toBe(true);
      expect(value.held).toBe(1500);
      // Generous bounds for shared CI runners; the control above shows the
      // same statement on the main thread holds the loop for its full length.
      expect(value.pingMs).toBeLessThan(500);
      expect(value.pageMs).toBeLessThan(500);
      expect(gap).toBeLessThan(500);
    } finally {
      await new Promise((resolve) => server.close(resolve));
      await pool.close();
    }
  });

  it("sees every write the main connection committed before the read was dispatched", async () => {
    const pool = await openPool();
    const repos = getRepositories();
    try {
      for (let round = 0; round < 6; round++) {
        repos.obligations.setCheckpoint("child-a", `round ${round}`, ownerA);
        const detail = await pool.read("obligationDetail", {
          id: "child-a",
          limit: 10,
          offset: 0,
          completionsOffset: 0,
          blockedByOffset: 0,
          blocksOffset: 0,
          historyLimit: 10,
        });
        expect(detail?.obligation.checkpoint).toBe(`round ${round}`);
        expect(detail?.ancestors.map((row) => row.id)).toEqual(["root-a"]);
      }
      repos.obligations.create({ id: "root-b", title: "Root B", ownerId: ownerB });
      const page = await pool.read("obligationPage", {
        ownerId: ownerB,
        limit: 10,
        offset: 0,
        ancestors: false,
      });
      expect(page.obligations.map((row) => row.id)).toEqual(["root-b"]);
    } finally {
      await pool.close();
    }
  });

  it("answers one operation from one snapshot even if a write commits mid-operation", async () => {
    const pool = await openPool();
    try {
      const pending = testReads(pool).read("countAcrossHold", { ms: 300 });
      await new Promise((resolve) => setTimeout(resolve, 100));
      getRepositories().obligations.create({
        id: "mid-read",
        title: "Committed mid-read",
        ownerId: ownerA,
      });
      const { before, after } = await pending;
      expect(after).toBe(before);
      // The next operation takes a fresh snapshot that includes it.
      const next = await testReads(pool).read("countAcrossHold", { ms: 0 });
      expect(next.before).toBe(before + 1);
    } finally {
      await pool.close();
    }
  });

  it("carries an operation's error back with its message and keeps serving", async () => {
    const pool = await openPool({ size: 1 });
    try {
      await expect(
        pool.read("inboxPage", { actorId: "actor-a", options: { limit: 500 } })
      ).rejects.toThrow("inbox list limit must be an integer from 1 to 100");
      await expect(
        (pool as unknown as { read(op: string, input: unknown): Promise<unknown> }).read(
          "noSuchRead",
          {}
        )
      ).rejects.toThrow("unknown read operation: noSuchRead");
      const page = await pool.read("inboxPage", { actorId: "actor-a", options: {} });
      expect(page.entries).toEqual([]);
    } finally {
      await pool.close();
    }
  });

  it("rejects the read a dying worker held, replaces the worker and serves the next read", async () => {
    const pool = await openPool({ size: 1 });
    try {
      await expect(testReads(pool).read("exit", {})).rejects.toBeInstanceOf(
        DbReadWorkerExitedError
      );
      const tree = await pool.read("obligationTree", { id: "root-a" });
      expect(tree?.children.map((child) => child.obligation.id)).toEqual(["child-a"]);
    } finally {
      await pool.close();
    }
  });

  it("refuses reads beyond its queue bound instead of buffering without limit", async () => {
    const pool = await openPool({ size: 1, maxQueued: 1 });
    try {
      const running = testReads(pool).read("hold", { ms: 200 });
      const queued = pool.read("obligationTree", { id: "missing" });
      await expect(pool.read("obligationTree", { id: "missing" })).rejects.toBeInstanceOf(
        DbReadQueueFullError
      );
      await expect(running).resolves.toBe(200);
      await expect(queued).resolves.toBeNull();
    } finally {
      await pool.close();
    }
  });

  it("drains accepted reads on close and refuses new ones", async () => {
    const pool = await openPool({ size: 1 });
    const running = testReads(pool).read("hold", { ms: 200 });
    const queued = pool.read("obligationTree", { id: "root-a" });
    const closing = pool.close();
    await expect(pool.read("obligationTree", { id: "root-a" })).rejects.toBeInstanceOf(
      DbReadPoolClosedError
    );
    await expect(running).resolves.toBe(200);
    await expect(queued).resolves.toMatchObject({ obligation: { id: "root-a" } });
    await closing;
  });

  it("keeps reads in-process only from source; a built run missing its worker fails startup", async () => {
    expect(bundledReadWorker(pathToFileURL(join(here, "read-pool.ts")).href)).toBeNull();
    const dir = mkdtempSync(join(tmpdir(), "rusa-read-pool-dist-"));
    try {
      const worker = bundledReadWorker(pathToFileURL(join(dir, "chunk-abc123.js")).href);
      expect(worker).toBe(join(dir, "db-read-worker.js"));
      await expect(
        DbReadPool.open({ dbPath: meshDbPath(home), worker: worker as string })
      ).rejects.toThrow(/Cannot find module/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("answers 503 when the pool cannot serve a route's read, including the tree route", async () => {
    const pool = await openPool({ size: 1, maxQueued: 0 });
    const deps = {
      reads: pool,
      obligations: getRepositories().obligations,
    } as unknown as DashboardDataDeps;
    const server: Server = createServer((req, res) => {
      void handleMeshApiRequest(req, res, new URL(req.url ?? "/", "http://localhost"), deps);
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    try {
      const running = testReads(pool).read("hold", { ms: 1000 });
      await new Promise((resolve) => setTimeout(resolve, 50));
      for (const path of ["/api/mesh/obligations", "/api/mesh/obligations/root-a/tree"]) {
        const response = await fetch(`${base}${path}`);
        expect({ path, status: response.status }).toEqual({ path, status: 503 });
        expect(((await response.json()) as { error: string }).error).toMatch(/queue is full/);
      }
      await running;
      const tree = await fetch(`${base}/api/mesh/obligations/root-a/tree`);
      expect(tree.status).toBe(200);
    } finally {
      await new Promise((resolve) => server.close(resolve));
      await pool.close();
    }
  });

  it("fails startup when its workers cannot open the database", async () => {
    await expect(openPool({ dbPath: join(home, "data", "absent.db") })).rejects.toThrow();
  });

  it("stops replacing workers that keep failing to start and refuses reads with the cause", async () => {
    const dir = mkdtempSync(join(tmpdir(), "rusa-read-pool-gone-"));
    const dbPath = join(dir, "gone.db");
    const db = new Database(dbPath);
    db.exec("CREATE TABLE obligations (id TEXT)");
    db.close();
    const pool = await openPool({ size: 1, dbPath });
    try {
      rmSync(dbPath);
      await expect(testReads(pool).read("exit", {})).rejects.toBeInstanceOf(
        DbReadWorkerExitedError
      );
      let failure: unknown;
      for (let attempt = 0; attempt < 100 && failure === undefined; attempt++) {
        await new Promise((resolve) => setTimeout(resolve, 50));
        failure = await pool.read("obligationTree", { id: "x" }).then(
          () => undefined,
          (err: unknown) => (err instanceof DbReadWorkerExitedError ? undefined : err)
        );
      }
      expect(failure).toBeInstanceOf(DbReadUnavailableError);
      expect(String(failure)).toMatch(/read workers failed to start 3 times/);
    } finally {
      await pool.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
