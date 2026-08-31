import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  orphanedWorkspaces,
  removableWorkspaceNames,
  sweepOrphanedWorkspaces,
  unattributedCheckouts,
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
    expect(removableWorkspaceNames(RETIRED, REGISTRY)).toEqual([
      "worker-9f8e7d6c",
      "9f8e7d6c",
      RETIRED,
    ]);
  });

  it("names only the whole-id spelling when a live actor shares the prefix", () => {
    // Retiring an actor is the other half of the same collision the sweep
    // guards: the short spellings could be the live neighbour's workspace, and
    // this one is deleting while that neighbour is mid-run.
    const neighbour = "a1b2c3d4-9999-4222-8333-555566667777";
    expect(
      removableWorkspaceNames(neighbour, [...REGISTRY, { id: neighbour, retired: true }])
    ).toEqual([neighbour]);
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
    for (const name of removableWorkspaceNames(RETIRED, REGISTRY)) dir(scratchDir, name);

    expect(orphanedWorkspaces({ workersDir, scratchDir, actors: REGISTRY }).sort()).toEqual(
      removableWorkspaceNames(RETIRED, REGISTRY)
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

  it("reports a hand-named checkout the sweep will never claim", () => {
    // The four spellings that actually accumulated in the shared area: named by
    // hand, so they resolve to no actor, so the sweep leaves them holding a
    // clone forever. Reporting is the whole remedy — they stay on disk.
    for (const name of ["hotfix", "ticket-1283", "pr1587", "staging-clone"]) {
      dir(scratchDir, name, ".git");
    }
    // A directory without a repository in it is not this report's business.
    dir(scratchDir, "node_modules");
    // `.git` is a file in a worktree, and that is still a checkout.
    dir(scratchDir, "detached-worktree");
    writeFileSync(join(scratchDir, "detached-worktree", ".git"), "gitdir: /elsewhere");

    const strays = unattributedCheckouts({ workersDir, scratchDir, actors: REGISTRY });

    expect(strays.map((path) => basename(path)).sort()).toEqual([
      "detached-worktree",
      "hotfix",
      "pr1587",
      "staging-clone",
      "ticket-1283",
    ]);
    for (const name of ["hotfix", "ticket-1283", "pr1587", "staging-clone"]) {
      expect(existsSync(join(scratchDir, name))).toBe(true);
    }
  });

  it("leaves an actor's own checkout out of the stray report, live or retired", () => {
    // Both of these resolve to an actor, so they are already the sweep's
    // business — the live one is kept and the retired one is removed. Naming
    // either here would report a directory that is being handled correctly.
    dir(scratchDir, `worker-${LIVE.slice(0, 8)}`, ".git");
    dir(scratchDir, `worker-${RETIRED.slice(0, 8)}`, ".git");
    dir(scratchDir, RETIRED, ".git");

    expect(unattributedCheckouts({ workersDir, scratchDir, actors: REGISTRY })).toEqual([]);
  });

  it("reports a full-id checkout that names no actor even when a known actor shares its prefix", () => {
    // The twin of the sweep's own collision bug: this directory is spelled out
    // in full and matches no actor record, so the sweep will never remove it —
    // and if the report resolves it to just eight characters, a live actor
    // holding that prefix hides it from the report too. Swept by neither and
    // named by neither is exactly how a checkout sits there unnoticed.
    const unknownSharingLivePrefix = `${LIVE.slice(0, 8)}-9999-4222-8333-555566667777`;
    dir(scratchDir, unknownSharingLivePrefix, ".git");

    expect(unattributedCheckouts({ workersDir, scratchDir, actors: REGISTRY })).toEqual([
      join(scratchDir, unknownSharingLivePrefix),
    ]);
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

  it("keeps short prefix workspaces under scratchDir during collision but sweeps the exact full-ID folder", () => {
    // Under scratchDir, the short spelling is contested and must survive.
    // The exact full ID spelling is unambiguous and should be deleted.
    const retiredCollision = "a1b2c3d4-9999-4222-8333-555566667777";
    const actors = [
      { id: LIVE, retired: false }, // live actor prefix 'a1b2c3d4'
      { id: retiredCollision, retired: true }, // retired actor prefix 'a1b2c3d4'
    ];
    dir(scratchDir, "worker-a1b2c3d4");
    dir(scratchDir, "a1b2c3d4");
    dir(scratchDir, retiredCollision);

    const orphans = orphanedWorkspaces({ workersDir, scratchDir, actors });

    expect(orphans).toEqual([join(scratchDir, retiredCollision)]);
  });

  it("does not sweep short prefix spellings under workersDir even if they belong to a retired actor", () => {
    // workersDir only holds exact actor IDs (full UUIDs). Prefix spellings under
    // workersDir must not be swept, even if the registry says they correspond to a retired actor.
    dir(workersDir, "worker-9f8e7d6c");
    dir(workersDir, "9f8e7d6c");
    dir(workersDir, RETIRED);

    const orphans = orphanedWorkspaces({ workersDir, scratchDir, actors: REGISTRY });

    expect(orphans).toEqual([join(workersDir, RETIRED)]);
  });
});
