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
export const POOL_COORDINATOR_ALERT_UNIT =
	"rusa-quota-coordinator-alert.service";

/**
 * Every coordinator unit name this project has ever installed.
 *
 * An exact set rather than a shape, because deletion is on the other end of it:
 * `planCoordinatorTransition` feeds `retireEnvironmentDerivedCoordinators`,
 * which disables and removes what it names out of `~/.config/systemd/user` —
 * the user's own unit directory, shared with every other service they have
 * installed. The set is closed and cannot grow behind us: the environment-
 * derived name came from `resolveServiceBasename`, which is `production ?
 * "rusa" : "rusa-staging"` over a two-valued `ServiceEnvironment`, and this
 * change removes that derivation, so these four names are the complete history.
 */
const LEGACY_COORDINATOR_BASENAME = "rusa-staging";

export const COORDINATOR_SERVICE_UNITS: readonly string[] = [
	POOL_COORDINATOR_UNIT,
	`${LEGACY_COORDINATOR_BASENAME}-quota-coordinator.service`,
];

const COORDINATOR_ALERT_UNITS: readonly string[] = [
	POOL_COORDINATOR_ALERT_UNIT,
	`${LEGACY_COORDINATOR_BASENAME}-quota-coordinator-alert.service`,
];

/** True for a coordinator *service* unit we wrote; alert companions excluded. */
function isCoordinatorServiceUnit(name: string): boolean {
	return COORDINATOR_SERVICE_UNITS.includes(name);
}

/** True for any coordinator unit we wrote, service or alert companion. */
function isCoordinatorUnit(name: string): boolean {
	return (
		isCoordinatorServiceUnit(name) || COORDINATOR_ALERT_UNITS.includes(name)
	);
}

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
	unitNames: readonly string[],
): InstalledCoordinatorUnit[] {
	return unitNames
		.filter(isCoordinatorServiceUnit)
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
		(candidate): candidate is InstalledCoordinatorUnit & { home: string } =>
			candidate.home !== null,
	);
	const pool = candidates.find(
		(candidate) => candidate.unit === POOL_COORDINATOR_UNIT,
	);
	if (pool)
		return {
			...contextFor(resolve(pool.home), "adopted"),
			adoptedFrom: pool.unit,
		};
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
				`Pass --home <path> to name it explicitly — choosing for you would choose which quota database the service opens.`,
		);
	}

	throw new Error(
		"The quota coordinator's home is no longer derived from an instance environment. " +
			`Pass --home <path> (or set ${COORDINATOR_HOME_ENV}) to name the pool coordinator's own home.`,
	);
}

function contextFor(
	home: string,
	homeSource: CoordinatorHomeSource,
): CoordinatorServiceContext {
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
export function planCoordinatorTransition(
	unitNames: readonly string[],
): CoordinatorTransitionPlan {
	const removeUnits = unitNames
		.filter(
			(name) =>
				isCoordinatorUnit(name) &&
				name !== POOL_COORDINATOR_UNIT &&
				name !== POOL_COORDINATOR_ALERT_UNIT,
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
 *
 * Named rather than discovered by scanning, because an instance unit has no
 * distinguishing suffix the way `-quota-coordinator` does — scanning
 * `~/.config/systemd/user/*.service` would mean guessing which of the user's
 * units are rusa instances, and a wrong guess donates a stranger's `PATH` to
 * the probe. These two are not an assumption about the pool's membership:
 * `install-service` writes its unit as `resolveServiceBasename(environment)`,
 * which is `production ? "rusa" : "rusa-staging"`, so this is the complete set
 * of client unit names that command can produce. A third instance would have to
 * change that derivation, which is the same edit that would extend this list.
 */
export const POOL_CLIENT_UNITS: readonly string[] = [
	"rusa.service",
	"rusa-staging.service",
];

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
	resolveProbe: typeof resolveProbePathEnv = resolveProbePathEnv,
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
		const probePath = resolveProbe(unit, contents);
		if (probePath.source !== "process")
			return { probePath, donorUnit: unit, installedUnits };
	}
	return {
		probePath: { path: resolvePathEnvForUnit(), source: "process" },
		donorUnit: null,
		installedUnits,
	};
}
