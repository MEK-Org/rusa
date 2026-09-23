import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  COORDINATOR_HOME_ENV,
  POOL_COORDINATOR_ALERT_UNIT,
  POOL_COORDINATOR_UNIT,
  planCoordinatorTransition,
  poolClientUnitNames,
  readInstalledCoordinatorUnits,
  resolveCoordinatorServiceContext,
  resolvePoolProbePath,
} from "./coordinator-provisioning.js";
import { resolveProbePathEnv } from "./service-instance.js";

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

    const borrowed = resolvePoolProbePath(systemdUserDir, poolClientUnitNames(), noSystemd);
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
      poolClientUnitNames(),
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

    const borrowed = resolvePoolProbePath(systemdUserDir, poolClientUnitNames(), noSystemd);
    expect(borrowed.donorUnit).toBe("rusa-staging.service");
    expect(borrowed.probePath.path).toBe("/opt/providers/bin");
  });

  it("falls back to this shell when the coordinator is installed before any client", () => {
    mkdirSync(join(systemdUserDir, "empty"), { recursive: true });

    const borrowed = resolvePoolProbePath(systemdUserDir, poolClientUnitNames(), noSystemd);
    expect(borrowed.donorUnit).toBeNull();
    expect(borrowed.installedUnits).toEqual([]);
    expect(borrowed.probePath.source).toBe("process");
  });

  it("reports an installed client that supplies no PATH, distinctly from none installed", () => {
    // This is the case an operator can act on — and the one that reproduces
    // #525 — so it has to be distinguishable from having no client at all.
    writeUnit("rusa.service", ["[Service]", "Environment=RUSA_HOME=/home/u/.rusa"]);

    const borrowed = resolvePoolProbePath(systemdUserDir, poolClientUnitNames(), noSystemd);
    expect(borrowed.donorUnit).toBeNull();
    expect(borrowed.installedUnits).toEqual(["rusa.service"]);
    expect(borrowed.probePath.source).toBe("process");
  });
});
