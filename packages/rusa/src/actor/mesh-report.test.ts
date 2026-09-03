import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runMigrations } from "../db/migrations/runner.js";
import { MeshEventRepository } from "../db/repositories/mesh-event-repository.js";
import { generateMeshReport } from "./mesh-report.js";
import type { ThreadRecord } from "./thread-registry.js";

describe("generateMeshReport", () => {
  let home: string;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "mesh-report-"));
    mkdirSync(join(home, "data"), { recursive: true });
  });

  afterEach(() => {
    rmSync(home, { recursive: true, force: true });
  });

  function seed(records: ThreadRecord[], record: (repo: MeshEventRepository) => void): void {
    writeFileSync(join(home, "threads.json"), JSON.stringify({ threads: records }, null, 2));
    const db = new Database(join(home, "data", "mesh.db"));
    runMigrations(db);
    record(new MeshEventRepository(db));
    db.close();
  }

  it("renders topology and a timeline from the registry + event log", () => {
    const records: ThreadRecord[] = [
      {
        id: "root",
        charter: "Root Orchestrator: Coordinates worker subagents",
        parentId: null,
        status: "active",
        createdAt: "t0",
      },
      {
        id: "worker-abcdef12",
        charter: "implement the feature",
        parentId: "root",
        provider: "claude",
        status: "active",
        createdAt: "t1",
      },
    ];
    seed(records, (repo) => {
      repo.record({
        kind: "actor_spawned",
        actorId: "worker-abcdef12",
        detail: "implement the feature",
        payload: JSON.stringify({ parentId: "root" }),
      });
      repo.record({
        kind: "run_queued",
        actorId: "worker-abcdef12",
        detail: "spawned — begin your charter",
      });
      repo.record({
        kind: "message_sent",
        actorId: "root",
        body: "done, PR opened",
        payload: JSON.stringify({ to: "worker-abcdef12" }),
      });
      repo.record({
        kind: "run_end",
        actorId: "worker-abcdef12",
        success: true,
        body: "all green",
      });
      repo.record({
        kind: "root_control_action",
        actorId: "root",
        detail: "human:operator spawn_child",
        payload: JSON.stringify({
          principal: "human:operator",
          action: "spawn_child",
          targetId: "worker-abcdef12",
        }),
      });
    });

    const { outPath, counts } = generateMeshReport({ home });
    expect(counts).toEqual({ actors: 2, events: 5, messages: 1, runs: 1 });

    const html = readFileSync(outPath, "utf8");
    expect(html).toContain("root-actor");
    expect(html).toContain("Root Orchestrator: Coordinates worker subagents");
    expect(html).toContain("implement the feature");
    // The worker's id is short-labeled and wired as a filterable actor link.
    expect(html).toContain('data-actor="worker-abcdef12"');
    // Message body and run output are present as panels.
    expect(html).toContain("done, PR opened");
    expect(html).toContain("all green");
    expect(html).toContain("root control");
    expect(html).toContain("human:operator spawn_child");
    // Cards carry the actor keys for client-side zoom filtering.
    expect(html).toContain('data-actors="root worker-abcdef12"');
  });

  it("handles a home with no events yet", () => {
    seed(
      [{ id: "root", charter: "root", parentId: null, status: "active", createdAt: "t0" }],
      () => {}
    );
    const { counts } = generateMeshReport({ home });
    expect(counts).toEqual({ actors: 1, events: 0, messages: 0, runs: 0 });
    const html = readFileSync(join(home, "mesh-report.html"), "utf8");
    expect(html).toContain("No mesh events recorded yet.");
  });

  it("throws a clear error when no DB exists", () => {
    expect(() => generateMeshReport({ home: join(home, "nonexistent") })).toThrow(/No rusa DB/);
  });
});
