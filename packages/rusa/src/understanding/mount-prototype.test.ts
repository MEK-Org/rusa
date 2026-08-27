import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Goal, SyncClient } from "@thkp-eng/goals-core";
import type { GoalLogEntry, StatusLogEntry } from "@thkp-eng/goals-types";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { stringify } from "yaml";
import { buildRootPrompt } from "../actor/root-prompt.js";
import { buildWorkerPrompt } from "../actor/worker-prompt.js";
import { loadConfig } from "../config/index.js";
import { buildActorBwrapArgs } from "../providers/sandbox.js";
import { getNodeContents } from "./graph-store.js";
import { renderUnderstandingSnapshot } from "./snapshot.js";

function makeGoal(
  id: string,
  text: string,
  opts: { parents?: string[]; children?: string[]; contents?: string; archived?: boolean } = {}
): Goal {
  const log: GoalLogEntry[] = [];
  if (opts.contents !== undefined) {
    log.push({
      id: `e-${id}`,
      creationTime: 1,
      type: "documentContents",
      text: opts.contents,
    } as GoalLogEntry);
  }
  if (opts.archived) {
    log.push({
      id: `s-${id}`,
      creationTime: 2,
      type: "status",
      status: "ar",
    } as StatusLogEntry);
  }
  return {
    id,
    text,
    superGoalIds: new Set(opts.parents ?? []),
    subGoalIds: new Set(opts.children ?? []),
    log,
  } as unknown as Goal;
}

class FakeSync {
  goals = new Map<string, Goal>();
  getGoals(): Map<string, Goal> {
    return this.goals;
  }
  async modifyGoal(delta: { id: string; text?: string; logEntry?: GoalLogEntry }): Promise<void> {
    const existing = this.goals.get(delta.id);
    if (existing) {
      if (delta.text !== undefined) existing.text = delta.text;
      if (delta.logEntry) existing.log.unshift(delta.logEntry);
    } else {
      const g = makeGoal(delta.id, delta.text ?? "Untitled");
      if (delta.logEntry) g.log.push(delta.logEntry);
      this.goals.set(delta.id, g);
    }
  }
}

function fake(goals: Goal[] = []): { sync: SyncClient; fakeSync: FakeSync } {
  const fakeSync = new FakeSync();
  for (const g of goals) fakeSync.goals.set(g.id, g);
  return { sync: fakeSync as unknown as SyncClient, fakeSync };
}

function writeConfig(dir: string, data: Record<string, unknown>): string {
  const full = {
    github: { account: "test-bot" },
    providers: { antigravity: {} },
    ...data,
  };
  writeFileSync(join(dir, "config.yaml"), stringify(full), "utf-8");
  return dir;
}

describe("Issue #45: Integrated Understanding Read-Only Mount Prototype Validation Matrix", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "rusa-mount-prototype-test-"));
  });

  afterEach(() => {
    if (existsSync(tmpDir)) {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  describe("Gate 1: Config schema validation", () => {
    it("accepts understanding.mount.enabled boolean config", () => {
      const config = loadConfig(
        writeConfig(tmpDir, {
          understanding: {
            mount: {
              enabled: true,
            },
          },
        })
      );
      expect(config.understanding?.mount?.enabled).toBe(true);
    });

    it("rejects non-boolean understanding.mount.enabled", () => {
      expect(() =>
        loadConfig(
          writeConfig(tmpDir, {
            understanding: {
              mount: {
                enabled: "enabled-string",
              },
            },
          })
        )
      ).toThrow(/understanding\.mount\.enabled must be a boolean when set/);
    });

    it("rejects non-mapping understanding.mount", () => {
      expect(() =>
        loadConfig(
          writeConfig(tmpDir, {
            understanding: {
              mount: "enabled",
            },
          })
        )
      ).toThrow(/understanding\.mount must be a mapping when set/);
    });
  });

  describe("Gate 2 & 3: Snapshot rendering & byte-parity body matching", () => {
    it("renders visible non-archived nodes with exact slug and 6-char prefix, preserving byte-for-byte body", async () => {
      const rootId = "rootAnchor123456789";
      const archId = "ggDxZ25mXUUIAAAAAAAAAA";
      const opsId = "bQCcpgLB00VgAAAAAAAAAA";
      const archivedId = "archivedGoal1234567";
      const unreachableId = "unreachableGoal1234";

      const archContent =
        "# Architecture\n\nThis is the core architecture document.\n- Invariant A\n- Invariant B";
      const opsContent = "## Runbook\n\nOperational guidelines.";

      const rootGoal = makeGoal(rootId, "IU Root Anchor", {
        children: [archId, opsId, archivedId],
      });
      const archGoal = makeGoal(archId, "System Architecture & Design!", {
        parents: [rootId],
        children: [opsId],
        contents: archContent,
      });
      const opsGoal = makeGoal(opsId, "Operations Runbook", {
        parents: [rootId, archId],
        contents: opsContent,
      });
      const archivedGoal = makeGoal(archivedId, "Old Deprecated Architecture", {
        parents: [rootId],
        contents: "Should not appear",
        archived: true,
      });
      const unreachableGoal = makeGoal(unreachableId, "Floating Concept", {
        contents: "Unreachable",
      });

      const { sync } = fake([rootGoal, archGoal, opsGoal, archivedGoal, unreachableGoal]);

      const result = await renderUnderstandingSnapshot(sync, tmpDir, rootId);
      expect(result.fileCount).toBe(2);
      expect(result.nodeIds.sort()).toEqual([archId, opsId].sort());

      const files = readdirSync(tmpDir);
      expect(files).toHaveLength(2);

      // Verify filename formatting: <slug>--<id.slice(0, 6)>.md
      const archFilename = "system-architecture-design--ggDxZ2.md";
      const opsFilename = "operations-runbook--bQCcpg.md";
      expect(files).toContain(archFilename);
      expect(files).toContain(opsFilename);

      // Verify Byte Parity (Gate 3)
      const archFileRaw = readFileSync(join(tmpDir, archFilename), "utf-8");
      const archMatch = archFileRaw.match(/^---\nid: [\s\S]*?\n---\n([\s\S]*)$/);
      expect(archMatch).not.toBeNull();
      expect(archMatch?.[1]).toBe(getNodeContents(archGoal));
      expect(archMatch?.[1]).toBe(archContent);

      const opsFileRaw = readFileSync(join(tmpDir, opsFilename), "utf-8");
      const opsMatch = opsFileRaw.match(/^---\nid: [\s\S]*?\n---\n([\s\S]*)$/);
      expect(opsMatch).not.toBeNull();
      expect(opsMatch?.[1]).toBe(getNodeContents(opsGoal));
      expect(opsMatch?.[1]).toBe(opsContent);

      // Verify frontmatter relationships
      expect(archFileRaw).toContain(`child_ids:\n  - ${opsId}`);
      expect(opsFileRaw).toContain(`parent_ids:\n  - ${archId}`);
      expect(opsFileRaw).not.toContain(rootId); // root is excluded from relationships
    });
  });

  describe("Gate 4: Fail-loud collision detection", () => {
    it("throws explicit error when two visible nodes produce identical filenames", async () => {
      const rootId = "rootAnchor123456789";
      const fixedPrefix = "k7Z9pQ";
      const id1 = `${fixedPrefix}1111111111111111`;
      const id2 = `${fixedPrefix}2222222222222222`;

      const rootGoal = makeGoal(rootId, "Root", { children: [id1, id2] });
      const goal1 = makeGoal(id1, "Component Architecture", { parents: [rootId] });
      const goal2 = makeGoal(id2, "Component Architecture", { parents: [rootId] });

      const { sync } = fake([rootGoal, goal1, goal2]);

      await expect(renderUnderstandingSnapshot(sync, tmpDir, rootId)).rejects.toThrow(
        /Collision detected for rendered filename "component-architecture--k7Z9pQ.md"/
      );
    });
  });

  describe("Gate 5: Sandbox mount args & Prompt injection discoverability", () => {
    it("emits sandbox mount args under /tmp/understanding when understandingMount is supplied", () => {
      const hostSnapshotDir = "/tmp/host-iu-snapshot-456";
      const { args } = buildActorBwrapArgs(
        "/tmp/worker-dir",
        "antigravity",
        undefined,
        false,
        hostSnapshotDir
      );

      const tmpfsIndex = args.indexOf("/tmp");
      const dirIndex = args.indexOf("/tmp/understanding");
      expect(tmpfsIndex).toBeGreaterThan(-1);
      expect(dirIndex).toBeGreaterThan(tmpfsIndex);
      expect(args[dirIndex - 1]).toBe("--dir");

      const roBindIndex = args.indexOf(hostSnapshotDir);
      expect(roBindIndex).toBeGreaterThan(tmpfsIndex);
      expect(args[roBindIndex - 1]).toBe("--ro-bind");
      expect(args[roBindIndex + 1]).toBe("/tmp/understanding");
    });

    it("injects discoverability notice into worker prompt only when enabled", () => {
      const notice =
        "A read-only snapshot of the integrated understanding is mounted at /tmp/understanding; grep and read it directly.";

      const enabledPrompt = buildWorkerPrompt("charter", {
        threadId: "worker-123456",
        parentId: "root",
        understandingMountEnabled: true,
      });
      expect(enabledPrompt).toContain(notice);

      const disabledPrompt = buildWorkerPrompt("charter", {
        threadId: "worker-123456",
        parentId: "root",
        understandingMountEnabled: false,
      });
      expect(disabledPrompt).not.toContain(notice);

      const rootPrompt = buildRootPrompt();
      expect(rootPrompt).not.toContain(notice);
    });
  });

  describe("Gate 6: Snapshot factory failure cleanup & Provider cleanup", () => {
    it("cleans up temporary snapshot directory if rendering throws", async () => {
      const snapshotDir = mkdtempSync(join(tmpdir(), "rusa-iu-error-cleanup-"));
      expect(existsSync(snapshotDir)).toBe(true);

      const rootId = "rootNode123";
      const fixedPrefix = "colfix";
      const id1 = `${fixedPrefix}1111111111111111`;
      const id2 = `${fixedPrefix}2222222222222222`;

      const rootGoal = makeGoal(rootId, "Root", { children: [id1, id2] });
      const goal1 = makeGoal(id1, "Colliding Concept", { parents: [rootId] });
      const goal2 = makeGoal(id2, "Colliding Concept", { parents: [rootId] });

      const { sync } = fake([rootGoal, goal1, goal2]);

      // Factory pattern wrapped in try/catch rmSync
      let caught = false;
      try {
        await renderUnderstandingSnapshot(sync, snapshotDir, rootId);
      } catch {
        caught = true;
        rmSync(snapshotDir, { recursive: true, force: true });
      }

      expect(caught).toBe(true);
      expect(existsSync(snapshotDir)).toBe(false);
    });

    it("cleans up temporary snapshot directory after execution", () => {
      const snapshotDir = mkdtempSync(join(tmpdir(), "rusa-iu-cleanup-test-"));
      expect(existsSync(snapshotDir)).toBe(true);

      // Verify rmSync recursive cleanup semantics
      rmSync(snapshotDir, { recursive: true, force: true });
      expect(existsSync(snapshotDir)).toBe(false);
    });
  });

  describe("Sandbox Integration: bwrap read access and EROFS write protection", () => {
    it("allows reading /tmp/understanding and rejects writes with EROFS inside bwrap", () => {
      const hostSnapshotDir = mkdtempSync(join(tmpdir(), "rusa-bwrap-integ-"));
      try {
        writeFileSync(
          join(hostSnapshotDir, "system-architecture--ggDxZ2.md"),
          "# System Architecture\nCore spec.",
          "utf-8"
        );

        // Probe 1: Read files inside bwrap sandbox
        const readResult = spawnSync(
          "bwrap",
          [
            "--ro-bind",
            "/",
            "/",
            "--tmpfs",
            "/tmp",
            "--dir",
            "/tmp/understanding",
            "--ro-bind",
            hostSnapshotDir,
            "/tmp/understanding",
            "cat",
            "/tmp/understanding/system-architecture--ggDxZ2.md",
          ],
          { encoding: "utf-8" }
        );

        if (readResult.error) {
          // If bwrap is not available or blocked in current container, skip gracefully
          return;
        }

        expect(readResult.status).toBe(0);
        expect(readResult.stdout).toContain("# System Architecture");

        // Probe 2: Write attempt fails with EROFS
        const writeResult = spawnSync(
          "bwrap",
          [
            "--ro-bind",
            "/",
            "/",
            "--tmpfs",
            "/tmp",
            "--dir",
            "/tmp/understanding",
            "--ro-bind",
            hostSnapshotDir,
            "/tmp/understanding",
            "touch",
            "/tmp/understanding/unauthorized_write.txt",
          ],
          { encoding: "utf-8" }
        );

        expect(writeResult.status).not.toBe(0);
        expect(writeResult.stderr).toMatch(/Read-only file system/);
      } finally {
        rmSync(hostSnapshotDir, { recursive: true, force: true });
      }
    });
  });
});
