// @vitest-environment node
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "tsup";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  TEST_WRITE_OPERATIONS,
  type TestEffect,
  type TestWriteOperations,
} from "./fixtures/test-write-operations.js";
import { closeDb, getDb, getRepositories, initDb, meshDbPath } from "./index.js";
import {
  DbWriteBuildMismatchError,
  DbWriteQueueFullError,
  DbWriter,
  DbWriterClosedError,
  DbWriteUnavailableError,
  type DeliverEffect,
  InProcessMeshWriter,
  MeshWriteCommittedError,
  MeshWriteOutcomeUnknownError,
  type MeshWriter,
} from "./mesh-writer.js";

// The writer facade (#1289) against a real migrated database file: the
// in-process writer on the main connection, and the one-worker writer running
// the production write runtime in a worker built from the test fixture.

const here = dirname(fileURLToPath(import.meta.url));
const packageRoot = join(here, "..", "..");

let home: string;
let buildDir: string;
let owner: string;
/** The test worker, built without a build id, as this process runs from source. */
let workerPath: string;
/** The same worker built as another build would be. */
let otherBuildWorkerPath: string;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const exists = (id: string) => getRepositories().obligations.get(id) !== null;
const countTitled = (title: string) =>
  (
    getDb().prepare("SELECT COUNT(*) AS n FROM obligations WHERE title = ?").get(title) as {
      n: number;
    }
  ).n;

/** Settle `promise` and return what it rejected with, or fail if it resolved. */
async function rejection(promise: Promise<unknown>): Promise<Error> {
  return promise.then(
    (value) => {
      throw new Error(`expected a rejection, got ${JSON.stringify(value)}`);
    },
    (err: Error) => err
  );
}

beforeAll(async () => {
  home = mkdtempSync(join(tmpdir(), "rusa-mesh-writer-"));
  initDb(home);
  owner = getRepositories().principals.createUser({
    email: "writer@example.test",
    createdAt: new Date().toISOString(),
  }).id;

  // Bundled beside the package's node_modules so better-sqlite3 resolves.
  buildDir = join(packageRoot, "node_modules", ".cache", `mesh-writer-test-${process.pid}`);
  mkdirSync(buildDir, { recursive: true });
  const entry = join(here, "fixtures", "test-write-worker.ts");
  const options = {
    config: false,
    format: ["esm" as const],
    target: "node20",
    external: ["better-sqlite3"],
    silent: true,
    clean: false,
  };
  await build({ ...options, entry: { "test-write-worker": entry }, outDir: buildDir });
  await build({
    ...options,
    entry: { "test-write-worker": entry },
    outDir: join(buildDir, "other"),
    define: { __RUSA_BUILD_ID__: JSON.stringify("other-build") },
  });
  workerPath = join(buildDir, "test-write-worker.js");
  otherBuildWorkerPath = join(buildDir, "other", "test-write-worker.js");
}, 60_000);

afterAll(() => {
  closeDb();
  if (home) rmSync(home, { recursive: true, force: true });
  if (buildDir) rmSync(buildDir, { recursive: true, force: true });
});

const openDbWriter = (deliver: DeliverEffect<TestEffect>, options: { maxQueued?: number } = {}) =>
  DbWriter.open<TestEffect, TestWriteOperations>({
    dbPath: meshDbPath(home),
    worker: workerPath,
    deliver,
    ...options,
  });

interface OpenedWriter {
  readonly writer: MeshWriter<TestWriteOperations>;
  close(): Promise<void>;
}

const WRITERS: { name: string; open(deliver: DeliverEffect<TestEffect>): Promise<OpenedWriter> }[] =
  [
    {
      name: "in-process",
      open: async (deliver) => ({
        writer: new InProcessMeshWriter(
          getDb(),
          { obligations: getRepositories().obligations },
          TEST_WRITE_OPERATIONS,
          deliver
        ),
        close: async () => undefined,
      }),
    },
    {
      name: "worker",
      open: async (deliver) => {
        const writer = await openDbWriter(deliver);
        return { writer, close: () => writer.close() };
      },
    },
  ];

describe.each(WRITERS)("$name writer", ({ name, open }) => {
  const id = (label: string) => `${name}-${label}`;
  const input = (label: string) => ({ id: id(label), title: id(label), ownerId: owner });

  it("delivers each effect after the commit, in order, before the caller continues", async () => {
    const log: string[] = [];
    const { writer, close } = await open((effect) => {
      log.push(`${effect.kind}:${effect.id}:${exists(effect.id) ? "committed" : "absent"}`);
    });
    try {
      const result = await writer.write("create", input("ordered"));
      log.push(`continue:${result.id}`);
      expect(log).toEqual([
        `created:${id("ordered")}:committed`,
        `announced:${id("ordered")}:committed`,
        `continue:${id("ordered")}`,
      ]);
    } finally {
      await close();
    }
  });

  it("rejects a rolled-back write with the operation's own error and delivers nothing", async () => {
    const delivered: TestEffect[] = [];
    const { writer, close } = await open((effect) => delivered.push(effect));
    try {
      const err = await rejection(writer.write("fail", input("rolled-back")));
      expect(err.name).toBe("WriteConflictError");
      expect(err.message).toBe(`${id("rolled-back")} conflicts`);
      expect(err).not.toBeInstanceOf(MeshWriteCommittedError);
      expect(delivered).toEqual([]);
      expect(exists(id("rolled-back"))).toBe(false);
      // The writer keeps serving.
      await writer.write("create", input("after-rollback"));
      expect(exists(id("after-rollback"))).toBe(true);
    } finally {
      await close();
    }
  });

  it("keeps the commit when an effect fails, delivers the rest and says it committed", async () => {
    const delivered: string[] = [];
    const { writer, close } = await open((effect) => {
      if (effect.kind === "created") throw new Error("listener broke");
      delivered.push(`${effect.kind}:${effect.id}`);
    });
    try {
      const err = await rejection(writer.write("create", input("effect-failed")));
      expect(err).toBeInstanceOf(MeshWriteCommittedError);
      const committed = err as MeshWriteCommittedError;
      expect(committed.committed).toBe(true);
      expect(committed.result).toEqual({ id: id("effect-failed") });
      expect(committed.failures.map(String)).toEqual(["Error: listener broke"]);
      expect(delivered).toEqual([`announced:${id("effect-failed")}`]);
      expect(exists(id("effect-failed"))).toBe(true);
    } finally {
      await close();
    }
  });

  it("delivers every effect when only the committed result cannot be returned", async () => {
    const delivered: string[] = [];
    const { writer, close } = await open((effect) => delivered.push(`${effect.kind}:${effect.id}`));
    try {
      const err = await rejection(writer.write("uncloneable", input("uncloneable")));
      expect(err).toBeInstanceOf(MeshWriteCommittedError);
      expect(err.message).toMatch(/committed, but its result could not be returned/);
      const committed = err as MeshWriteCommittedError;
      expect(committed.result).toBeUndefined();
      expect(committed.failures).toEqual([]);
      expect(delivered).toEqual([`created:${id("uncloneable")}`, `announced:${id("uncloneable")}`]);
      expect(exists(id("uncloneable"))).toBe(true);
    } finally {
      await close();
    }
  });

  it("delivers the other effects and the result when one effect cannot be returned", async () => {
    const delivered: string[] = [];
    const { writer, close } = await open((effect) => delivered.push(`${effect.kind}:${effect.id}`));
    try {
      const err = await rejection(writer.write("uncloneableEffect", input("bad-effect")));
      expect(err).toBeInstanceOf(MeshWriteCommittedError);
      const committed = err as MeshWriteCommittedError;
      expect(committed.result).toEqual({ id: id("bad-effect") });
      expect(committed.failures.map(String)).toEqual([
        expect.stringMatching(/^Error: effect 2 of 2 could not be returned: /),
      ]);
      expect(delivered).toEqual([`created:${id("bad-effect")}`]);
      expect(exists(id("bad-effect"))).toBe(true);
    } finally {
      await close();
    }
  });

  it("refuses an input that cannot be cloned without attempting it, then keeps serving", async () => {
    const delivered: TestEffect[] = [];
    const { writer, close } = await open((effect) => delivered.push(effect));
    try {
      const bad = { ...input("bad-input"), callback: () => undefined };
      const err = await rejection(writer.write("create", bad));
      expect(err.name).toBe("DataCloneError");
      expect(err).not.toBeInstanceOf(MeshWriteCommittedError);
      expect(exists(id("bad-input"))).toBe(false);
      await writer.write("create", input("after-bad-input"));
      expect(exists(id("after-bad-input"))).toBe(true);
      expect(delivered.map((effect) => effect.id)).toEqual([
        id("after-bad-input"),
        id("after-bad-input"),
      ]);
    } finally {
      await close();
    }
  });

  it("lets a delivery read committed state and write again, delivered in commit order", async () => {
    const log: string[] = [];
    let nested: Promise<unknown> | undefined;
    const { writer, close } = await open((effect) => {
      log.push(`${effect.kind}:${effect.id}`);
      if (effect.kind === "created" && effect.id === id("parent")) {
        // A listener's own read and write, as the inbox listeners do today.
        log.push(`read:${getRepositories().obligations.get(id("parent"))?.title}`);
        nested = writer.write("create", input("child"));
      }
    });
    try {
      await writer.write("create", input("parent"));
      await nested;
      expect(log).toEqual([
        `created:${id("parent")}`,
        `read:${id("parent")}`,
        `announced:${id("parent")}`,
        `created:${id("child")}`,
        `announced:${id("child")}`,
      ]);
      expect(exists(id("child"))).toBe(true);
    } finally {
      await close();
    }
  });
});

describe("InProcessMeshWriter", () => {
  const input = (label: string) => ({ id: `ip-${label}`, title: `ip-${label}`, ownerId: owner });
  const repos = () => ({ obligations: getRepositories().obligations });

  it("commits and delivers when called, so a synchronous write beside it keeps its order", () => {
    const log: string[] = [];
    const writer = new InProcessMeshWriter(
      getDb(),
      repos(),
      TEST_WRITE_OPERATIONS,
      (effect: TestEffect) => log.push(`${effect.kind}:${effect.id}`)
    );
    const pending = writer.write("create", input("at-call"));
    log.push(`after-call:${exists("ip-at-call")}`);
    expect(log).toEqual(["created:ip-at-call", "announced:ip-at-call", "after-call:true"]);
    return pending.then((result) => expect(result).toEqual({ id: "ip-at-call" }));
  });

  it("refuses to run inside an open transaction", async () => {
    const delivered: TestEffect[] = [];
    const writer = new InProcessMeshWriter(
      getDb(),
      repos(),
      TEST_WRITE_OPERATIONS,
      (effect: TestEffect) => delivered.push(effect)
    );
    let pending: Promise<unknown> | undefined;
    getDb().transaction(() => {
      pending = writer.write("create", input("in-transaction"));
    })();
    await expect(pending).rejects.toThrow(/called inside an open transaction/);
    expect(delivered).toEqual([]);
    expect(exists("ip-in-transaction")).toBe(false);
  });
});

describe("DbWriter", () => {
  const input = (label: string) => ({ id: `w-${label}`, title: `w-${label}`, ownerId: owner });

  it("delivers one write's effects and runs its continuation before the next write's", async () => {
    const log: string[] = [];
    const writer = await openDbWriter((effect) => log.push(`${effect.kind}:${effect.id}`));
    try {
      const labels = ["fifo-1", "fifo-2", "fifo-3"];
      await Promise.all(
        labels.map((label) =>
          writer.write("create", input(label)).then((result) => log.push(`continue:${result.id}`))
        )
      );
      expect(log).toEqual(
        labels.flatMap((label) => [
          `created:w-${label}`,
          `announced:w-${label}`,
          `continue:w-${label}`,
        ])
      );
    } finally {
      await writer.close();
    }
  });

  it("does not replay a write whose worker died with its transaction open", async () => {
    const writer = await openDbWriter(() => undefined);
    try {
      const err = await rejection(writer.write("exitInTransaction", input("mid-transaction")));
      expect(err).toBeInstanceOf(MeshWriteOutcomeUnknownError);
      expect(err).not.toBeInstanceOf(DbWriteUnavailableError);
      // The replacement takes the write lock the dead worker held, and serves.
      await writer.write("create", input("after-mid-transaction"));
      await sleep(100);
      expect(exists("w-mid-transaction")).toBe(false);
      expect(exists("w-after-mid-transaction")).toBe(true);
    } finally {
      await writer.close();
    }
  });

  it("reports an unknown outcome, never a retry, when the worker dies after committing", async () => {
    const writer = await openDbWriter(() => undefined);
    try {
      // No id, so a replay would add a second row rather than conflict.
      const title = "w-after-commit";
      const err = await rejection(writer.write("exitAfterCommit", { title, ownerId: owner }));
      expect(err).toBeInstanceOf(MeshWriteOutcomeUnknownError);
      expect(err.message).toMatch(/may have committed and is not retried/);
      await writer.write("create", input("after-exit-after-commit"));
      await sleep(100);
      expect(countTitled(title)).toBe(1);
    } finally {
      await writer.close();
    }
  });

  it("refuses writes beyond its queue bound", async () => {
    const writer = await openDbWriter(() => undefined, { maxQueued: 1 });
    try {
      const held = writer.write("hold", { ...input("held"), ms: 300 });
      const queued = writer.write("create", input("queued"));
      await expect(writer.write("create", input("refused"))).rejects.toBeInstanceOf(
        DbWriteQueueFullError
      );
      await Promise.all([held, queued]);
      expect(exists("w-refused")).toBe(false);
    } finally {
      await writer.close();
    }
  });

  it("refuses a queued input that cannot be cloned and still serves and drains the rest", async () => {
    const writer = await openDbWriter(() => undefined);
    const badInput = { ...input("admit-bad"), callback: () => undefined };
    const held = writer.write("hold", { ...input("admit-held"), ms: 200 });
    const bad = writer.write("create", badInput);
    const after = writer.write("create", input("admit-after"));
    const err = await rejection(bad);
    expect(err.name).toBe("DataCloneError");
    await expect(held).resolves.toEqual({ id: "w-admit-held" });
    await expect(after).resolves.toEqual({ id: "w-admit-after" });
    await writer.close();
    expect(exists("w-admit-bad")).toBe(false);
  });

  it("runs a queued write with its input as it was when called", async () => {
    const writer = await openDbWriter(() => undefined);
    try {
      const held = writer.write("hold", { ...input("snapshot-held"), ms: 200 });
      const queuedInput = { ...input("snapshot"), title: "w-snapshot-as-called" };
      const queued = writer.write("create", queuedInput);
      queuedInput.title = "w-snapshot-changed-later";
      await Promise.all([held, queued]);
      expect(getRepositories().obligations.get("w-snapshot")?.title).toBe("w-snapshot-as-called");
    } finally {
      await writer.close();
    }
  });

  it("finishes accepted writes on close and refuses new ones", async () => {
    const delivered: string[] = [];
    const writer = await openDbWriter((effect) => delivered.push(`${effect.kind}:${effect.id}`));
    const held = writer.write("hold", { ...input("drain-held"), ms: 200 });
    const queued = writer.write("create", input("drain-queued"));
    const closing = writer.close();
    const refused = await rejection(writer.write("create", input("after-close")));
    expect(refused).toBeInstanceOf(DbWriterClosedError);
    expect(refused).toBeInstanceOf(DbWriteUnavailableError);
    await expect(held).resolves.toEqual({ id: "w-drain-held" });
    await expect(queued).resolves.toEqual({ id: "w-drain-queued" });
    await closing;
    expect(delivered).toEqual([
      "created:w-drain-held",
      "announced:w-drain-held",
      "created:w-drain-queued",
      "announced:w-drain-queued",
    ]);
    expect(exists("w-after-close")).toBe(false);
  });

  it("refuses a worker that loaded another build", async () => {
    const err = await rejection(
      DbWriter.open<TestEffect, TestWriteOperations>({
        dbPath: meshDbPath(home),
        worker: otherBuildWorkerPath,
        deliver: () => undefined,
      })
    );
    expect(err).toBeInstanceOf(DbWriteBuildMismatchError);
    expect(err.message).toMatch(
      /write worker runs build other-build, but this process runs \(none\); writes resume/
    );
  });
});
