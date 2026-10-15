/**
 * @vitest-environment node
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AvailabilityHold } from "../db/repositories/availability-hold-repository.js";

const openMock = vi.hoisted(() => {
  const fn = vi.fn(() => Promise.resolve());
  return { default: fn };
});

const mockConfig = {
  github: { account: "test-user" },
  webhook: { port: 9742, secret: "test-secret" },
  dashboard: { port: 8080 } as { port: number; tailscaleHostname?: string },
};

const mockDashboardServer = { close: vi.fn(() => Promise.resolve()) };

const mockConfigLoader = vi.hoisted(() => ({
  resolveHome: vi.fn(() => "/tmp/test-mc-home"),
  loadConfig: vi.fn(() => mockConfig),
}));

const mockWebhookServerModule = vi.hoisted(() => ({
  startDashboardServer: vi.fn(() => Promise.resolve(mockDashboardServer)),
}));

const mockReferenceCacheRepo = vi.hoisted(() => ({ get: vi.fn(), set: vi.fn(), delete: vi.fn() }));
const mockPrincipals = vi.hoisted(() => ({ ensureImplicitUser: vi.fn() }));
const mockReceipts = vi.hoisted(() => ({
  actorFor: vi.fn((_source: string): string | undefined => undefined),
}));
const mockAvailabilityHolds = vi.hoisted(() => ({
  list: vi.fn((_options?: { now?: number }): AvailabilityHold[] => []),
}));

const mockDbModule = vi.hoisted(() => ({
  initDb: vi.fn(() => ({})),
  getRepositories: vi.fn(() => ({
    actors: {
      list: vi.fn((): { id: string; parentId: string | null }[] => []),
    },
    meshEvents: {},
    meshChat: {},
    obligations: {},
    principals: mockPrincipals,
    referenceCache: mockReferenceCacheRepo,
    legacyImportReceipts: mockReceipts,
    availabilityHolds: mockAvailabilityHolds,
  })),
}));

const mockLegacyImport = vi.hoisted(() => ({
  importLegacyActorState: vi.fn(() => ({
    importedActors: 0,
    importedScheduledMessages: 0,
    backupFiles: [],
  })),
}));

const mockReferenceCacheModule = vi.hoisted(() => ({
  ReferenceCacheService: vi.fn(function (this: { options: unknown }, options: unknown) {
    this.options = options;
  }),
}));

vi.mock("open", () => openMock);
vi.mock("../webhook/server.js", () => mockWebhookServerModule);
vi.mock("../config/index.js", () => mockConfigLoader);
vi.mock("../db/index.js", () => mockDbModule);
vi.mock("../db/legacy-actor-import.js", () => mockLegacyImport);
vi.mock("../references/cache-service.js", () => mockReferenceCacheModule);

import { runDashboard } from "./dashboard.js";

describe("runDashboard", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockConfigLoader.loadConfig.mockReturnValue(mockConfig);
    mockConfigLoader.resolveHome.mockReturnValue("/tmp/test-mc-home");
    mockAvailabilityHolds.list.mockReturnValue([]);
  });

  afterEach(() => {
    process.removeAllListeners("SIGINT");
    process.removeAllListeners("SIGTERM");
  });

  it("starts the dashboard server with the live mesh data refs and opens the browser", async () => {
    await runDashboard();

    expect(mockConfigLoader.loadConfig).toHaveBeenCalledOnce();
    expect(mockDbModule.initDb).toHaveBeenCalledWith("/tmp/test-mc-home");
    expect(mockPrincipals.ensureImplicitUser).toHaveBeenCalledOnce();
    // The standalone dashboard now serves the read-only mesh Data API + SSE, so
    // it binds the persisted registry + mesh_events repo (plus an emitter).
    expect(mockWebhookServerModule.startDashboardServer).toHaveBeenCalledWith(
      expect.objectContaining({
        port: 8080,
        mesh: expect.objectContaining({ meshEvents: expect.anything() }),
      })
    );
    expect(openMock.default).toHaveBeenCalledWith("http://localhost:8080");
  });

  it("reports active availability holds in the header as `rusa start` does (#539)", async () => {
    const home = mkdtempSync(join(tmpdir(), "dashboard-holds-"));
    mockConfigLoader.resolveHome.mockReturnValue(home);
    const until = "2099-01-01T00:00:00.000Z";
    try {
      await runDashboard();
      const mesh = (
        mockWebhookServerModule.startDashboardServer.mock.calls as unknown as Array<
          [{ mesh: { isHalted: () => boolean; haltSnapshot: () => unknown } }]
        >
      )[0]?.[0].mesh;
      expect(mesh?.isHalted()).toBe(false);
      expect(mesh?.haltSnapshot()).toBeNull();

      mockAvailabilityHolds.list.mockReturnValue([
        { provider: "codex", expiry: until, reason: "", createdBy: "root", createdAt: until },
      ]);
      expect(mesh?.isHalted()).toBe(true);
      expect(mesh?.haltSnapshot()).toEqual({ providers: ["codex"], until });
      // Only holds in force now count; the repository is asked with a clock.
      expect(mockAvailabilityHolds.list).toHaveBeenLastCalledWith({ now: expect.any(Number) });
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("never invokes the legacy actor state importer", async () => {
    await runDashboard();

    expect(mockLegacyImport.importLegacyActorState).not.toHaveBeenCalled();
  });

  it("names the sole parentless actor as root", async () => {
    mockDbModule.getRepositories.mockReturnValue({
      actors: {
        list: vi.fn(() => [
          { id: "the-real-root", parentId: null },
          { id: "worker", parentId: "the-real-root" },
        ]),
      },
      meshEvents: {},
      meshChat: {},
      obligations: {},
      principals: mockPrincipals,
      referenceCache: mockReferenceCacheRepo,
      legacyImportReceipts: mockReceipts,
      availabilityHolds: mockAvailabilityHolds,
    });

    await runDashboard();

    expect(mockWebhookServerModule.startDashboardServer).toHaveBeenCalledWith(
      expect.objectContaining({
        mesh: expect.objectContaining({
          rootIdentity: expect.objectContaining({ id: "the-real-root" }),
        }),
      })
    );
  });

  it("keeps the first parentless actor as the dashboard root (#550)", async () => {
    mockDbModule.getRepositories.mockReturnValue({
      actors: {
        list: vi.fn(() => [
          { id: "parentless-a", parentId: null },
          { id: "parentless-b", parentId: null },
        ]),
      },
      meshEvents: {},
      meshChat: {},
      obligations: {},
      principals: mockPrincipals,
      referenceCache: mockReferenceCacheRepo,
      legacyImportReceipts: mockReceipts,
      availabilityHolds: mockAvailabilityHolds,
    });

    await runDashboard();

    expect(mockWebhookServerModule.startDashboardServer).toHaveBeenCalledWith(
      expect.objectContaining({
        mesh: expect.objectContaining({
          rootIdentity: expect.objectContaining({ id: "parentless-a" }),
        }),
      })
    );
  });

  it("names the imported configured actor with its stored handle once the import ran (#1002)", async () => {
    mockReceipts.actorFor.mockReturnValueOnce("imported-actor");
    mockDbModule.getRepositories.mockReturnValue({
      actors: {
        // A second parentless row listed first: the receipt, not topology, decides.
        list: vi.fn(() => [
          { id: "other-top-level", parentId: null },
          { id: "imported-actor", parentId: null },
        ]),
        get: vi.fn((id: string) =>
          id === "imported-actor"
            ? { id, parentId: null, displayHandle: "stored-handle" }
            : undefined
        ),
      },
      meshEvents: {},
      meshChat: {},
      obligations: {},
      principals: mockPrincipals,
      referenceCache: mockReferenceCacheRepo,
      legacyImportReceipts: mockReceipts,
    } as unknown as ReturnType<typeof mockDbModule.getRepositories>);

    await runDashboard();

    expect(mockReceipts.actorFor).toHaveBeenCalledWith("config.yaml:rootActor");
    const [options] = mockWebhookServerModule.startDashboardServer.mock.calls.at(-1) as unknown as [
      { mesh: { rootIdentity: unknown } },
    ];
    // The config's handle and avatar path are no longer read for an imported actor.
    expect(options.mesh.rootIdentity).toEqual({ id: "imported-actor", handle: "stored-handle" });
  });

  it("wires a repository-backed reference cache so standalone dashboard can serve persisted rows", async () => {
    await runDashboard();

    expect(mockReferenceCacheModule.ReferenceCacheService).toHaveBeenCalledWith(
      expect.objectContaining({ repo: mockReferenceCacheRepo })
    );
    const serviceInstance = mockReferenceCacheModule.ReferenceCacheService.mock.instances[0];
    expect(mockWebhookServerModule.startDashboardServer).toHaveBeenCalledWith(
      expect.objectContaining({
        mesh: expect.objectContaining({ referenceCache: serviceInstance }),
      })
    );
  });

  it("prefers the tailscale hostname for the opened URL when configured", async () => {
    mockConfigLoader.loadConfig.mockReturnValue({
      ...mockConfig,
      dashboard: { port: 8080, tailscaleHostname: "dash.example.ts.net" },
    });

    await runDashboard();

    expect(openMock.default).toHaveBeenCalledWith("https://dash.example.ts.net");
  });

  it("exits non-zero when config loading fails", async () => {
    mockConfigLoader.loadConfig.mockImplementationOnce(() => {
      throw new Error("Config error");
    });
    const originalProcessExit = process.exit;
    process.exit = vi.fn() as unknown as typeof process.exit;

    await runDashboard();

    expect(process.exit).toHaveBeenCalledWith(1);
    process.exit = originalProcessExit;
  });
});
