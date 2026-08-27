import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Goal, SyncClient } from "@thkp-eng/goals-core";
import type {
  ArchiveStatusLogEntry,
  ClearStatusLogEntry,
  GoalLogEntry,
  StatusLogEntry,
} from "@thkp-eng/goals-types";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  getEffectiveGoalStatus,
  getNodeContents,
  isArchivedGoal,
  isVisibleNode,
  listChildren,
  viewNode,
} from "./graph-store.js";
import {
  formatFrontmatter,
  formatNodeFilename,
  renderUnderstandingSnapshot,
  sanitizeNodeSlug,
} from "./snapshot.js";

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

describe("snapshot renderer", () => {
  describe("sanitizeNodeSlug", () => {
    it("lowercases and replaces punctuation/spaces with single hyphens", () => {
      expect(sanitizeNodeSlug("Project & Architecture!")).toBe("project-architecture");
      expect(sanitizeNodeSlug("System Architecture / Design")).toBe("system-architecture-design");
      expect(sanitizeNodeSlug("---leading and trailing---")).toBe("leading-and-trailing");
      expect(sanitizeNodeSlug("Multiple   Spaces   Here")).toBe("multiple-spaces-here");
    });

    it("falls back to 'untitled' when title contains no alphanumeric characters", () => {
      expect(sanitizeNodeSlug("!@#$%^&*()")).toBe("untitled");
      expect(sanitizeNodeSlug("   ---   ")).toBe("untitled");
      expect(sanitizeNodeSlug("")).toBe("untitled");
    });
  });

  describe("formatNodeFilename", () => {
    it("combines sanitized slug and exact 6-char case-preserving Cupid prefix", () => {
      const cupidId = "ggDxZ25mXUUIAAAAAAAAAA";
      expect(formatNodeFilename("System Architecture", cupidId)).toBe(
        "system-architecture--ggDxZ2.md"
      );
      expect(formatNodeFilename("Mixed Case Title", "bQCcpgLB00VgAAAAAAAAAA")).toBe(
        "mixed-case-title--bQCcpg.md"
      );
    });
  });

  describe("renderNodeDocument & frontmatter formatting", () => {
    it("formats deterministic YAML frontmatter and preserves body byte-for-byte", () => {
      const meta = {
        id: "ggDxZ25mXUUIAAAAAAAAAA",
        title: "System Architecture",
        parent_ids: ["parent1", "parent2"],
        child_ids: ["child1"],
      };
      const frontmatter = formatFrontmatter(meta);
      expect(frontmatter).toBe(
        `---\nid: ggDxZ25mXUUIAAAAAAAAAA\ntitle: "System Architecture"\nparent_ids:\n  - parent1\n  - parent2\nchild_ids:\n  - child1\n---\n`
      );

      const emptyMeta = {
        id: "ggDxZ25mXUUIAAAAAAAAAA",
        title: "Root Node",
        parent_ids: [],
        child_ids: [],
      };
      expect(formatFrontmatter(emptyMeta)).toBe(
        `---\nid: ggDxZ25mXUUIAAAAAAAAAA\ntitle: "Root Node"\nparent_ids: []\nchild_ids: []\n---\n`
      );
    });
  });

  describe("renderUnderstandingSnapshot", () => {
    let tmpDir: string;

    beforeEach(() => {
      tmpDir = mkdtempSync(join(tmpdir(), "rusa-snapshot-test-"));
    });

    afterEach(() => {
      if (existsSync(tmpDir)) {
        rmSync(tmpDir, { recursive: true, force: true });
      }
    });

    it("renders visible nodes, excludes root and archived nodes, and guarantees body byte-parity", async () => {
      const rootId = "rootNode1234567890";
      const node1Id = "ggDxZ25mXUUIAAAAAAAAAA";
      const node2Id = "bQCcpgLB00VgAAAAAAAAAA";
      const archivedId = "8gAfBEByikj1AAAAAAAAAA";
      const unreachableId = "unreachable123456789";

      const rootGoal = makeGoal(rootId, "IU Root", { children: [node1Id, node2Id, archivedId] });
      const goal1 = makeGoal(node1Id, "Architecture Principles", {
        parents: [rootId],
        children: [node2Id],
        contents: "## Principles\n- Principle 1\n- Principle 2",
      });
      const goal2 = makeGoal(node2Id, "Operational Guidelines", {
        parents: [rootId, node1Id],
        contents: "## Guidelines\nAlways follow instructions.",
      });
      const archivedGoal = makeGoal(archivedId, "Deprecated Concept", {
        parents: [rootId],
        contents: "This concept is archived.",
        archived: true,
      });
      const unreachableGoal = makeGoal(unreachableId, "Unreachable Floating Node", {
        contents: "Not reachable from root",
      });

      const { sync } = fake([rootGoal, goal1, goal2, archivedGoal, unreachableGoal]);

      const result = await renderUnderstandingSnapshot(sync, tmpDir, rootId);
      expect(result.fileCount).toBe(2);
      expect(result.nodeIds.sort()).toEqual([node1Id, node2Id].sort());

      const files = readdirSync(tmpDir);
      expect(files.length).toBe(2);

      const filename1 = formatNodeFilename("Architecture Principles", node1Id);
      const filename2 = formatNodeFilename("Operational Guidelines", node2Id);
      expect(files).toContain(filename1);
      expect(files).toContain(filename2);

      // Verify byte parity: stripping frontmatter matches getNodeContents exactly
      const file1Raw = readFileSync(join(tmpDir, filename1), "utf-8");
      const match1 = file1Raw.match(/^---\nid: [\s\S]*?\n---\n([\s\S]*)$/);
      expect(match1).not.toBeNull();
      expect(match1?.[1]).toBe(getNodeContents(goal1));
      expect(match1?.[1]).toBe("## Principles\n- Principle 1\n- Principle 2");

      // Verify parent/child relationship IDs in frontmatter
      expect(file1Raw).toContain(`child_ids:\n  - ${node2Id}`);
      const file2Raw = readFileSync(join(tmpDir, filename2), "utf-8");
      expect(file2Raw).toContain(`parent_ids:\n  - ${node1Id}`);

      // Verify archived node was excluded from files
      const archivedFilename = formatNodeFilename("Deprecated Concept", archivedId);
      expect(files).not.toContain(archivedFilename);

      // Verify root was excluded from files
      const rootFilename = formatNodeFilename("IU Root", rootId);
      expect(files).not.toContain(rootFilename);
    });

    it("detects and throws on whole-filename collision across visible nodes", async () => {
      const rootId = "rootNode1234567890";
      const fixedPrefix = "aaaaaa";
      const id1 = `${fixedPrefix}1111111111111111`;
      const id2 = `${fixedPrefix}2222222222222222`;

      const rootGoal = makeGoal(rootId, "Root", { children: [id1, id2] });
      const goal1 = makeGoal(id1, "Duplicate Concept", { parents: [rootId] });
      const goal2 = makeGoal(id2, "Duplicate Concept", { parents: [rootId] });

      const { sync } = fake([rootGoal, goal1, goal2]);

      await expect(renderUnderstandingSnapshot(sync, tmpDir, rootId)).rejects.toThrow(
        /Collision detected for rendered filename "duplicate-concept--aaaaaa.md"/
      );
    });
  });

  describe("unified visibility predicate for archived nodes in graph-store", () => {
    it("excludes archived nodes from isVisibleNode, viewNode, and listChildren", () => {
      const rootId = "rootNode1234567890";
      const parentId = "parentHubNode12345678";
      const child1Id = "activeChildNode123456";
      const child2Id = "archivedChildNode1234";

      const rootGoal = makeGoal(rootId, "Root", { children: [parentId] });
      const parentGoal = makeGoal(parentId, "Parent Hub", {
        parents: [rootId],
        children: [child1Id, child2Id],
        contents: "Hub node contents",
      });
      const child1Goal = makeGoal(child1Id, "Active Child", {
        parents: [parentId],
        contents: "Active child contents",
      });
      const child2Goal = makeGoal(child2Id, "Archived Child", {
        parents: [parentId],
        contents: "Archived child contents",
        archived: true,
      });

      const { sync, fakeSync } = fake([rootGoal, parentGoal, child1Goal, child2Goal]);

      expect(isArchivedGoal(child2Goal)).toBe(true);
      expect(isArchivedGoal(child1Goal)).toBe(false);

      const goals = fakeSync.getGoals();
      expect(isVisibleNode(goals, child2Id, null, rootId)).toBe(false);
      expect(isVisibleNode(goals, child1Id, null, rootId)).toBe(true);

      // viewNode on archived node returns null
      expect(viewNode(sync, child2Id, rootId)).toBeNull();

      // viewNode on parent excludes archived child from children list
      const parentView = viewNode(sync, parentId, rootId);
      expect(parentView).not.toBeNull();
      expect(parentView?.children.map((c) => c.id)).toEqual([child1Id]);

      // listChildren excludes archived child
      const children = listChildren(sync, parentId, rootId);
      expect(children).not.toBeNull();
      expect(children?.map((c) => c.id)).toEqual([child1Id]);
    });

    it("respects clearStatus, archiveStatus tombstones, and time windows in effective status", () => {
      const now = 100000;

      // Case 1: Newer clearStatus overrides older status: "ar"
      const goalWithClear = makeGoal("clearedGoal", "Goal with clearStatus");
      goalWithClear.log.push({
        id: "status-1",
        creationTime: 10,
        type: "status",
        status: "ar",
      } as StatusLogEntry);
      goalWithClear.log.unshift({
        id: "clear-1",
        creationTime: 20,
        type: "clearStatus",
      } as ClearStatusLogEntry);
      expect(getEffectiveGoalStatus(goalWithClear, now)).toBeNull();
      expect(isArchivedGoal(goalWithClear, now)).toBe(false);

      // Case 2: archiveStatus tombstones an entry
      const goalWithTombstone = makeGoal("tombstoneGoal", "Goal with tombstoned status");
      goalWithTombstone.log.push({
        id: "status-tombstoned",
        creationTime: 10,
        type: "status",
        status: "ar",
      } as StatusLogEntry);
      goalWithTombstone.log.unshift({
        id: "status-tombstoned",
        creationTime: 20,
        type: "archiveStatus",
      } as ArchiveStatusLogEntry);
      expect(getEffectiveGoalStatus(goalWithTombstone, now)).toBeNull();
      expect(isArchivedGoal(goalWithTombstone, now)).toBe(false);

      // Case 3: Future startTime is not active yet
      const futureGoal = makeGoal("futureGoal", "Goal with future archive status");
      futureGoal.log.push({
        id: "status-future",
        creationTime: 10,
        type: "status",
        status: "ar",
        startTime: now + 50000,
      } as StatusLogEntry);
      expect(isArchivedGoal(futureGoal, now)).toBe(false);

      // Case 4: Past endTime is expired
      const expiredGoal = makeGoal("expiredGoal", "Goal with expired archive status");
      expiredGoal.log.push({
        id: "status-expired",
        creationTime: 10,
        type: "status",
        status: "ar",
        endTime: now - 5000,
      } as StatusLogEntry);
      expect(isArchivedGoal(expiredGoal, now)).toBe(false);

      // Case 5: Path-scoped (instance-specific) status does not archive canonical goal
      const pathScopedGoal = makeGoal("pathScopedGoal", "Goal with instance-specific status");
      pathScopedGoal.log.push({
        id: "status-path-scoped",
        creationTime: 10,
        type: "status",
        status: "ar",
        path: ["parentInstance", "childInstance"],
      } as StatusLogEntry);
      expect(getEffectiveGoalStatus(pathScopedGoal, now)).toBeNull();
      expect(isArchivedGoal(pathScopedGoal, now)).toBe(false);

      // Case 6: Path-scoped clearStatus does not clear canonical archive status
      const canonicalArchiveGoal = makeGoal(
        "canonicalArchiveGoal",
        "Archived goal with instance clear"
      );
      canonicalArchiveGoal.log.push({
        id: "status-canonical",
        creationTime: 10,
        type: "status",
        status: "ar",
      } as StatusLogEntry);
      canonicalArchiveGoal.log.unshift({
        id: "clear-path-scoped",
        creationTime: 20,
        type: "clearStatus",
        path: ["parentInstance", "childInstance"],
      } as ClearStatusLogEntry);
      expect(getEffectiveGoalStatus(canonicalArchiveGoal, now)?.status).toBe("ar");
      expect(isArchivedGoal(canonicalArchiveGoal, now)).toBe(true);
    });

    it("fails closed when a configured rootNodeId is missing or stale", async () => {
      const staleRootId = "staleRootNodeDoesNotExist";
      const goal1 = makeGoal("node1", "Node 1", { contents: "Contents 1" });
      const goal2 = makeGoal("node2", "Node 2", { contents: "Contents 2" });

      const { sync } = fake([goal1, goal2]);

      // viewNode on any node with a stale root returns null (fails closed)
      expect(viewNode(sync, "node1", staleRootId)).toBeNull();
      expect(viewNode(sync, "node2", staleRootId)).toBeNull();

      // listChildren with undefined parentId falls back to top-level roots
      expect(
        listChildren(sync, undefined, staleRootId)
          ?.map((c) => c.id)
          .sort()
      ).toEqual(["node1", "node2"]);
      // listChildren with specific parentId fails closed (returns null)
      expect(listChildren(sync, "node1", staleRootId)).toBeNull();

      // renderUnderstandingSnapshot with stale root renders 0 files
      const snapshotDir = mkdtempSync(join(tmpdir(), "rusa-stale-root-test-"));
      try {
        const result = await renderUnderstandingSnapshot(sync, snapshotDir, staleRootId);
        expect(result.fileCount).toBe(0);
        expect(result.nodeIds).toEqual([]);
        expect(readdirSync(snapshotDir)).toEqual([]);
      } finally {
        rmSync(snapshotDir, { recursive: true, force: true });
      }
    });
  });
});
