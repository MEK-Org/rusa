import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "../config/loader.js";
import {
	COORDINATOR_SERVICE_UNITS,
	POOL_CLIENT_UNITS,
} from "./coordinator-provisioning.js";
import { configuredProviderCommands } from "./install-service.js";
import { type DoctorResult, formatDoctorResults } from "./quickstart-doctor.js";
import {
	probeSystemdUnitPathEnv,
	readUnitPathEnv,
	resolveExecutableOnPath,
	type SystemdUnitPathProbe,
} from "./service-instance.js";

const CHECK_NAME = "quota coordinator PATH";

const REINSTALL_HINT =
	"Reinstall the coordinator with 'rusa install-quota-coordinator' so it picks up the instance unit's current PATH.";

export interface CoordinatorPathDriftDeps {
	/** Ask systemd for a unit's effective `PATH`, drop-ins folded in. */
	probeSystemdUnitPath: (unitName: string) => SystemdUnitPathProbe;
	/** A unit file's text, for when the systemd user manager cannot answer. */
	readUnitFile: (unitName: string) => string | null;
	/** Resolve a command against an explicit `PATH` rather than this process's. */
	resolveExecutable: (command: string, pathEnv: string) => string | null;
}

/**
 * The provider CLIs to probe, or why they could not be determined.
 *
 * An unreadable config is not evidence about which CLIs a host launches, so the
 * check reports that it could not tell rather than substituting a guess that
 * would name CLIs the host never wanted and omit the ones it does.
 */
export type ProviderCommands =
	| { readonly commands: readonly string[] }
	| { readonly unavailable: string };

export function defaultCoordinatorPathDriftDeps(
	systemdUserDir: string = join(homedir(), ".config", "systemd", "user"),
): CoordinatorPathDriftDeps {
	return {
		probeSystemdUnitPath: probeSystemdUnitPathEnv,
		readUnitFile: (unitName) => {
			const unitPath = join(systemdUserDir, unitName);
			return existsSync(unitPath) ? readFileSync(unitPath, "utf8") : null;
		},
		resolveExecutable: resolveExecutableOnPath,
	};
}

/**
 * Read the configured provider CLI commands from the rusa home.
 *
 * `home` is the rusa home and nothing else: with none given, `loadConfig`
 * resolves `RUSA_HOME` the way every other command does. Reading the config
 * also loads `<home>/.env` into this process's environment, as it does
 * everywhere else in the CLI; that is the one thing this command writes, and it
 * writes nothing to either unit.
 */
export function resolveProviderCommands(home?: string): ProviderCommands {
	let commands: string[];
	try {
		commands = configuredProviderCommands(loadConfig(home));
	} catch (error) {
		return {
			unavailable: error instanceof Error ? error.message : String(error),
		};
	}
	return commands.length > 0
		? { commands }
		: { unavailable: "config.yaml configures no providers" };
}

type UnitPathReading =
	| { state: "path"; path: string; source: "systemd" | "unit file" }
	/** The unit is installed and assigns no `PATH` of its own. */
	| { state: "no-path" }
	/**
	 * Systemd answered and no unit file exists: the unit is not installed.
	 * Note: `systemctl show -p Environment --value` returns empty for both unknown
	 * units and known units with no environment set, so a unit file outside the
	 * search directory lacking a PATH degrades safely to `info` rather than a false `pass`.
	 */
	| { state: "absent" }
	/** Systemd could not be asked and no unit file exists: nothing is established. */
	| { state: "unknown" };

function readUnitPath(
	deps: CoordinatorPathDriftDeps,
	unitName: string,
): UnitPathReading {
	const probe = deps.probeSystemdUnitPath(unitName);
	if (probe.path) return { state: "path", path: probe.path, source: "systemd" };

	const contents = deps.readUnitFile(unitName);
	if (contents !== null) {
		const fromFile = readUnitPathEnv(contents);
		return fromFile
			? { state: "path", path: fromFile, source: "unit file" }
			: { state: "no-path" };
	}
	return probe.answered ? { state: "absent" } : { state: "unknown" };
}

interface UnitPath {
	unit: string;
	path: string;
	source: "systemd" | "unit file";
}

/**
 * Compare each installed quota coordinator unit's `PATH` against the instance
 * unit's, and report any provider CLI that resolves on one and not the other
 * (#638).
 *
 * The coordinator scrapes by launching provider CLIs by bare name, so a
 * coordinator whose `PATH` has fallen behind the instance's starts, binds and
 * answers `healthz` while every scrape fails one layer down. #635 derives the
 * coordinator's `PATH` from the instance unit at install time; nothing kept
 * them in agreement afterwards.
 *
 * Non-fatal and non-mutating: every outcome is `pass`, `info` or `warn`, the
 * coordinator need not be running, and the remedy is a reinstall the operator
 * runs.
 */
export function checkCoordinatorPathDrift(
	deps: CoordinatorPathDriftDeps,
	opts: { providerCommands: ProviderCommands },
): DoctorResult[] {
	const coordinators = COORDINATOR_SERVICE_UNITS.map((unit) => ({
		unit,
		reading: readUnitPath(deps, unit),
	}));
	const installed = coordinators.filter(
		({ reading }) => reading.state === "path" || reading.state === "no-path",
	);

	if (installed.length === 0) {
		const unknown = coordinators.some(
			({ reading }) => reading.state === "unknown",
		);
		return [
			unknown
				? {
						name: CHECK_NAME,
						status: "info",
						message:
							"cannot tell whether a quota coordinator is installed: the systemd user manager did not answer and no unit file was found.",
						probed: COORDINATOR_SERVICE_UNITS.map(
							(unit) => `${unit}: not established`,
						),
					}
				: {
						name: CHECK_NAME,
						status: "info",
						message: `no quota coordinator unit is installed (${COORDINATOR_SERVICE_UNITS.join(", ")}); nothing to compare.`,
					},
		];
	}

	return installed.map(({ unit, reading }) => {
		const donor = resolveDonorUnit(deps, unit);
		return compareCoordinator(
			deps,
			unit,
			reading,
			donor,
			opts.providerCommands,
		);
	});
}

/**
 * The instance unit paired with this coordinator: for a staging coordinator,
 * `rusa-staging.service`; for the pool coordinator (and production), `rusa.service`.
 */
function pairedInstanceUnit(coordinatorUnit: string): string {
	return coordinatorUnit.startsWith("rusa-staging")
		? "rusa-staging.service"
		: "rusa.service";
}

/**
 * The instance unit a coordinator's `PATH` is meant to match.
 *
 * Pairs each coordinator with the instance unit of its own basename when that
 * unit supplies a `PATH` (matching the pre-#642 installer and preventing false
 * drift warnings on two-instance hosts), and falls back to the first instance
 * unit that supplies a `PATH` (matching #642's pool installer `resolvePoolProbePath`).
 */
function resolveDonorUnit(
	deps: CoordinatorPathDriftDeps,
	coordinatorUnit: string,
): UnitPath | null {
	const paired = pairedInstanceUnit(coordinatorUnit);
	const pairedReading = readUnitPath(deps, paired);
	if (pairedReading.state === "path") {
		return {
			unit: paired,
			path: pairedReading.path,
			source: pairedReading.source,
		};
	}
	return firstInstanceUnitWithPath(deps);
}

function firstInstanceUnitWithPath(
	deps: CoordinatorPathDriftDeps,
): UnitPath | null {
	for (const unit of POOL_CLIENT_UNITS) {
		const reading = readUnitPath(deps, unit);
		if (reading.state === "path") {
			return { unit, path: reading.path, source: reading.source };
		}
	}
	return null;
}

function compareCoordinator(
	deps: CoordinatorPathDriftDeps,
	coordinatorUnit: string,
	reading: UnitPathReading,
	donor: UnitPath | null,
	providerCommands: ProviderCommands,
): DoctorResult {
	if (reading.state !== "path") {
		return {
			name: CHECK_NAME,
			status: "warn",
			message: `${coordinatorUnit} is installed but assigns no PATH.`,
			hint: REINSTALL_HINT,
			probed: [`${coordinatorUnit}: installed, no PATH assigned`],
		};
	}
	const coordinatorPath = reading.path;

	if (!donor) {
		return {
			name: CHECK_NAME,
			status: "warn",
			message: `${coordinatorUnit} is installed, but no instance unit assigns a PATH to compare it against (${POOL_CLIENT_UNITS.join(", ")}).`,
			hint: "Install an instance with 'rusa install-service', then reinstall the coordinator with 'rusa install-quota-coordinator'.",
			probed: [
				`${coordinatorUnit} PATH (${reading.source}): ${coordinatorPath}`,
			],
		};
	}

	const probed = [
		`${coordinatorUnit} PATH (${reading.source}): ${coordinatorPath}`,
		`${donor.unit} PATH (${donor.source}): ${donor.path}`,
	];
	const identical = coordinatorPath === donor.path;

	if ("unavailable" in providerCommands) {
		// Without the provider CLI list, identical PATHs are still conclusive and a
		// difference is not: it may or may not be the difference that breaks scrapes.
		probed.push(`provider CLIs not checked: ${providerCommands.unavailable}`);
		return identical
			? {
					name: CHECK_NAME,
					status: "pass",
					message: `${coordinatorUnit} and ${donor.unit} assign the same PATH.`,
					probed,
				}
			: {
					name: CHECK_NAME,
					status: "warn",
					message: `${coordinatorUnit} PATH differs from ${donor.unit}, and which provider CLIs to check could not be determined (${providerCommands.unavailable}).`,
					hint: REINSTALL_HINT,
					probed,
				};
	}

	const missingOnCoordinator: string[] = [];
	const missingOnInstance: string[] = [];
	const resolvedOnBoth: string[] = [];
	for (const command of providerCommands.commands) {
		const onCoordinator = deps.resolveExecutable(command, coordinatorPath);
		const onInstance = deps.resolveExecutable(command, donor.path);
		if (onInstance && !onCoordinator) missingOnCoordinator.push(command);
		else if (onCoordinator && !onInstance) missingOnInstance.push(command);
		else if (onCoordinator && onInstance) resolvedOnBoth.push(command);
	}
	missingOnCoordinator.sort();
	missingOnInstance.sort();
	resolvedOnBoth.sort();

	if (missingOnCoordinator.length > 0)
		probed.push(`missing on coordinator: ${missingOnCoordinator.join(", ")}`);
	if (missingOnInstance.length > 0)
		probed.push(`missing on instance: ${missingOnInstance.join(", ")}`);
	if (resolvedOnBoth.length > 0)
		probed.push(`resolved on both: ${resolvedOnBoth.join(", ")}`);

	if (missingOnCoordinator.length > 0) {
		return {
			name: CHECK_NAME,
			status: "warn",
			message: `${coordinatorUnit} PATH has drifted from ${donor.unit}; provider CLI(s) the coordinator cannot resolve: ${missingOnCoordinator.join(", ")}.`,
			hint: REINSTALL_HINT,
			probed,
		};
	}

	if (missingOnInstance.length > 0) {
		return {
			name: CHECK_NAME,
			status: "warn",
			message: `${coordinatorUnit} PATH diverges from ${donor.unit}; provider CLI(s) resolving only on the coordinator: ${missingOnInstance.join(", ")}.`,
			hint: REINSTALL_HINT,
			probed,
		};
	}

	return {
		name: CHECK_NAME,
		status: "pass",
		message: identical
			? `${coordinatorUnit} and ${donor.unit} assign the same PATH.`
			: `${coordinatorUnit} and ${donor.unit} assign different PATHs, and every configured provider CLI resolves on both.`,
		probed,
	};
}

export interface DoctorOptions {
	/** Rusa home to read the configured provider CLIs from; defaults to `RUSA_HOME`. */
	home?: string;
	deps?: CoordinatorPathDriftDeps;
}

/**
 * `rusa doctor`: report on this host's rusa service installation.
 *
 * Deliberately not the quickstart preflight suite. That one answers "can this
 * checkout run `pnpm start`" — flutter, docker, loopback ports, a 10 GiB disk
 * threshold — and a service host legitimately has none of those. This one asks
 * about the units the host actually runs, and needs no source checkout.
 */
export function runDoctor(options: DoctorOptions = {}): DoctorResult[] {
	const deps = options.deps ?? defaultCoordinatorPathDriftDeps();
	const results = checkCoordinatorPathDrift(deps, {
		providerCommands: resolveProviderCommands(options.home),
	});
	console.log(formatDoctorResults(results, "[rusa] Doctor:"));
	return results;
}
