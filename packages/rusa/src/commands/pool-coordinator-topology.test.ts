import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  POOL_COORDINATOR_ALERT_UNIT,
  POOL_COORDINATOR_UNIT,
  planCoordinatorTransition,
  readInstalledCoordinatorUnits,
  resolveCoordinatorServiceContext,
} from "./coordinator-provisioning.js";
import {
  buildQuotaCoordinatorUnit,
  buildServiceUnit,
  coordinatorUnitForClient,
  retireEnvironmentDerivedCoordinators,
  unitOrdersAfter,
} from "./install-service.js";

/**
 * Issue #507's acceptance condition: two client instances consume one
 * coordinator, and only that coordinator probes providers.
 *
 * The host these tests start from is the one the issue describes — production
 * and staging each with their own instance unit, and a coordinator unit derived
 * from *each* instance's service basename, which is two pool coordinators
 * probing the same providers against the same pool.
 */

const POOL_HOME = "/home/u/.rusa";
const STAGING_HOME = "/home/u/.rusa-staging";

let systemdUserDir: string;
let logs: string[];

beforeEach(() => {
  systemdUserDir = mkdtempSync(join(tmpdir(), "rusa-pool-topology-"));
  logs = [];
  vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => {
    logs.push(args.join(" "));
  });
});

afterEach(() => {
  vi.restoreAllMocks();
  rmSync(systemdUserDir, { recursive: true, force: true });
});

function writeUnit(name: string, contents: string): void {
  writeFileSync(join(systemdUserDir, name), contents, "utf-8");
}

function instanceUnit(home: string): string {
  return buildServiceUnit({
    description: "Rusa",
    mcHome: home,
    cliPath: "/opt/rusa/dist/cli.js",
    nodePath: "/usr/bin/node",
    userPath: "/opt/providers/bin:/usr/bin:/bin",
    coordinatorUnit: coordinatorUnitForClient(systemdUserDir),
  });
}

function coordinatorUnitFor(home: string): string {
  return buildQuotaCoordinatorUnit({
    description: "Rusa Quota Coordinator",
    mcHome: home,
    cliPath: "/opt/rusa/dist/cli.js",
    nodePath: "/usr/bin/node",
    userPath: "/opt/providers/bin:/usr/bin:/bin",
    xdgRuntimeDir: "/run/user/1000",
  });
}

/** The pre-#507 host: two instances, two environment-derived coordinators. */
function seedEnvironmentDerivedHost(): void {
  writeUnit(POOL_COORDINATOR_UNIT, coordinatorUnitFor(POOL_HOME));
  writeUnit("rusa-staging-quota-coordinator.service", coordinatorUnitFor(STAGING_HOME));
  writeUnit("rusa-staging-quota-coordinator-alert.service", "[Service]\nType=oneshot\n");
  writeUnit("rusa.service", instanceUnit(POOL_HOME));
  writeUnit("rusa-staging.service", instanceUnit(STAGING_HOME));
}

function unitNames(): string[] {
  return readdirSync(systemdUserDir).filter((name) => name.endsWith(".service"));
}

function retire(): { retired: string[]; stopped: string[] } {
  const stopped: string[] = [];
  const retired = retireEnvironmentDerivedCoordinators(systemdUserDir, unitNames(), (unit) => {
    stopped.push(unit);
    return true;
  });
  return { retired, stopped };
}

describe("two client instances, one pool coordinator", () => {
  it("leaves exactly one coordinator service after the transition", () => {
    seedEnvironmentDerivedHost();
    expect(unitNames().filter((n) => n.includes("quota-coordinator"))).toHaveLength(3);

    const { retired, stopped } = retire();

    expect(retired).toEqual([
      "rusa-staging-quota-coordinator-alert.service",
      "rusa-staging-quota-coordinator.service",
    ]);
    // Stopped and disabled before removal, so the duplicate is not left running
    // against a unit file that no longer exists.
    expect(stopped).toEqual(retired);
    expect(unitNames().filter((n) => n.includes("quota-coordinator"))).toEqual([
      POOL_COORDINATOR_UNIT,
    ]);
  });

  it("points both client instances at that one coordinator, whatever their environment", () => {
    seedEnvironmentDerivedHost();
    retire();

    // Rebuilt the way `install-service` builds them, now that the pool unit is
    // the only coordinator on disk.
    const production = instanceUnit(POOL_HOME);
    const staging = instanceUnit(STAGING_HOME);

    for (const unit of [production, staging]) {
      expect(unitOrdersAfter(unit, POOL_COORDINATOR_UNIT)).toBe(true);
      // Ordering, never a hard dependency: a client whose coordinator is down
      // paces on its last applied interval rather than failing to start.
      expect(unit).not.toContain("Requires=");
    }
    expect(staging).not.toContain("rusa-staging-quota-coordinator.service");
  });

  it("runs the probe in the coordinator only — neither client unit starts one", () => {
    seedEnvironmentDerivedHost();
    retire();

    const coordinator = coordinatorUnitFor(POOL_HOME);
    expect(coordinator).toContain('"quota-coordinator"');
    expect(coordinator).toContain(`Environment=RUSA_HOME=${POOL_HOME}`);

    for (const unit of [instanceUnit(POOL_HOME), instanceUnit(STAGING_HOME)]) {
      const execStart = unit.split("\n").find((line) => line.startsWith("ExecStart="));
      expect(execStart).toBeDefined();
      expect(execStart).not.toContain("quota-coordinator");
    }
  });

  it("changes no client unit, because provisioning and connecting are separate acts", () => {
    seedEnvironmentDerivedHost();
    const before = new Map(
      ["rusa.service", "rusa-staging.service"].map((unit) => [
        unit,
        readFileSync(join(systemdUserDir, unit), "utf-8"),
      ])
    );

    retire();

    // The old installer retrofitted After=/Wants= into the instance unit that
    // matched its --environment. Reaching into a unit `install-service` owns is
    // the coupling #507 removes, and an instance unit is also the one thing in
    // this directory a widened match would be most likely to reach.
    for (const [unit, contents] of before) {
      expect(readFileSync(join(systemdUserDir, unit), "utf-8")).toBe(contents);
    }
  });

  it("leaves a coordinator-shaped unit this project never wrote exactly where it is", () => {
    seedEnvironmentDerivedHost();
    writeUnit("acme-quota-coordinator.service", "[Service]\nExecStart=/opt/acme/bin/collector\n");

    const { retired, stopped } = retire();

    expect(retired).not.toContain("acme-quota-coordinator.service");
    expect(stopped).not.toContain("acme-quota-coordinator.service");
    expect(unitNames()).toContain("acme-quota-coordinator.service");
  });

  it("stops before deleting: a unit that will not stop is left installed and the install fails", () => {
    seedEnvironmentDerivedHost();
    const stopped: string[] = [];

    // Deleting the unit file of a duplicate that is still running would leave
    // two coordinators probing the same providers with nothing on the host left
    // to say so — the condition this whole transition exists to end. Stopping
    // happens across every duplicate before any unit file is removed, so a stop
    // failure leaves the host untouched.
    expect(() =>
      retireEnvironmentDerivedCoordinators(systemdUserDir, unitNames(), (unit) => {
        stopped.push(unit);
        return unit !== "rusa-staging-quota-coordinator.service";
      })
    ).toThrow(/Could not stop and disable rusa-staging-quota-coordinator\.service/);

    expect(stopped).toContain("rusa-staging-quota-coordinator.service");
    // Nothing was deleted: both the service and its alert companion survive.
    expect(unitNames()).toContain("rusa-staging-quota-coordinator.service");
    expect(unitNames()).toContain("rusa-staging-quota-coordinator-alert.service");
  });

  it("adopts the surviving coordinator's home, so the pool database does not move", () => {
    seedEnvironmentDerivedHost();
    const context = resolveCoordinatorServiceContext({
      installedUnits: readInstalledCoordinatorUnits(systemdUserDir, unitNames()),
    });

    expect(context.home).toBe(POOL_HOME);
    expect(context.adoptedFrom).toBe(POOL_COORDINATOR_UNIT);
    expect(context.serviceUnit).toBe(POOL_COORDINATOR_UNIT);
    expect(context.alertUnit).toBe(POOL_COORDINATOR_ALERT_UNIT);
  });

  it("is idempotent: a second pass finds nothing to retire and changes nothing", () => {
    seedEnvironmentDerivedHost();
    retire();
    const after = unitNames().sort();

    const second = retire();

    expect(second.retired).toEqual([]);
    expect(second.stopped).toEqual([]);
    expect(unitNames().sort()).toEqual(after);
    expect(planCoordinatorTransition(unitNames()).removeUnits).toEqual([]);
  });

  it("says on the way out that the retired coordinator's database is left on disk", () => {
    seedEnvironmentDerivedHost();
    retire();

    expect(logs.join("\n")).toContain(
      `its home ${STAGING_HOME} and any database under it are left untouched on disk`
    );
  });
});
