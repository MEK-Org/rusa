import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { RusaConfig } from "../config/types.js";
import { buildTmuxScript } from "../providers/codex-status-scrape.js";
import { POOL_CLIENT_UNITS } from "./coordinator-provisioning.js";
import {
  buildQuotaCoordinatorUnit,
  configuredProviderCommands,
  describePoolProbePathSource,
  describeProbePathSource,
} from "./install-service.js";
import { readUnitPathEnv, resolveProbePathEnv } from "./service-instance.js";

/**
 * Issue #525, end to end across the boundary that actually broke.
 *
 * The coordinator process starting proves nothing here: its `ExecStart` is an
 * absolute Node path, so it starts, answers `healthz`, and only the scrape
 * fails. The failure is one level down — the probe hands a bare command name to
 * `tmux new-session`, and tmux resolves it against the PATH the *unit* gave the
 * service. So these tests run the real generated bash against a fake `tmux`
 * that reports whether the provider CLI resolved, and assert on the scrape
 * outcome rather than on the unit's text.
 */
const FAKE_TMUX = [
  "#!/usr/bin/env bash",
  "set -u",
  'STATE="$FAKE_TMUX_STATE"',
  // The tmux subcommand is the 3rd arg (after `-S <sock>`).
  'sub="$3"',
  'case "$sub" in',
  "  kill-server) exit 0 ;;",
  "  new-session)",
  // The command to run in the session is the last argument; walking "$@" reads it
  // without a ${...} expansion. Resolving it is exactly what the real tmux does,
  // and exactly what failed in #525.
  '    cli=""',
  '    for a in "$@"; do cli="$a"; done',
  '    if command -v "$cli" >/dev/null 2>&1; then',
  '      command -v "$cli" > "$STATE/resolved"',
  "    else",
  '      printf "%s" "$cli" > "$STATE/unresolved"',
  "    fi",
  "    exit 0 ;;",
  "  send-keys) exit 0 ;;",
  "  capture-pane)",
  // The banner renders either way: a provider CLI that cannot be launched still
  // leaves a session, which is why this failure looks like "never rendered"
  // rather than "no such command".
  "    printf 'OpenAI Codex\\n'",
  '    if [ -f "$STATE/resolved" ]; then',
  "      printf '5h limit: 1%% used\\nWeekly limit: 7%% used\\n'",
  "    fi",
  "    exit 0 ;;",
  "esac",
  "exit 0",
].join("\n");

// Small enough to keep the failing case quick; the script's own defaults would
// spend 80s burning its retry budget.
const FAST_TIMING = { budgetS: 4, attemptSecs: 1, backoffSecs: 1, bannerTries: 3 } as const;

describe("the quota coordinator's probe PATH reaches the tmux-launched CLI (#525)", () => {
  let dir: string;
  let providerBin: string;
  let tmuxBin: string;
  let state: string;
  const originalPath = process.env.PATH;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "rusa-coordinator-probe-"));
    providerBin = join(dir, "provider-bin");
    tmuxBin = join(dir, "tmux-bin");
    state = join(dir, "state");
    for (const d of [providerBin, tmuxBin, state]) mkdirSync(d);
    writeFileSync(join(providerBin, "codex"), "#!/bin/sh\nsleep 30\n", { mode: 0o755 });
    writeFileSync(join(tmuxBin, "tmux"), FAKE_TMUX, { mode: 0o755 });

    // The installing shell can reach tmux but NOT the provider CLI. That is the
    // reported environment: the unit started, and `command -v codex` under it
    // returned nothing.
    process.env.PATH = `${tmuxBin}:/usr/bin:/bin`;
  });

  afterEach(() => {
    process.env.PATH = originalPath;
    rmSync(dir, { recursive: true, force: true });
  });

  function instanceUnitWithProviders(): string {
    return [
      "[Service]",
      "Type=simple",
      `Environment=PATH=${providerBin}:${tmuxBin}:/usr/bin:/bin`,
      "Restart=always",
      "",
    ].join("\n");
  }

  function coordinatorUnitPath(instanceUnit: string | null): string {
    // systemd is stubbed out so these run the same on a host without a user
    // manager; the drop-in-aware path has its own tests in service-instance.
    const probePath = resolveProbePathEnv("rusa-staging.service", instanceUnit, () => null);
    const unit = buildQuotaCoordinatorUnit({
      description: "Rusa Quota Coordinator",
      mcHome: join(dir, "home"),
      cliPath: "/opt/rusa/dist/cli.js",
      nodePath: "/usr/bin/node",
      userPath: probePath.path,
      xdgRuntimeDir: "/run/user/1000",
    });
    const fromUnit = readUnitPathEnv(unit);
    expect(fromUnit).not.toBeNull();
    return fromUnit as string;
  }

  /** Run the real generated probe script with the PATH the unit would give it. */
  function runProbe(pathEnv: string) {
    const script = buildTmuxScript("codex", join(dir, "probe.sock"), FAST_TIMING);
    const res = spawnSync("bash", ["-c", script], {
      encoding: "utf-8",
      env: { ...process.env, PATH: pathEnv, FAKE_TMUX_STATE: state },
    });
    const read = (name: string) => {
      try {
        return readFileSync(join(state, name), "utf-8");
      } catch {
        return null;
      }
    };
    return {
      code: res.status,
      stdout: res.stdout ?? "",
      stderr: res.stderr ?? "",
      resolved: read("resolved"),
      unresolved: read("unresolved"),
    };
  }

  it("scrapes when the coordinator PATH is derived from the installed instance unit", () => {
    const pathEnv = coordinatorUnitPath(instanceUnitWithProviders());

    const probe = runProbe(pathEnv);

    expect(probe.unresolved).toBeNull();
    expect(probe.resolved?.trim()).toBe(join(providerBin, "codex"));
    expect(probe.code).toBe(0);
    expect(probe.stdout).toContain("5h limit");
  });

  it("is the failure #525 reported when the PATH comes from a minimal installing shell", () => {
    // No instance unit to derive from, so the installer falls back to its own
    // environment — which is how the broken unit was produced. Asserting the
    // failure here keeps the passing case above from being vacuous.
    const pathEnv = coordinatorUnitPath(null);

    const probe = runProbe(pathEnv);

    expect(probe.resolved).toBeNull();
    expect(probe.unresolved).toBe("codex");
    expect(probe.code).toBe(1);
    expect(probe.stderr).toContain("/status panel never rendered");
  });

  it("carries every configured provider CLI, not just the one that was reported", () => {
    const config = {
      providers: {
        codex: { cliCommand: "codex" },
        claude: { cliCommand: "claude" },
        // No cliCommand: the key is the command, which is what the scrapers assume.
        kimi: {},
      },
    } as unknown as RusaConfig;

    expect(configuredProviderCommands(config)).toEqual(["codex", "claude", "kimi"]);
  });

  describe("describeProbePathSource", () => {
    const unit = "rusa-staging.service";

    it("does not claim the instance unit is absent when it is installed but assigns no PATH", () => {
      // A host upgrading from an older instance unit lands here: the coordinator
      // gets built from the installing shell's PATH — the #525 failure exactly —
      // and telling the operator the unit is missing sends them looking for a
      // file that is sitting right there.
      const line = describeProbePathSource({ path: "/usr/bin", source: "process" }, unit, true);

      expect(line).not.toContain("installed yet");
      expect(line).toContain("assigns no PATH of its own");
    });

    it("says the unit is absent only when it actually is", () => {
      expect(
        describeProbePathSource({ path: "/usr/bin", source: "process" }, unit, false)
      ).toContain(`no ${unit} installed yet`);
    });

    it("distinguishes the systemd-resolved PATH from the unit text alone", () => {
      expect(
        describeProbePathSource({ path: "/a", source: "instance-unit-systemd" }, unit, true)
      ).toContain("drop-ins included");
      expect(
        describeProbePathSource({ path: "/a", source: "instance-unit-file" }, unit, true)
      ).toContain("drop-in PATH was not seen");
    });
  });

  describe("describePoolProbePathSource", () => {
    it("names the client unit the PATH was actually borrowed from", () => {
      // The pool coordinator has no instance unit of its own (#507), so the
      // line has to name the donor rather than a unit fixed in advance.
      expect(
        describePoolProbePathSource(
          { path: "/opt/providers/bin", source: "instance-unit-systemd" },
          "rusa-staging.service",
          ["rusa.service", "rusa-staging.service"]
        )
      ).toBe("taken from rusa-staging.service as systemd resolves it (drop-ins included)");
    });

    it("does not claim no client is installed when one is but supplies no PATH", () => {
      const line = describePoolProbePathSource({ path: "/usr/bin", source: "process" }, null, [
        "rusa.service",
      ]);

      expect(line).not.toContain("installed yet");
      expect(line).toContain("none of rusa.service assigns a PATH of its own");
    });

    it("says no client is installed only when none is", () => {
      const line = describePoolProbePathSource({ path: "/usr/bin", source: "process" }, null, []);

      expect(line).toContain("no pool client unit installed yet");
      for (const unit of POOL_CLIENT_UNITS) expect(line).toContain(unit);
    });
  });
});
