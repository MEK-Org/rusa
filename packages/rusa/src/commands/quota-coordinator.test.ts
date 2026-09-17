import { existsSync, mkdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { RusaConfig } from "../config/types.js";
import { QuotaCoordinatorService } from "../quota/coordinator-service.js";
import { DEFAULT_OLD_QUOTA_DB_NAME, DEFAULT_RELOCATED_QUOTA_DB_NAME } from "../quota/relocate.js";
import { coordinatorProviderLanes, runQuotaCoordinator } from "./quota-coordinator.js";

const testDirs: string[] = [];

afterEach(() => {
  vi.restoreAllMocks();
  for (const dir of testDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("coordinatorProviderLanes", () => {
  it("preserves configured read lanes while collecting only supported probes", () => {
    const config = {
      providers: {
        claude: { cliCommand: "claude" },
        experimental: { cliCommand: "experimental" },
      },
    } as unknown as RusaConfig;

    expect(coordinatorProviderLanes(config)).toEqual({
      configuredProviders: ["claude", "experimental"],
      collectionProviders: ["claude"],
    });
  });

  it("keeps the established all-provider default when no provider is configured", () => {
    expect(coordinatorProviderLanes({ providers: {} } as unknown as RusaConfig)).toEqual({
      configuredProviders: undefined,
      collectionProviders: ["claude", "codex", "agy", "kimi"],
    });
  });
});

describe("runQuotaCoordinator startup relocation", () => {
  it("requires the explicit stage-3 flag before relocating quota.db", async () => {
    const home = join(
      tmpdir(),
      `rusa-coord-test-${Date.now()}-${Math.random().toString(36).slice(2)}`
    );
    mkdirSync(join(home, "data"), { recursive: true });
    testDirs.push(home);

    const oldDbPath = join(home, "data", DEFAULT_OLD_QUOTA_DB_NAME);
    const newDbPath = join(home, "data", DEFAULT_RELOCATED_QUOTA_DB_NAME);

    // Create legacy database at old path
    const db = new Database(oldDbPath);
    db.exec("CREATE TABLE test (id INTEGER PRIMARY KEY);");
    db.close();

    expect(existsSync(oldDbPath)).toBe(true);
    expect(statSync(oldDbPath).isFile()).toBe(true);

    // Write minimal config
    writeFileSync(
      join(home, "config.yaml"),
      `
github:
  account: mock-bot
rootActor:
  provider: claude
  model: claude-3-5-sonnet
providers:
  claude:
    cliCommand: claude
quota:
  databasePath: ${oldDbPath}
`
    );

    await expect(runQuotaCoordinator({ home })).rejects.toThrow(/pre-service database/);
    expect(statSync(oldDbPath).isFile()).toBe(true);
    expect(existsSync(newDbPath)).toBe(false);

    // A service-owned target is supplied only for the explicit flip.
    writeFileSync(
      join(home, "config.yaml"),
      `
github:
  account: mock-bot
rootActor:
  provider: claude
  model: claude-3-5-sonnet
providers:
  claude:
    cliCommand: claude
quota:
  databasePath: ${oldDbPath}
  coordinator:
    socketPath: ${join(home, "coordinator.sock")}
    databasePath: ${newDbPath}
`
    );

    // Intercept service startup to avoid running a listener while characterizing
    // the pre-flip path selection.
    vi.spyOn(QuotaCoordinatorService.prototype, "start").mockImplementation(async () => {
      throw new Error("test-abort-after-startup");
    });

    await expect(
      runQuotaCoordinator({
        home,
        relocate: true,
      })
    ).rejects.toThrow("test-abort-after-startup");

    // Relocation occurred:
    expect(existsSync(newDbPath)).toBe(true);
    expect(statSync(newDbPath).isFile()).toBe(true);
    expect(existsSync(oldDbPath)).toBe(true);
    expect(statSync(oldDbPath).isDirectory()).toBe(true);
  });

  it("fences the configured custom legacy path, never a quota.db sibling", async () => {
    const home = join(
      tmpdir(),
      `rusa-coord-relocate-flag-${Date.now()}-${Math.random().toString(36).slice(2)}`
    );
    mkdirSync(join(home, "data"), { recursive: true });
    testDirs.push(home);

    const oldDbPath = join(home, "data", "legacy-shared.sqlite");
    const newDbPath = join(home, "data", "custom-relocated.db");
    const unrelatedDefaultPath = join(home, "data", DEFAULT_OLD_QUOTA_DB_NAME);

    const db = new Database(oldDbPath);
    db.exec("CREATE TABLE custom (val TEXT);");
    db.close();

    writeFileSync(
      join(home, "config.yaml"),
      `
github:
  account: mock-bot
rootActor:
  provider: claude
  model: claude-3-5-sonnet
providers:
  claude:
    cliCommand: claude
quota:
  databasePath: ${oldDbPath}
  coordinator:
    socketPath: ${join(home, "coordinator.sock")}
    databasePath: ${newDbPath}
`
    );

    vi.spyOn(QuotaCoordinatorService.prototype, "start").mockImplementation(async () => {
      throw new Error("test-abort-flag");
    });

    await expect(
      runQuotaCoordinator({
        home,
        relocate: true,
      })
    ).rejects.toThrow("test-abort-flag");

    expect(existsSync(newDbPath)).toBe(true);
    expect(statSync(newDbPath).isFile()).toBe(true);
    expect(statSync(oldDbPath).isDirectory()).toBe(true);
    expect(existsSync(unrelatedDefaultPath)).toBe(false);
  });
});
