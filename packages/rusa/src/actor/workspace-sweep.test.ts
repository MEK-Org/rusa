import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  actorWorkspaceNames,
  orphanedWorkspaces,
  sweepOrphanedWorkspaces,
} from "./workspace-sweep.js";

const LIVE = "a1b2c3d4-1111-4222-8333-555566667777";
const RETIRED = "9f8e7d6c-1111-4222-8333-555566667777";
const REGISTRY = [
  { id: LIVE, retired: false },
  { id: RETIRED, retired: true },
];

describe("workspace sweep", () => {
  let workersDir = "";
  let scratchDir = "";

  beforeEach(() => {
    workersDir = mkdtempSync(join(tmpdir(), "rusa-workers-"));
    scratchDir = mkdtempSync(join(tmpdir(), "rusa-scratch-"));
  });

  afterEach(() => {
    rmSync(workersDir, { recursive: true, force: true });
    rmSync(scratchDir, { recursive: true, force: true });
  });

  const dir = (...parts: string[]) => {
    const path = join(...parts);
    mkdirSync(path, { recursive: true });
    return path;
  };

  it("names every spelling the provider has used for one actor's workspace", () => {
    expect(actorWorkspaceNames(LIVE)).toEqual(["worker-a1b2c3d4", "a1b2c3d4", LIVE]);
  });

  it("removes both of a retired actor's workspaces and keeps a live actor's", () => {
    dir(workersDir, RETIRED);
    dir(scratchDir, "worker-9f8e7d6c");
    dir(workersDir, LIVE);
    dir(scratchDir, "worker-a1b2c3d4");

    const removed = sweepOrphanedWorkspaces({ workersDir, scratchDir, actors: REGISTRY });

    expect(removed.sort()).toEqual(
      [join(workersDir, RETIRED), join(scratchDir, "worker-9f8e7d6c")].sort()
    );
    expect(existsSync(join(workersDir, RETIRED))).toBe(false);
    expect(existsSync(join(scratchDir, "worker-9f8e7d6c"))).toBe(false);
    expect(existsSync(join(workersDir, LIVE))).toBe(true);
    expect(existsSync(join(scratchDir, "worker-a1b2c3d4"))).toBe(true);
  });

  it("claims all three spellings of a retired actor's workspace", () => {
    // All three are on disk in the same provider area: `worker-<prefix>` is what
    // it writes now, and the bare prefix and the whole actor id are older.
    for (const name of actorWorkspaceNames(RETIRED)) dir(scratchDir, name);

    expect(orphanedWorkspaces({ workersDir, scratchDir, actors: REGISTRY }).sort()).toEqual(
      actorWorkspaceNames(RETIRED)
        .map((name) => join(scratchDir, name))
        .sort()
    );
  });

  it("keeps a scratch workspace whose short prefix collides with a live actor", () => {
    // A retired actor whose id happens to share its leading eight characters
    // with a live one. Eight hex is short, and the safe side of a collision is
    // the one that cannot destroy work in progress.
    dir(scratchDir, "worker-a1b2c3d4");
    const collision = [...REGISTRY, { id: `a1b2c3d4-9999-4222-8333-555566667777`, retired: true }];

    expect(orphanedWorkspaces({ workersDir, scratchDir, actors: collision })).toEqual([]);
  });

  it("leaves a directory that names no actor alone, however it is spelled", () => {
    // The provider's area is shared with material rusa did not put there, and a
    // name in the right shape is not enough — `deadbeef` belongs to no actor.
    for (const name of ["node_modules", "some-project", "worker-notahexid", "deadbeef"]) {
      dir(scratchDir, name);
    }
    writeFileSync(join(scratchDir, "render.mov"), "not a workspace");
    // `root` and the provider probes share the workers directory and never retire.
    for (const name of ["root", "quota-probe-kimi", "model-probe-claude"]) dir(workersDir, name);

    const removed = sweepOrphanedWorkspaces({ workersDir, scratchDir, actors: REGISTRY });

    expect(removed).toEqual([]);
    for (const name of ["node_modules", "some-project", "worker-notahexid", "deadbeef"]) {
      expect(existsSync(join(scratchDir, name))).toBe(true);
    }
    expect(existsSync(join(scratchDir, "render.mov"))).toBe(true);
    for (const name of ["root", "quota-probe-kimi", "model-probe-claude"]) {
      expect(existsSync(join(workersDir, name))).toBe(true);
    }
  });

  it("sweeps nothing when the registry is unreadable, rather than everything", () => {
    // An empty actor list is the shape a failed registry read takes. Requiring a
    // retired record to match means that state removes nothing on its own.
    dir(workersDir, RETIRED);
    dir(scratchDir, "worker-9f8e7d6c");

    expect(orphanedWorkspaces({ workersDir, scratchDir, actors: [] })).toEqual([]);
    expect(sweepOrphanedWorkspaces({ workersDir, scratchDir, actors: [] })).toEqual([]);
    expect(existsSync(join(workersDir, RETIRED))).toBe(true);
    expect(existsSync(join(scratchDir, "worker-9f8e7d6c"))).toBe(true);
  });

  it("reports a missing area as nothing to do", () => {
    expect(
      orphanedWorkspaces({
        workersDir: join(workersDir, "absent"),
        scratchDir: join(scratchDir, "absent"),
        actors: REGISTRY,
      })
    ).toEqual([]);
  });
});
