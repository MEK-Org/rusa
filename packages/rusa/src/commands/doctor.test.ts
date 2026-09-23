import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  type CoordinatorPathDriftDeps,
  checkCoordinatorPathDrift,
  defaultCoordinatorPathDriftDeps,
  resolveProviderCommands,
  runDoctor,
} from "./doctor.js";

const COORDINATOR = "rusa-quota-coordinator.service";
const STAGING_COORDINATOR = "rusa-staging-quota-coordinator.service";
const INSTANCE = "rusa.service";

const PROVIDER_PATH = "/opt/providers/bin:/usr/bin:/bin";
const BARE_PATH = "/usr/bin:/bin";

/** Units systemd knows about, by name; every other unit is unknown to it. */
function deps(
  systemdPaths: Record<string, string>,
  overrides: Partial<CoordinatorPathDriftDeps> = {}
): CoordinatorPathDriftDeps {
  return {
    probeSystemdUnitPath: (unit) => ({ answered: true, path: systemdPaths[unit] ?? null }),
    readUnitFile: () => null,
    // Providers live in /opt/providers/bin; everything else resolves nowhere.
    resolveExecutable: (command, pathEnv) =>
      pathEnv.includes("/opt/providers/bin") ? `/opt/providers/bin/${command}` : null,
    ...overrides,
  };
}

/** A config.yaml that loads, carrying the providers block the check reads. */
function configYaml(providers: string, rootProvider = "claude"): string {
  return [
    "github:",
    "  account: test-bot",
    "rootActor:",
    `  provider: ${rootProvider}`,
    "  model: claude-3-5-sonnet",
    "providers:",
    providers.replace(/\n$/, ""),
    "",
  ].join("\n");
}

const tempDirs: string[] = [];
function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "rusa-doctor-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  while (tempDirs.length > 0) rmSync(tempDirs.pop() as string, { recursive: true, force: true });
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("checkCoordinatorPathDrift (#638)", () => {
  it("names every provider CLI the coordinator cannot resolve, sorted, when the instance PATH moved on", () => {
    const [result, ...rest] = checkCoordinatorPathDrift(
      deps({ [COORDINATOR]: BARE_PATH, [INSTANCE]: PROVIDER_PATH }),
      { providerCommands: { commands: ["kimi", "codex", "claude"] } }
    );

    expect(rest).toEqual([]);
    expect(result.status).toBe("warn");
    expect(result.message).toBe(
      `${COORDINATOR} PATH has drifted from ${INSTANCE}; provider CLI(s) the coordinator cannot resolve: claude, codex, kimi.`
    );
    expect(result.hint).toContain("rusa install-quota-coordinator");
    expect(result.probed).toEqual([
      `${COORDINATOR} PATH (systemd): ${BARE_PATH}`,
      `${INSTANCE} PATH (systemd): ${PROVIDER_PATH}`,
      "missing on coordinator: claude, codex, kimi",
    ]);
  });

  it("names a provider CLI that resolves only on the coordinator", () => {
    const [result] = checkCoordinatorPathDrift(
      deps({ [COORDINATOR]: PROVIDER_PATH, [INSTANCE]: BARE_PATH }),
      { providerCommands: { commands: ["codex"] } }
    );

    expect(result.status).toBe("warn");
    expect(result.message).toBe(
      `${COORDINATOR} PATH diverges from ${INSTANCE}; provider CLI(s) resolving only on the coordinator: codex.`
    );
    expect(result.probed).toContain("missing on instance: codex");
  });

  it("reports agreement as agreement", () => {
    const [result] = checkCoordinatorPathDrift(
      deps({ [COORDINATOR]: PROVIDER_PATH, [INSTANCE]: PROVIDER_PATH }),
      { providerCommands: { commands: ["codex"] } }
    );

    expect(result.status).toBe("pass");
    expect(result.message).toBe(`${COORDINATOR} and ${INSTANCE} assign the same PATH.`);
    expect(result.probed).toEqual([
      `${COORDINATOR} PATH (systemd): ${PROVIDER_PATH}`,
      `${INSTANCE} PATH (systemd): ${PROVIDER_PATH}`,
      "resolved on both: codex",
    ]);
  });

  it("passes when the PATHs differ but every provider CLI still resolves on both", () => {
    const [result] = checkCoordinatorPathDrift(
      deps({
        [COORDINATOR]: `/opt/providers/bin:${BARE_PATH}`,
        [INSTANCE]: `${BARE_PATH}:/opt/providers/bin`,
      }),
      { providerCommands: { commands: ["codex"] } }
    );

    expect(result.status).toBe("pass");
    expect(result.message).toBe(
      `${COORDINATOR} and ${INSTANCE} assign different PATHs, and every configured provider CLI resolves on both.`
    );
  });

  it("warns without naming a CLI when the provider list could not be determined and the PATHs differ", () => {
    const [result] = checkCoordinatorPathDrift(
      deps({ [COORDINATOR]: BARE_PATH, [INSTANCE]: PROVIDER_PATH }),
      { providerCommands: { unavailable: "Config file not found at /srv/rusa/config.yaml" } }
    );

    expect(result.status).toBe("warn");
    expect(result.message).toBe(
      `${COORDINATOR} PATH differs from ${INSTANCE}, and which provider CLIs to check could not be determined (Config file not found at /srv/rusa/config.yaml).`
    );
    expect(result.probed).toContain(
      "provider CLIs not checked: Config file not found at /srv/rusa/config.yaml"
    );
    expect(JSON.stringify(result)).not.toMatch(/codex|claude|kimi|agy/);
  });

  it("passes on identical PATHs even when the provider list could not be determined", () => {
    const [result] = checkCoordinatorPathDrift(
      deps({ [COORDINATOR]: PROVIDER_PATH, [INSTANCE]: PROVIDER_PATH }),
      { providerCommands: { unavailable: "config.yaml configures no providers" } }
    );

    expect(result.status).toBe("pass");
  });

  it("reports nothing to compare as info, not as a pass, when no coordinator is installed", () => {
    const results = checkCoordinatorPathDrift(deps({ [INSTANCE]: PROVIDER_PATH }), {
      providerCommands: { commands: ["codex"] },
    });

    expect(results).toEqual([
      {
        name: "quota coordinator PATH",
        status: "info",
        message: `no quota coordinator unit is installed (${COORDINATOR}, ${STAGING_COORDINATOR}); nothing to compare.`,
      },
    ]);
  });

  it("distinguishes a systemd that never answered from an absent coordinator", () => {
    const results = checkCoordinatorPathDrift(
      deps(
        {},
        { probeSystemdUnitPath: () => ({ answered: false, path: null }), readUnitFile: () => null }
      ),
      { providerCommands: { commands: ["codex"] } }
    );

    expect(results[0].status).toBe("info");
    expect(results[0].message).toBe(
      "cannot tell whether a quota coordinator is installed: the systemd user manager did not answer and no unit file was found."
    );
  });

  it("checks the environment-derived coordinator unit too, when that is the one installed", () => {
    const results = checkCoordinatorPathDrift(
      deps({ [STAGING_COORDINATOR]: BARE_PATH, [INSTANCE]: PROVIDER_PATH }),
      { providerCommands: { commands: ["codex"] } }
    );

    expect(results).toHaveLength(1);
    expect(results[0].status).toBe("warn");
    expect(results[0].message).toContain(`${STAGING_COORDINATOR} PATH has drifted`);
  });

  it("warns when the coordinator is installed and assigns no PATH", () => {
    const [result] = checkCoordinatorPathDrift(
      deps(
        { [INSTANCE]: PROVIDER_PATH },
        {
          readUnitFile: (unit) =>
            unit === COORDINATOR ? "[Service]\nExecStart=/usr/bin/node\n" : null,
        }
      ),
      { providerCommands: { commands: ["codex"] } }
    );

    expect(result.status).toBe("warn");
    expect(result.message).toBe(`${COORDINATOR} is installed but assigns no PATH.`);
  });

  it("warns when no instance unit assigns a PATH to compare against", () => {
    const [result] = checkCoordinatorPathDrift(deps({ [COORDINATOR]: PROVIDER_PATH }), {
      providerCommands: { commands: ["codex"] },
    });

    expect(result.status).toBe("warn");
    expect(result.message).toBe(
      `${COORDINATOR} is installed, but no instance unit assigns a PATH to compare it against (rusa.service, rusa-staging.service).`
    );
  });

  it("falls back to the unit files on disk when the systemd user manager cannot answer", () => {
    const unitDir = tempDir();
    writeFileSync(
      join(unitDir, COORDINATOR),
      `[Service]\nEnvironment=PATH=${BARE_PATH}\nExecStart=/usr/bin/node\n`
    );
    writeFileSync(
      join(unitDir, INSTANCE),
      `[Service]\nEnvironment=PATH=${PROVIDER_PATH}\nExecStart=/usr/bin/node\n`
    );

    const [result] = checkCoordinatorPathDrift(
      {
        ...defaultCoordinatorPathDriftDeps(unitDir),
        probeSystemdUnitPath: () => ({ answered: false, path: null }),
        resolveExecutable: (command, pathEnv) =>
          pathEnv.includes("/opt/providers/bin") ? `/opt/providers/bin/${command}` : null,
      },
      { providerCommands: { commands: ["codex"] } }
    );

    expect(result.status).toBe("warn");
    expect(result.probed).toEqual([
      `${COORDINATOR} PATH (unit file): ${BARE_PATH}`,
      `${INSTANCE} PATH (unit file): ${PROVIDER_PATH}`,
      "missing on coordinator: codex",
    ]);
  });
});

describe("resolveProviderCommands", () => {
  it("reads the configured provider CLIs from RUSA_HOME when no home is passed", () => {
    const home = tempDir();
    writeFileSync(
      join(home, "config.yaml"),
      configYaml("  claude: {}\n  codex:\n    cliCommand: codex-cli\n")
    );
    vi.stubEnv("RUSA_HOME", home);

    expect(resolveProviderCommands()).toEqual({ commands: ["claude", "codex-cli"] });
  });

  it("reports why the provider CLIs are unknown rather than guessing them", () => {
    const home = tempDir();

    expect(resolveProviderCommands(home)).toEqual({
      unavailable: `Config file not found at ${join(home, "config.yaml")}. Run 'rusa init' first.`,
    });
  });
});

describe("runDoctor", () => {
  it("runs from the configured home with no repo checkout and prints the report", () => {
    const home = tempDir();
    writeFileSync(join(home, "config.yaml"), configYaml("  codex: {}\n", "codex"));
    vi.stubEnv("RUSA_HOME", home);
    const log = vi.spyOn(console, "log").mockImplementation(() => {});

    const results = runDoctor({
      deps: deps({ [COORDINATOR]: BARE_PATH, [INSTANCE]: PROVIDER_PATH }),
    });

    expect(results.map((result) => result.status)).toEqual(["warn"]);
    expect(log.mock.calls[0][0]).toContain("[rusa] Doctor:");
    expect(log.mock.calls[0][0]).toContain("missing on coordinator: codex");
  });
});
