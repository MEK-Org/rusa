import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { configureCodexHome } from "./codex-home.js";
import { scrapeCodexStatus } from "./codex-status-scrape.js";

const FIXTURE_INITIAL_AUTH = JSON.stringify({
  auth_mode: "chatgpt",
  tokens: {
    access_token: "fixture-initial-access-token",
    refresh_token: "fixture-initial-refresh-token",
    account_id: "fixture-account-id",
  },
});

const FIXTURE_REFRESHED_AUTH_SUCCESS = JSON.stringify({
  auth_mode: "chatgpt",
  tokens: {
    access_token: "fixture-refreshed-access-token-success",
    refresh_token: "fixture-refreshed-refresh-token-success",
    account_id: "fixture-account-id",
  },
});

const FIXTURE_REFRESHED_AUTH_FAILURE = JSON.stringify({
  auth_mode: "chatgpt",
  tokens: {
    access_token: "fixture-refreshed-access-token-failure",
    refresh_token: "fixture-refreshed-refresh-token-failure",
    account_id: "fixture-account-id",
  },
});

const FIXTURE_REFRESHED_AUTH_TIMEOUT = JSON.stringify({
  auth_mode: "chatgpt",
  tokens: {
    access_token: "fixture-refreshed-access-token-timeout",
    refresh_token: "fixture-refreshed-refresh-token-timeout",
    account_id: "fixture-account-id",
  },
});

const FIXTURE_REFRESHED_AUTH_ABORT = JSON.stringify({
  auth_mode: "chatgpt",
  tokens: {
    access_token: "fixture-refreshed-access-token-abort",
    refresh_token: "fixture-refreshed-refresh-token-abort",
    account_id: "fixture-account-id",
  },
});

type FakeScenario = "normal" | "fail" | "timeout" | "hang";

interface FakeCliOptions {
  payload: string;
  scenario: FakeScenario;
  authWriteMode?: "in-place" | "replace";
}

/** Single-quote a value for embedding in a bash script. */
function shq(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

describe("Codex status scrape auth refresh lifecycle (issue #435)", () => {
  let tempRoot: string;
  let hostCodexDir: string;
  let actorDir: string;
  let helpLogPath: string;

  /**
   * Write a fake codex CLI with its behaviour baked in. It never reads the
   * payload or scenario from the ambient environment, and it only simulates a
   * credential refresh when `$CODEX_HOME/auth.json` is the scrape's symlink to
   * THIS test's fixture store. An inherited `CODEX_HOME` (inside a Codex sandbox,
   * the writable live `auth.json` bind) can therefore never be written (#781).
   */
  function writeFakeCli(opts: FakeCliOptions): string {
    const cliScriptPath = join(tempRoot, "fake-codex.sh");
    writeFileSync(
      cliScriptPath,
      `#!/usr/bin/env bash
set -u
FIXTURE_AUTH=${shq(resolve(hostCodexDir, "auth.json"))}
HELP_LOG=${shq(helpLogPath)}
PAYLOAD=${shq(opts.payload)}
SCENARIO=${shq(opts.scenario)}
AUTH_WRITE_MODE=${shq(opts.authWriteMode ?? "in-place")}

# Capability probe: record which home it ran under; never touch credentials.
if [ "\${1:-}" = "--help" ]; then
  printf '%s\\n' "\${CODEX_HOME:-}" >> "$HELP_LOG"
  printf 'Usage: codex [OPTIONS]\\n'
  exit 0
fi

# Emit banner to satisfy TUI-ready poll
printf 'OpenAI Codex\\n'

# Simulate Codex's current in-place credential write, or a future atomic replacement,
# only through the isolated home's symlink to this test's fixture store.
if [ -n "\${CODEX_HOME:-}" ] && [ "$(readlink "$CODEX_HOME/auth.json")" = "$FIXTURE_AUTH" ]; then
  if [ "$AUTH_WRITE_MODE" = "replace" ]; then
    replacement=$(mktemp "$CODEX_HOME/auth.XXXXXX")
    printf "%s\\n" "$PAYLOAD" > "$replacement"
    mv "$replacement" "$CODEX_HOME/auth.json"
  else
    printf "%s\\n" "$PAYLOAD" > "$CODEX_HOME/auth.json"
  fi
fi

case "$SCENARIO" in
  fail)
    exit 1
    ;;
  timeout|hang)
    sleep 30
    exit 0
    ;;
  normal)
    # Output limits panel to satisfy /status attempt
    sleep 0.2
    printf '5h limit: 1%% used\\nWeekly limit: 5%% used\\n'
    sleep 30
    exit 0
    ;;
esac
`,
      { mode: 0o755 }
    );
    return cliScriptPath;
  }

  beforeEach(() => {
    tempRoot = mkdtempSync(join(tmpdir(), "rusa-scrape-auth-test-"));
    hostCodexDir = join(tempRoot, "host-codex");
    actorDir = join(tempRoot, "actor-workdir");
    helpLogPath = join(tempRoot, "help-codex-homes.log");
    mkdirSync(hostCodexDir, { recursive: true });
    mkdirSync(actorDir, { recursive: true });

    // Seed initial host fixture auth and config
    writeFileSync(join(hostCodexDir, "auth.json"), FIXTURE_INITIAL_AUTH, { mode: 0o600 });
    writeFileSync(
      join(hostCodexDir, "config.toml"),
      'model = "o3"\n[features]\nweb_search = true\n',
      { mode: 0o600 }
    );
  });

  afterEach(() => {
    rmSync(tempRoot, { recursive: true, force: true });
  });

  it("persists refreshed credentials to the host auth file across normal cleanup", async () => {
    const output = await scrapeCodexStatus({
      actorDir,
      codexConfigDir: hostCodexDir,
      cliCommand: writeFakeCli({ payload: FIXTURE_REFRESHED_AUTH_SUCCESS, scenario: "normal" }),
      timeoutMs: 15_000,
    });

    expect(output).toContain("5h limit:");

    // Verify host auth file retains the refreshed credentials
    const hostAuthContent = readFileSync(join(hostCodexDir, "auth.json"), "utf8");
    expect(JSON.parse(hostAuthContent)).toEqual(JSON.parse(FIXTURE_REFRESHED_AUTH_SUCCESS));

    // Verify host config was not polluted by probe-specific project trust
    const hostConfigContent = readFileSync(join(hostCodexDir, "config.toml"), "utf8");
    expect(hostConfigContent).not.toContain(actorDir);
    expect(hostConfigContent).toContain('model = "o3"');
  }, 30_000);

  it("persists refreshed credentials to a configured Codex home without a test seam (#782)", async () => {
    configureCodexHome(hostCodexDir);
    try {
      const output = await scrapeCodexStatus({
        actorDir,
        cliCommand: writeFakeCli({ payload: FIXTURE_REFRESHED_AUTH_SUCCESS, scenario: "normal" }),
        timeoutMs: 15_000,
      });
      expect(output).toContain("5h limit:");
    } finally {
      configureCodexHome(undefined);
    }

    const hostAuthContent = readFileSync(join(hostCodexDir, "auth.json"), "utf8");
    expect(JSON.parse(hostAuthContent)).toEqual(JSON.parse(FIXTURE_REFRESHED_AUTH_SUCCESS));
    expect(readFileSync(join(hostCodexDir, "config.toml"), "utf8")).not.toContain(actorDir);
  }, 30_000);

  it("never runs a Codex process against an inherited CODEX_HOME (issue #781)", async () => {
    const ambientHome = join(tempRoot, "ambient-live-codex-home");
    mkdirSync(ambientHome, { recursive: true });
    const ambientAuth = join(ambientHome, "auth.json");
    writeFileSync(ambientAuth, FIXTURE_INITIAL_AUTH, { mode: 0o600 });

    const origCodexHome = process.env.CODEX_HOME;
    process.env.CODEX_HOME = ambientHome;
    try {
      await scrapeCodexStatus({
        actorDir,
        codexConfigDir: hostCodexDir,
        cliCommand: writeFakeCli({ payload: FIXTURE_REFRESHED_AUTH_SUCCESS, scenario: "normal" }),
        timeoutMs: 15_000,
      });
    } finally {
      if (origCodexHome === undefined) delete process.env.CODEX_HOME;
      else process.env.CODEX_HOME = origCodexHome;
    }

    // The capability probe ran under the isolated throwaway home, not the ambient one.
    const probedHomes = readFileSync(helpLogPath, "utf8").trim().split("\n");
    expect(probedHomes).toHaveLength(1);
    expect(probedHomes[0]).not.toBe(ambientHome);
    expect(probedHomes[0]).toContain("rusa-codex-status-");

    // The ambient store is untouched; the refresh landed in the configured store.
    expect(readFileSync(ambientAuth, "utf8")).toBe(FIXTURE_INITIAL_AUTH);
    const hostAuthContent = readFileSync(join(hostCodexDir, "auth.json"), "utf8");
    expect(JSON.parse(hostAuthContent)).toEqual(JSON.parse(FIXTURE_REFRESHED_AUTH_SUCCESS));
  }, 30_000);

  it("rejects an atomic replacement of the required shared auth symlink", async () => {
    await expect(
      scrapeCodexStatus({
        actorDir,
        codexConfigDir: hostCodexDir,
        cliCommand: writeFakeCli({
          payload: FIXTURE_REFRESHED_AUTH_SUCCESS,
          scenario: "normal",
          authWriteMode: "replace",
        }),
        timeoutMs: 15_000,
      })
    ).rejects.toThrow(/replaced the required shared auth symlink/);

    // The host store must remain untouched rather than silently losing the replacement.
    const hostAuthContent = readFileSync(join(hostCodexDir, "auth.json"), "utf8");
    expect(JSON.parse(hostAuthContent)).toEqual(JSON.parse(FIXTURE_INITIAL_AUTH));
  }, 30_000);

  it("persists refreshed credentials to the host auth file when the scrape fails", async () => {
    await expect(
      scrapeCodexStatus({
        actorDir,
        codexConfigDir: hostCodexDir,
        cliCommand: writeFakeCli({ payload: FIXTURE_REFRESHED_AUTH_FAILURE, scenario: "fail" }),
        timeoutMs: 15_000,
      })
    ).rejects.toThrow();

    // Even though the scrape failed, credentials refreshed before failure must persist
    const hostAuthContent = readFileSync(join(hostCodexDir, "auth.json"), "utf8");
    expect(JSON.parse(hostAuthContent)).toEqual(JSON.parse(FIXTURE_REFRESHED_AUTH_FAILURE));
  }, 30_000);

  it("persists refreshed credentials to the host auth file when the scrape times out", async () => {
    await expect(
      scrapeCodexStatus({
        actorDir,
        codexConfigDir: hostCodexDir,
        cliCommand: writeFakeCli({ payload: FIXTURE_REFRESHED_AUTH_TIMEOUT, scenario: "timeout" }),
        timeoutMs: 1_500,
      })
    ).rejects.toThrow(/timed out/);

    // Even on timeout, credentials refreshed before timeout must persist
    const hostAuthContent = readFileSync(join(hostCodexDir, "auth.json"), "utf8");
    expect(JSON.parse(hostAuthContent)).toEqual(JSON.parse(FIXTURE_REFRESHED_AUTH_TIMEOUT));
  }, 30_000);

  it("persists refreshed credentials to the host auth file when the scrape is cancelled via AbortSignal", async () => {
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 600);

    await expect(
      scrapeCodexStatus({
        actorDir,
        codexConfigDir: hostCodexDir,
        cliCommand: writeFakeCli({ payload: FIXTURE_REFRESHED_AUTH_ABORT, scenario: "hang" }),
        timeoutMs: 15_000,
        signal: controller.signal,
      })
    ).rejects.toThrow(/aborted/);

    // Even on abort/cancellation, credentials refreshed before cancellation must persist
    const hostAuthContent = readFileSync(join(hostCodexDir, "auth.json"), "utf8");
    expect(JSON.parse(hostAuthContent)).toEqual(JSON.parse(FIXTURE_REFRESHED_AUTH_ABORT));
  }, 30_000);
});
