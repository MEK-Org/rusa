import { type Goal, MemoryLocalStore, SyncClient } from "@thkp-eng/goals-core";
import type { AnyOp } from "@thkp-eng/goals-types";
import { afterEach, describe, expect, it } from "vitest";
import type { RusaConfig } from "../config/types";
import { buildSeedOps } from "./iu-seed.js";
import { resolveInitialBaseline } from "./persistence-utils.js";

/** Apply ops into a throwaway client so we can assert the resulting graph. */
async function graphFrom(ops: AnyOp[]): Promise<Map<string, Goal>> {
  const store = new MemoryLocalStore();
  await store.storeSyncedOps(ops);
  const client = new SyncClient(null, store);
  await client.init();
  return client.getGoals() as Map<string, Goal>;
}

const titlesOf = (goals: Map<string, Goal>) => [...goals.values()].map((g) => g.text);
const byTitle = (goals: Map<string, Goal>, title: string) =>
  [...goals.values()].find((g) => g.text === title);

describe("buildSeedOps", () => {
  it("seeds the universal bootstrap: root + Engineering Principles + Operating Conventions", async () => {
    const goals = await graphFrom(await buildSeedOps());

    expect(titlesOf(goals).sort()).toEqual([
      "Engineering Principles",
      "Integrated Knowledge Universe",
      "Operating Conventions",
    ]);

    // The root is the sole top-level node; the two universal nodes are its children.
    const root = byTitle(goals, "Integrated Knowledge Universe");
    expect(root).toBeDefined();
    expect([...(root?.superGoalIds ?? [])].filter((p) => goals.has(p))).toEqual([]); // no parent → root
    expect(root && [...root.subGoalIds].filter((c) => goals.has(c)).length).toBe(2);

    for (const child of ["Engineering Principles", "Operating Conventions"]) {
      const node = byTitle(goals, child);
      expect(node && [...node.superGoalIds]).toContain(root?.id);
    }
  });

  it("does NOT seed any rusa-specific node (universal-only)", async () => {
    const goals = await graphFrom(await buildSeedOps());
    // e.g. the MCP-not-CLI / Rusa Engineering Principles node is deliberately not seeded.
    expect(titlesOf(goals)).not.toContain("Rusa Engineering Principles");
  });

  it("uses a requested local-only root id", async () => {
    const goals = await graphFrom(await buildSeedOps("fixed-local-root"));

    expect(goals.get("fixed-local-root")?.text).toBe("Integrated Knowledge Universe");
    expect(goals.get("fixed-local-root")?.subGoalIds).toHaveLength(2);
  });
});

describe("resolveInitialBaseline", () => {
  const savedPw = process.env.GLASS_GOALS_PASSWORD;
  afterEach(() => {
    if (savedPw === undefined) delete process.env.GLASS_GOALS_PASSWORD;
    else process.env.GLASS_GOALS_PASSWORD = savedPw;
  });

  it("unconfigured (no glassGoals) → seeds a local-first baseline", async () => {
    const ops = await resolveInitialBaseline({} as RusaConfig);
    expect(ops).not.toBeNull();
    const goals = await graphFrom(ops as AnyOp[]);
    expect(titlesOf(goals)).toContain("Operating Conventions");
  });

  it("local-only root configuration seeds the baseline under that root", async () => {
    const ops = await resolveInitialBaseline({
      understanding: { rootNodeId: "e2e-local-root" },
    } as RusaConfig);
    const goals = await graphFrom(ops as AnyOp[]);

    expect(goals.get("e2e-local-root")?.text).toBe("Integrated Knowledge Universe");
  });

  it("configured but unreachable/no-password → null (keeps the fail-soft guard, does NOT seed)", async () => {
    delete process.env.GLASS_GOALS_PASSWORD; // configured, but no creds → pullRemoteBaseline returns null
    const ops = await resolveInitialBaseline({
      glassGoals: { username: "someone" },
    } as RusaConfig);
    expect(ops).toBeNull(); // fell through to pullRemoteBaseline → null; the seed branch was NOT taken
  });

  it("nested understanding.glassGoals configured but unreachable/no-password → null", async () => {
    delete process.env.GLASS_GOALS_PASSWORD;
    const ops = await resolveInitialBaseline({
      understanding: {
        glassGoals: { username: "someone" },
      },
    } as RusaConfig);
    expect(ops).toBeNull();
  });
});
