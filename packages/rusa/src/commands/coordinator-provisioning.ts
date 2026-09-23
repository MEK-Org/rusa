import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import {
  type ProbePathEnv,
  readUnitEnvironment,
  resolvePathEnvForUnit,
  resolveProbePathEnv,
} from "./service-instance.js";

/**
 * The pool-owned coordinator units.
 *
 * Fixed names, deliberately not derived from any instance's service basename.
 * The coordinator is one service per *quota pool* — the set of instances that
 * share a quota database — and production and staging are clients of it. While
 * the names were derived per environment, installing staging produced a second
 * unit that looked like a staging-owned companion and in fact probed the same
 * providers as the first: a duplicate pool coordinator, which is the failure
 * issue #507 is about. One pool, one name.
 *
 * `rusa-quota-coordinator.service` is also exactly what the old production
 * derivation produced, so an existing production install keeps its unit name,
 * its enablement, and its database across this change; only the staging-derived
 * units are removed.
 */
export const POOL_COORDINATOR_UNIT = "rusa-quota-coordinator.service";
export const POOL_COORDINATOR_ALERT_UNIT = "rusa-quota-coordinator-alert.service";

/** Matches any coordinator unit name, pool-owned or environment-derived. */
const COORDINATOR_UNIT_RE = /^(.+)-quota-coordinator(-alert)?\.service$/;

/** The environment variable naming the coordinator's own home. */
export const COORDINATOR_HOME_ENV = "RUSA_QUOTA_COORDINATOR_HOME";

export interface InstalledCoordinatorUnit {
  /** Unit file name, e.g. `rusa-staging-quota-coordinator.service`. */
  unit: string;
  /** The `RUSA_HOME` that unit assigns, or null when it assigns none. */
  home: string | null;
}

/**
 * Find the coordinator service units already on disk, with the home each one
 * runs against. Alert companions are excluded: they carry no `RUSA_HOME` of
 * their own worth adopting and are removed alongside the service they belong to.
 */
export function readInstalledCoordinatorUnits(
  systemdUserDir: string,
  unitNames: readonly string[]
): InstalledCoordinatorUnit[] {
  return unitNames
    .filter((name) => {
      const match = COORDINATOR_UNIT_RE.exec(name);
      return match !== null && match[2] === undefined;
    })
    .sort()
    .map((unit) => {
      let contents: string;
      try {
        contents = readFileSync(join(systemdUserDir, unit), "utf-8");
      } catch {
        return { unit, home: null };
      }
      return { unit, home: readUnitEnvironment(contents, "RUSA_HOME") };
    });
}

export type CoordinatorHomeSource = "flag" | "env" | "adopted";

export interface CoordinatorServiceContext {
  /** The coordinator's own home: where its config, `.env`, and workers dir live. */
  home: string;
  /** How that home was chosen, so the installer can report it rather than imply it. */
  homeSource: CoordinatorHomeSource;
  /** Present only for `adopted`: the unit the home was read back out of. */
  adoptedFrom?: string;
  serviceUnit: string;
  alertUnit: string;
  configPath: string;
  workersDir: string;
}

/**
 * Resolve the coordinator's own service context.
 *
 * Under #507 the home is an explicit property of the coordinator service, never
 * a consequence of an `--environment production|staging` switch that also chose
 * a unit name and an instance to hang off. In order:
 *
 * 1. `--home`, the operator saying it outright;
 * 2. `RUSA_QUOTA_COORDINATOR_HOME`, the same statement made once for a host;
 * 3. adoption from the coordinator unit already installed, which is what makes
 *    the transition from the environment-derived units a no-argument re-run.
 *
 * Adoption prefers the pool unit when it exists, because that is the unit that
 * survives and therefore the database that must keep being opened. Falling back
 * to a single environment-derived unit covers a host that only ever installed
 * staging. Two disagreeing units with no pool unit is not guessed at: choosing
 * one would silently choose which pool database the service adopts.
 */
export function resolveCoordinatorServiceContext(opts: {
  home?: string;
  envHome?: string;
  installedUnits?: readonly InstalledCoordinatorUnit[];
}): CoordinatorServiceContext {
  const explicit = opts.home?.trim();
  if (explicit) return contextFor(resolve(explicit), "flag");

  const fromEnv = opts.envHome?.trim();
  if (fromEnv) return contextFor(resolve(fromEnv), "env");

  const candidates = (opts.installedUnits ?? []).filter(
    (candidate): candidate is InstalledCoordinatorUnit & { home: string } => candidate.home !== null
  );
  const pool = candidates.find((candidate) => candidate.unit === POOL_COORDINATOR_UNIT);
  if (pool) return { ...contextFor(resolve(pool.home), "adopted"), adoptedFrom: pool.unit };
  if (candidates.length === 1) {
    return {
      ...contextFor(resolve(candidates[0].home), "adopted"),
      adoptedFrom: candidates[0].unit,
    };
  }
  if (candidates.length > 1) {
    const listed = candidates.map((c) => `${c.unit} (${c.home})`).join(", ");
    throw new Error(
      `Cannot tell which home the pool coordinator should adopt: ${listed}. ` +
        `Pass --home <path> to name it explicitly — choosing for you would choose which quota database the service opens.`
    );
  }

  throw new Error(
    "The quota coordinator's home is no longer derived from an instance environment. " +
      `Pass --home <path> (or set ${COORDINATOR_HOME_ENV}) to name the pool coordinator's own home.`
  );
}

function contextFor(home: string, homeSource: CoordinatorHomeSource): CoordinatorServiceContext {
  return {
    home,
    homeSource,
    serviceUnit: POOL_COORDINATOR_UNIT,
    alertUnit: POOL_COORDINATOR_ALERT_UNIT,
    configPath: join(home, "config.yaml"),
    workersDir: join(home, "workers"),
  };
}

export interface CoordinatorTransitionPlan {
  /**
   * Environment-derived coordinator units to stop, disable, and remove — the
   * duplicate pool coordinators. Their alert companions are included.
   */
  removeUnits: string[];
}

/**
 * Plan the transition off the environment-derived units.
 *
 * Every coordinator unit that is not the pool unit or its alert companion is a
 * duplicate of the one service this pool should run, and is removed. The plan
 * is derived from the unit names alone so it can be asserted on directly, and
 * it is empty on a host that has already transitioned — which is what makes
 * re-running the installer idempotent.
 *
 * Removing a unit never removes a database. A coordinator that was opening a
 * different file leaves that file exactly where it is; the installer says so.
 */
export function planCoordinatorTransition(unitNames: readonly string[]): CoordinatorTransitionPlan {
  const removeUnits = unitNames
    .filter(
      (name) =>
        COORDINATOR_UNIT_RE.test(name) &&
        name !== POOL_COORDINATOR_UNIT &&
        name !== POOL_COORDINATOR_ALERT_UNIT
    )
    .sort();
  return { removeUnits };
}

/**
 * The client instance units of this pool, in the order a provider-capable
 * `PATH` is borrowed from them.
 *
 * The coordinator no longer hangs off a selected instance, but it still has to
 * launch the same provider CLIs those instances launch, and an installed
 * instance unit is the one place on the host where that `PATH` is already
 * written down (#525). Reading it is not the coupling #507 removes: nothing
 * about the coordinator's identity, home, unit name, or database comes from
 * here, and the installer reports which unit it borrowed from.
 */
export function poolClientUnitNames(): string[] {
  return ["rusa.service", "rusa-staging.service"];
}

export interface PoolProbePath {
  probePath: ProbePathEnv;
  /** The client unit the `PATH` was borrowed from, or null when none supplied one. */
  donorUnit: string | null;
  /** Candidate client units on disk, whether or not they supplied a `PATH`. */
  installedUnits: string[];
}

/**
 * Borrow the probe `PATH` from the first client unit that can supply one.
 *
 * Each candidate is resolved the way #525 settled on: ask systemd for the
 * unit's effective environment first — that folds in `<unit>.d/*.conf`
 * drop-ins, which is how the live workaround for #525 was actually written —
 * and read the unit text only when systemd cannot answer. A candidate that
 * yields nothing either way is skipped rather than treated as an empty `PATH`,
 * because an empty one would silently reproduce the bug.
 *
 * `installedUnits` is reported separately from `donorUnit` so the installer can
 * distinguish "no client installed yet" from "a client is installed but assigns
 * no PATH" — the second is the actionable case and the one that reproduces #525.
 */
export function resolvePoolProbePath(
  systemdUserDir: string,
  unitNames: readonly string[],
  resolve: typeof resolveProbePathEnv = resolveProbePathEnv
): PoolProbePath {
  const installedUnits: string[] = [];
  for (const unit of unitNames) {
    let contents: string;
    try {
      contents = readFileSync(join(systemdUserDir, unit), "utf-8");
    } catch {
      continue;
    }
    installedUnits.push(unit);
    const probePath = resolve(unit, contents);
    if (probePath.source !== "process") return { probePath, donorUnit: unit, installedUnits };
  }
  return {
    probePath: { path: resolvePathEnvForUnit(), source: "process" },
    donorUnit: null,
    installedUnits,
  };
}
