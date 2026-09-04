/**
 * @vitest-environment node
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const openMock = vi.hoisted(() => {
  const fn = vi.fn(() => Promise.resolve());
  return { default: fn };
});

const mockConfig = {
  github: { account: "test-user", pollIntervalSeconds: 10 },
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

const mockDbModule = vi.hoisted(() => ({
  initDb: vi.fn(() => ({})),
  getRepositories: vi.fn(() => ({
    actors: {
      list: vi.fn((): { id: string; parentId: string | null; isRoot: boolean }[] => []),
    },
    meshEvents: {},
    meshChat: {},
    obligations: {},
    referenceCache: mockReferenceCacheRepo,
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
  });

  afterEach(() => {
    process.removeAllListeners("SIGINT");
    process.removeAllListeners("SIGTERM");
  });

  it("starts the dashboard server with the live mesh data refs and opens the browser", async () => {
    await runDashboard();

    expect(mockConfigLoader.loadConfig).toHaveBeenCalledOnce();
    expect(mockDbModule.initDb).toHaveBeenCalledWith("/tmp/test-mc-home");
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

  it("stays read-only: never invokes the mutating legacy actor state importer", async () => {
    await runDashboard();

    expect(mockLegacyImport.importLegacyActorState).not.toHaveBeenCalled();
  });

  it("picks the root by isRoot, matching ActorMesh, not by a parentless shape", async () => {
    mockDbModule.getRepositories.mockReturnValue({
      actors: {
        list: vi.fn(() => [
          { id: "legacy-parentless", parentId: null, isRoot: false },
          { id: "the-real-root", parentId: null, isRoot: true },
        ]),
      },
      meshEvents: {},
      meshChat: {},
      obligations: {},
      referenceCache: mockReferenceCacheRepo,
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
