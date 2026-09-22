import { existsSync, mkdirSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import http from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { RusaConfig } from "../config/types.js";
import type { ProviderQuotaSnapshot } from "../mcp/quota-mcp.js";
import { QuotaCollectionLoop } from "../quota/coordinator-collection.js";
import { QuotaCoordinatorService } from "../quota/coordinator-service.js";
import { DEFAULT_OLD_QUOTA_DB_NAME, DEFAULT_RELOCATED_QUOTA_DB_NAME } from "../quota/relocate.js";
import { SharedQuotaStore } from "../quota/shared-store.js";
import {
  coordinatorProviderLanes,
  runQuotaCoordinator,
  startQuotaCoordinator,
} from "./quota-coordinator.js";

const testDirs: string[] = [];

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  for (const dir of testDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function request(socketPath: string, path: string): Promise<{ status: number; json: unknown }> {
  return new Promise((resolve, reject) => {
    const req = http.request({ socketPath, path }, (res) => {
      let body = "";
      res.on("data", (chunk) => {
        body += chunk;
      });
      res.on("end", () => {
        resolve({ status: res.statusCode ?? 0, json: JSON.parse(body) as unknown });
      });
    });
    req.on("error", reject);
    req.end();
  });
}

function seedQuotaSnapshot(databasePath: string): void {
  const store = new SharedQuotaStore(databasePath);
  try {
    const scrapedAt = new Date().toISOString();
    const state: ProviderQuotaSnapshot = {
      provider: "claude",
      status: "available",
      scrapedAt,
      limits: [
        {
          label: "Weekly",
          kind: "weekly",
          scope: "provider",
          percentLeft: 60,
          resetAtIso: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString(),
        },
      ],
    };
    const id = store.recordRaw({ provider: "claude", scrapedAt, rawOutput: "seeded" });
    store.recordParsed(id, state, state);
    store.advancePendingController({ maxIntervalSeconds: 3600 });
  } finally {
    store.close();
  }
}

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

describe("probe-off rollout mode", () => {
  it("starts the real read and operations service on seeded data without probes or controller writes", async () => {
    const home = join(
      tmpdir(),
      `rusa-coord-probe-off-${Date.now()}-${Math.random().toString(36).slice(2)}`
    );
    const databasePath = join(home, "data", "quota-coordinator.db");
    const socketPath = join(home, "coordinator.sock");
    const backupDir = join(home, "backups");
    mkdirSync(join(home, "data"), { recursive: true });
    testDirs.push(home);
    seedQuotaSnapshot(databasePath);
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
  coordinator:
    socketPath: ${socketPath}
    databasePath: ${databasePath}
    backupDir: ${backupDir}
`
    );

    // A regression cannot reach a provider CLI during this test: the command
    // name is deliberately absent from this temporary PATH.
    vi.stubEnv("PATH", join(home, "empty-path"));
    const collectionStart = vi.spyOn(QuotaCollectionLoop.prototype, "start");
    const controllerAdvance = vi.spyOn(SharedQuotaStore.prototype, "advancePendingController");
    const running = await startQuotaCoordinator({ home, probeOff: true });
    try {
      expect(collectionStart).not.toHaveBeenCalled();
      expect(controllerAdvance).not.toHaveBeenCalled();
      await expect(request(socketPath, "/v1/healthz")).resolves.toMatchObject({ status: 200 });
      await expect(request(socketPath, "/v1/readyz")).resolves.toMatchObject({ status: 200 });
      await expect(request(socketPath, "/v1/throttle?provider=claude")).resolves.toMatchObject({
        status: 200,
      });
      await expect(request(socketPath, "/v1/quota?provider=claude")).resolves.toMatchObject({
        status: 200,
        json: expect.objectContaining({ status: "available" }),
      });
      expect(readdirSync(backupDir).some((name) => /^quota-.*\.db$/.test(name))).toBe(true);
    } finally {
      await running.stop();
    }
  });

  it("keeps probe collection on when the switch is absent", async () => {
    const home = join(
      tmpdir(),
      `rusa-coord-probe-on-${Date.now()}-${Math.random().toString(36).slice(2)}`
    );
    const databasePath = join(home, "data", "quota-coordinator.db");
    mkdirSync(join(home, "data"), { recursive: true });
    testDirs.push(home);
    seedQuotaSnapshot(databasePath);
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
  coordinator:
    socketPath: ${join(home, "coordinator.sock")}
    databasePath: ${databasePath}
`
    );

    const collectionStart = vi
      .spyOn(QuotaCollectionLoop.prototype, "start")
      .mockImplementation(() => {});
    const running = await startQuotaCoordinator({ home });
    try {
      expect(collectionStart).toHaveBeenCalledOnce();
    } finally {
      await running.stop();
    }
  });
});
