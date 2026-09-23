import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  COORDINATOR_HOME_ENV,
  POOL_CLIENT_UNITS,
  POOL_COORDINATOR_ALERT_UNIT,
  POOL_COORDINATOR_UNIT,
  planCoordinatorTransition,
  readInstalledCoordinatorUnits,
  resolveCoordinatorServiceContext,
  resolvePoolProbePath,
} from "./coordinator-provisioning.js";
import { resolveProbePathEnv } from "./service-instance.js";

/**
 * Unit-level cover for the provisioning decisions, where
 * `pool-coordinator-topology.test.ts` is #507's acceptance check and asserts on
 * the installed topology a transition leaves behind.
 *
 * The split is by what a test can show. An end-to-end topology assertion shows
 * what *happened*; the cases that earn their place here are the ones about what
 * must **not** happen and so leave no topology to look at — the refusals (two
 * disagreeing units, no home from any source, a foreign unit left alone) — plus
 * the resolution order between flag, env, and adoption, which a single seeded
 * host cannot exercise because it has one answer. The adoption cases the two
 * files share are deliberate: this one pins the decision, the other pins that
 * the decision reaches the host.
 */

let systemdUserDir: string;

beforeEach(() => {
  systemdUserDir = mkdtempSync(join(tmpdir(), "rusa-coordinator-units-"));
});

afterEach(() => {
  rmSync(systemdUserDir, { recursive: true, force: true });
});

function writeUnit(name: string, lines: string[]): void {
  writeFileSync(join(systemdUserDir, name), `${lines.join("\n")}\n`, "utf-8");
}

function coordinatorUnit(home: string): string[] {
  return ["[Service]", `Environment=RUSA_HOME=${home}`, "Environment=PATH=/usr/bin:/bin"];
}

describe("pool coordinator unit names", () => {
  it("are fixed, so a second environment cannot provision a second pool coordinator", () => {
    // Also exactly the name the old production derivation produced, so an
    // existing production install keeps its unit, its enablement, and its
    // database across #507 — only the staging-derived units are retired.
    expect(POOL_COORDINATOR_UNIT).toBe("rusa-quota-coordinator.service");
    expect(POOL_COORDINATOR_ALERT_UNIT).toBe("rusa-quota-coordinator-alert.service");
    expect(planCoordinatorTransition([POOL_COORDINATOR_UNIT]).removeUnits).toEqual([]);
  });
});

describe("readInstalledCoordinatorUnits", () => {
  it("reports each coordinator service with the home it runs against", () => {
    writeUnit(POOL_COORDINATOR_UNIT, coordinatorUnit("/home/u/.rusa"));
    writeUnit("rusa-staging-quota-coordinator.service", coordinatorUnit("/home/u/.rusa-staging"));
    writeUnit("rusa.service", ["[Service]", "Environment=RUSA_HOME=/home/u/.rusa"]);

    expect(
      readInstalledCoordinatorUnits(systemdUserDir, [
        POOL_COORDINATOR_UNIT,
        "rusa-staging-quota-coordinator.service",
        "rusa.service",
      ])
    ).toEqual([
      { unit: POOL_COORDINATOR_UNIT, home: "/home/u/.rusa" },
      { unit: "rusa-staging-quota-coordinator.service", home: "/home/u/.rusa-staging" },
    ]);
  });

  it("skips alert companions, which carry no home of their own to adopt", () => {
    writeUnit(POOL_COORDINATOR_ALERT_UNIT, ["[Service]", "Type=oneshot"]);
    writeUnit("rusa-staging-quota-coordinator-alert.service", ["[Service]", "Type=oneshot"]);

    expect(
      readInstalledCoordinatorUnits(systemdUserDir, [
        POOL_COORDINATOR_ALERT_UNIT,
        "rusa-staging-quota-coordinator-alert.service",
      ])
    ).toEqual([]);
  });

  it("does not read a home out of a unit this project never wrote", () => {
    // Same narrow set as the deletion path, for a quieter reason: an adopted
    // home flows into the config path, the workers dir, and the database the
    // service opens, so a stranger's unit must not be able to donate one.
    writeUnit("acme-quota-coordinator.service", coordinatorUnit("/opt/acme"));

    expect(
      readInstalledCoordinatorUnits(systemdUserDir, ["acme-quota-coordinator.service"])
    ).toEqual([]);
  });

  it("reports a home of null for a unit that has gone missing under it", () => {
    expect(readInstalledCoordinatorUnits(systemdUserDir, [POOL_COORDINATOR_UNIT])).toEqual([
      { unit: POOL_COORDINATOR_UNIT, home: null },
    ]);
  });
});

describe("resolveCoordinatorServiceContext", () => {
  it("takes --home over everything, and derives the whole context from it", () => {
    const context = resolveCoordinatorServiceContext({
      home: "/srv/quota-pool",
      envHome: "/ignored",
      installedUnits: [{ unit: POOL_COORDINATOR_UNIT, home: "/also-ignored" }],
    });

    expect(context).toEqual({
      home: "/srv/quota-pool",
      homeSource: "flag",
      serviceUnit: POOL_COORDINATOR_UNIT,
      alertUnit: POOL_COORDINATOR_ALERT_UNIT,
      configPath: "/srv/quota-pool/config.yaml",
      workersDir: "/srv/quota-pool/workers",
    });
  });

  it("falls back to the environment variable, the same statement made once per host", () => {
    const context = resolveCoordinatorServiceContext({ envHome: "/srv/quota-pool" });
    expect(context.home).toBe("/srv/quota-pool");
    expect(context.homeSource).toBe("env");
  });

  it("adopts the pool unit's home, which is what makes the transition a plain re-run", () => {
    const context = resolveCoordinatorServiceContext({
      installedUnits: [
        { unit: POOL_COORDINATOR_UNIT, home: "/home/u/.rusa" },
        { unit: "rusa-staging-quota-coordinator.service", home: "/home/u/.rusa-staging" },
      ],
    });

    // The pool unit is the one that survives, so its database is the one that
    // must keep being opened — the staging home is not a candidate.
    expect(context.home).toBe("/home/u/.rusa");
    expect(context.homeSource).toBe("adopted");
    expect(context.adoptedFrom).toBe(POOL_COORDINATOR_UNIT);
  });

  it("adopts a lone environment-derived unit, for a host that only ever installed staging", () => {
    const context = resolveCoordinatorServiceContext({
      installedUnits: [
        { unit: "rusa-staging-quota-coordinator.service", home: "/home/u/.rusa-staging" },
      ],
    });

    expect(context.home).toBe("/home/u/.rusa-staging");
    expect(context.adoptedFrom).toBe("rusa-staging-quota-coordinator.service");
  });

  // Reachable only through a caller that supplies its own candidates: the units
  // read off a host are the two known names, and the pool one wins when both are
  // there. Kept because silently picking one of two homes picks a database.
  it("refuses to guess between two disagreeing units, because that picks a database", () => {
    expect(() =>
      resolveCoordinatorServiceContext({
        installedUnits: [
          { unit: "rusa-blue-quota-coordinator.service", home: "/home/u/.rusa-blue" },
          { unit: "rusa-staging-quota-coordinator.service", home: "/home/u/.rusa-staging" },
        ],
      })
    ).toThrow(/Cannot tell which home[\s\S]*--home/);
  });

  it("says what to pass when there is nothing installed to adopt from", () => {
    expect(() => resolveCoordinatorServiceContext({})).toThrow(
      new RegExp(`no longer derived from an instance environment[\\s\\S]*${COORDINATOR_HOME_ENV}`)
    );
  });
});

describe("planCoordinatorTransition", () => {
  it("retires the environment-derived duplicates and their alert companions", () => {
    expect(
      planCoordinatorTransition([
        "rusa.service",
        "rusa-staging.service",
        POOL_COORDINATOR_UNIT,
        POOL_COORDINATOR_ALERT_UNIT,
        "rusa-staging-quota-coordinator.service",
        "rusa-staging-quota-coordinator-alert.service",
      ]).removeUnits
    ).toEqual([
      "rusa-staging-quota-coordinator-alert.service",
      "rusa-staging-quota-coordinator.service",
    ]);
  });

  it("is empty on a host that has already transitioned, so re-running is idempotent", () => {
    const transitioned = ["rusa.service", POOL_COORDINATOR_UNIT, POOL_COORDINATOR_ALERT_UNIT];
    expect(planCoordinatorTransition(transitioned).removeUnits).toEqual([]);
  });

  it("leaves units that merely mention a coordinator-ish name alone", () => {
    expect(
      planCoordinatorTransition(["rusa-quota-backup.service", "quota-coordinator-notes.txt"])
        .removeUnits
    ).toEqual([]);
  });

  it("removes only units this project could have written, never a stranger's", () => {
    // The plan is the input to deletion, and the directory it is built from is
    // the user's own `~/.config/systemd/user`, which holds every service they
    // have installed. A unit shaped like a coordinator but never written here
    // is not ours to stop, disable, or delete.
    expect(
      planCoordinatorTransition([
        "acme-quota-coordinator.service",
        "acme-quota-coordinator-alert.service",
        "rusa-blue-quota-coordinator.service",
        POOL_COORDINATOR_UNIT,
      ]).removeUnits
    ).toEqual([]);
  });
});

describe("resolvePoolProbePath", () => {
  /**
   * Resolve for real, faking only the `systemctl show` lookup, so what is under
   * test is the resolution order rather than a stub of it. Values are the PATH
   * as that lookup reports it, which is what the real reader returns.
   */
  function withSystemd(effective: Record<string, string>) {
    return (unit: string, contents: string | null) =>
      resolveProbePathEnv(unit, contents, (u) => effective[u] ?? null);
  }

  const noSystemd = withSystemd({});

  it("borrows the provider-capable PATH from the first client unit that has one", () => {
    writeUnit("rusa.service", ["[Service]", "Environment=PATH=/opt/providers/bin:/usr/bin"]);
    writeUnit("rusa-staging.service", ["[Service]", "Environment=PATH=/usr/bin"]);

    const borrowed = resolvePoolProbePath(systemdUserDir, POOL_CLIENT_UNITS, noSystemd);
    expect(borrowed.donorUnit).toBe("rusa.service");
    expect(borrowed.probePath).toEqual({
      path: "/opt/providers/bin:/usr/bin",
      source: "instance-unit-file",
    });
  });

  it("prefers the PATH systemd reports, so a drop-in on the donor is not missed", () => {
    // The live workaround for #525 was written as a drop-in, so the unit text
    // alone is the wrong place to look when systemd can answer.
    writeUnit("rusa.service", ["[Service]", "Environment=PATH=/usr/bin"]);

    const borrowed = resolvePoolProbePath(
      systemdUserDir,
      POOL_CLIENT_UNITS,
      withSystemd({ "rusa.service": "/opt/providers/bin:/usr/bin" })
    );
    expect(borrowed.donorUnit).toBe("rusa.service");
    expect(borrowed.probePath).toEqual({
      path: "/opt/providers/bin:/usr/bin",
      source: "instance-unit-systemd",
    });
  });

  it("skips a client unit that supplies no PATH rather than treating it as empty", () => {
    writeUnit("rusa.service", ["[Service]", "Environment=RUSA_HOME=/home/u/.rusa"]);
    writeUnit("rusa-staging.service", ["[Service]", "Environment=PATH=/opt/providers/bin"]);

    const borrowed = resolvePoolProbePath(systemdUserDir, POOL_CLIENT_UNITS, noSystemd);
    expect(borrowed.donorUnit).toBe("rusa-staging.service");
    expect(borrowed.probePath.path).toBe("/opt/providers/bin");
  });

  it("falls back to this shell when the coordinator is installed before any client", () => {
    mkdirSync(join(systemdUserDir, "empty"), { recursive: true });

    const borrowed = resolvePoolProbePath(systemdUserDir, POOL_CLIENT_UNITS, noSystemd);
    expect(borrowed.donorUnit).toBeNull();
    expect(borrowed.installedUnits).toEqual([]);
    expect(borrowed.probePath.source).toBe("process");
  });

  it("reports an installed client that supplies no PATH, distinctly from none installed", () => {
    // This is the case an operator can act on — and the one that reproduces
    // #525 — so it has to be distinguishable from having no client at all.
    writeUnit("rusa.service", ["[Service]", "Environment=RUSA_HOME=/home/u/.rusa"]);

    const borrowed = resolvePoolProbePath(systemdUserDir, POOL_CLIENT_UNITS, noSystemd);
    expect(borrowed.donorUnit).toBeNull();
    expect(borrowed.installedUnits).toEqual(["rusa.service"]);
    expect(borrowed.probePath.source).toBe("process");
  });
});
