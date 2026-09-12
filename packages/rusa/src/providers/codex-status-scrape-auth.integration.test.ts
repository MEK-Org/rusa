import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
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

describe("Codex status scrape auth refresh lifecycle (issue #435)", () => {
  let tempRoot: string;
  let hostCodexDir: string;
  let actorDir: string;
  let cliScriptPath: string;

  beforeEach(() => {
    tempRoot = mkdtempSync(join(tmpdir(), "rusa-scrape-auth-test-"));
    hostCodexDir = join(tempRoot, "host-codex");
    actorDir = join(tempRoot, "actor-workdir");
    mkdirSync(hostCodexDir, { recursive: true });
    mkdirSync(actorDir, { recursive: true });

    // Seed initial host fixture auth and config
    writeFileSync(join(hostCodexDir, "auth.json"), FIXTURE_INITIAL_AUTH, { mode: 0o600 });
    writeFileSync(
      join(hostCodexDir, "config.toml"),
      'model = "o3"\n[features]\nweb_search = true\n',
      { mode: 0o600 }
    );

    // Create a fake codex CLI script that simulates credential refresh during startup / requests
    cliScriptPath = join(tempRoot, "fake-codex.sh");
    writeFileSync(
      cliScriptPath,
      `#!/usr/bin/env bash
set -u

# Emit banner to satisfy TUI-ready poll
printf 'OpenAI Codex\\n'

# If replacement auth is configured, simulate credential refresh by writing to $CODEX_HOME/auth.json
if [ -n "\${REFRESH_PAYLOAD:-}" ] && [ -n "\${CODEX_HOME:-}" ]; then
  printf "%s\\n" "$REFRESH_PAYLOAD" > "$CODEX_HOME/auth.json"
fi

case "\${SCENARIO:-normal}" in
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
  });

  afterEach(() => {
    rmSync(tempRoot, { recursive: true, force: true });
  });

  it("persists refreshed credentials to the host auth file across normal cleanup", async () => {
    const origEnv = process.env.REFRESH_PAYLOAD;
    const origScenario = process.env.SCENARIO;
    try {
      process.env.REFRESH_PAYLOAD = FIXTURE_REFRESHED_AUTH_SUCCESS;
      process.env.SCENARIO = "normal";

      const output = await scrapeCodexStatus({
        actorDir,
        codexConfigDir: hostCodexDir,
        cliCommand: cliScriptPath,
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
    } finally {
      if (origEnv === undefined) delete process.env.REFRESH_PAYLOAD;
      else process.env.REFRESH_PAYLOAD = origEnv;
      if (origScenario === undefined) delete process.env.SCENARIO;
      else process.env.SCENARIO = origScenario;
    }
  }, 30_000);

  it("persists refreshed credentials to the host auth file when the scrape fails", async () => {
    const origEnv = process.env.REFRESH_PAYLOAD;
    const origScenario = process.env.SCENARIO;
    try {
      process.env.REFRESH_PAYLOAD = FIXTURE_REFRESHED_AUTH_FAILURE;
      process.env.SCENARIO = "fail";

      await expect(
        scrapeCodexStatus({
          actorDir,
          codexConfigDir: hostCodexDir,
          cliCommand: cliScriptPath,
          timeoutMs: 15_000,
        })
      ).rejects.toThrow();

      // Even though the scrape failed, credentials refreshed before failure must persist
      const hostAuthContent = readFileSync(join(hostCodexDir, "auth.json"), "utf8");
      expect(JSON.parse(hostAuthContent)).toEqual(JSON.parse(FIXTURE_REFRESHED_AUTH_FAILURE));
    } finally {
      if (origEnv === undefined) delete process.env.REFRESH_PAYLOAD;
      else process.env.REFRESH_PAYLOAD = origEnv;
      if (origScenario === undefined) delete process.env.SCENARIO;
      else process.env.SCENARIO = origScenario;
    }
  }, 30_000);

  it("persists refreshed credentials to the host auth file when the scrape times out", async () => {
    const origEnv = process.env.REFRESH_PAYLOAD;
    const origScenario = process.env.SCENARIO;
    try {
      process.env.REFRESH_PAYLOAD = FIXTURE_REFRESHED_AUTH_TIMEOUT;
      process.env.SCENARIO = "timeout";

      await expect(
        scrapeCodexStatus({
          actorDir,
          codexConfigDir: hostCodexDir,
          cliCommand: cliScriptPath,
          timeoutMs: 1_500,
        })
      ).rejects.toThrow(/timed out/);

      // Even on timeout, credentials refreshed before timeout must persist
      const hostAuthContent = readFileSync(join(hostCodexDir, "auth.json"), "utf8");
      expect(JSON.parse(hostAuthContent)).toEqual(JSON.parse(FIXTURE_REFRESHED_AUTH_TIMEOUT));
    } finally {
      if (origEnv === undefined) delete process.env.REFRESH_PAYLOAD;
      else process.env.REFRESH_PAYLOAD = origEnv;
      if (origScenario === undefined) delete process.env.SCENARIO;
      else process.env.SCENARIO = origScenario;
    }
  }, 30_000);

  it("persists refreshed credentials to the host auth file when the scrape is cancelled via AbortSignal", async () => {
    const origEnv = process.env.REFRESH_PAYLOAD;
    const origScenario = process.env.SCENARIO;
    try {
      process.env.REFRESH_PAYLOAD = FIXTURE_REFRESHED_AUTH_ABORT;
      process.env.SCENARIO = "hang";

      const controller = new AbortController();
      setTimeout(() => controller.abort(), 600);

      await expect(
        scrapeCodexStatus({
          actorDir,
          codexConfigDir: hostCodexDir,
          cliCommand: cliScriptPath,
          timeoutMs: 15_000,
          signal: controller.signal,
        })
      ).rejects.toThrow(/aborted/);

      // Even on abort/cancellation, credentials refreshed before cancellation must persist
      const hostAuthContent = readFileSync(join(hostCodexDir, "auth.json"), "utf8");
      expect(JSON.parse(hostAuthContent)).toEqual(JSON.parse(FIXTURE_REFRESHED_AUTH_ABORT));
    } finally {
      if (origEnv === undefined) delete process.env.REFRESH_PAYLOAD;
      else process.env.REFRESH_PAYLOAD = origEnv;
      if (origScenario === undefined) delete process.env.SCENARIO;
      else process.env.SCENARIO = origScenario;
    }
  }, 30_000);
});
