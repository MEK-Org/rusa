// @vitest-environment node
import { once } from "node:events";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DashboardDataDeps } from "../dashboard/api.js";
import type { DashboardAuth } from "../dashboard/auth.js";
import { MeshEventEmitter } from "../dashboard/mesh-event-emitter.js";
import type { QuotaApiDeps } from "../dashboard/quota-api.js";
import { SseHub } from "../dashboard/sse.js";
import {
  DASHBOARD_TIMING_EVENT_KIND,
  type DashboardServerPhaseGroup,
  DashboardTimingRecorder,
} from "../dashboard/timing.js";
import { runMigrations } from "../db/migrations/runner.js";
import { MeshChatRepository } from "../db/repositories/mesh-chat-repository.js";
import { MeshEventRepository } from "../db/repositories/mesh-event-repository.js";
import { ObligationRepository } from "../db/repositories/obligation-repository.js";
import { PrincipalRepository } from "../db/repositories/principal-repository.js";
import { SqliteInboxRepository } from "../db/repositories/sqlite-inbox-repository.js";
import type { ReferenceCacheService } from "../references/cache-service.js";
import { InMemoryActorRepository } from "../repositories/in-memory-actor-repository.js";
import { createDashboardRequestHandler } from "./server.js";

// Each fake stage sleeps for a fixed, synthetic delay so its phase is visible.
const delays = vi.hoisted(() => ({ auth: 0, compression: 0, enrichment: 0, history: 0 }));
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

vi.mock("node:zlib", async (importOriginal) => {
  const zlib = await importOriginal<typeof import("node:zlib")>();
  const delayed =
    <Args extends unknown[]>(compress: (...args: Args) => void) =>
    (...args: Args) => {
      setTimeout(() => compress(...args), delays.compression);
    };
  return {
    ...zlib,
    brotliCompress: delayed(zlib.brotliCompress as (...args: unknown[]) => void),
    gzip: delayed(zlib.gzip as (...args: unknown[]) => void),
  };
});

describe("dashboard server phase timing", () => {
  let db: Database.Database;
  let events: MeshEventRepository;
  let timings: DashboardTimingRecorder;
  let server: Server;
  let origin: string;

  beforeEach(async () => {
    Object.assign(delays, { auth: 0, compression: 0, enrichment: 0, history: 0 });
    db = new Database(":memory:");
    runMigrations(db);
    events = new MeshEventRepository(db);
    timings = new DashboardTimingRecorder(events);
    const obligations = new ObligationRepository(db);
    obligations.create({
      id: "phase-fixture",
      ownerId: "actor-1",
      title: "Phase fixture",
      intent: "x".repeat(4096),
    });
    obligations.attachArtifact("phase-fixture", "github:example-org/example/issues/1");
    obligations.attachArtifact("phase-fixture", "github:example-org/example/issues/2");
    const referenceCache = {
      // The production cache shares one budget across these two parallel lookups.
      startBudget: () => ({ deadlineAt: Date.now() + 1_000 }),
      get: async (ref: string) => {
        await sleep(delays.enrichment);
        return { ref, scheme: "github", cacheState: "fresh", unavailable: null };
      },
    } as unknown as ReferenceCacheService;
    const principals = new PrincipalRepository(db);
    principals.createUser({ email: "operator@example.com", createdAt: "2026-10-01T00:00:00.000Z" });
    const dataDeps = {
      actors: new InMemoryActorRepository(),
      principals,
      meshEvents: events,
      meshChat: new MeshChatRepository(db),
      inbox: new SqliteInboxRepository(db),
      obligations,
      sseHub: new SseHub(new MeshEventEmitter()),
      referenceCache,
      timings,
    } as unknown as DashboardDataDeps;
    const quotaApi: QuotaApiDeps = {
      providers: ["claude"],
      getQuota: async () => {
        throw new Error("no synthetic snapshot");
      },
      listHistory: () => [],
      readThroughHistory: async () => {
        await sleep(delays.history);
      },
    };
    const auth = {
      config: { email: "operator@example.com" },
      handle: async () => false,
      authorize: async () => {
        await sleep(delays.auth);
        return true;
      },
      guardStream: () => {},
    } as unknown as DashboardAuth;
    server = createServer(
      createDashboardRequestHandler({ port: 0, serveUi: false, quotaApi }, dataDeps, null, auth)
    );
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterEach(async () => {
    server.close();
    timings.stop();
    db.close();
  });

  const get = async (path: string) => {
    const response = await fetch(`${origin}${path}`, {
      headers: { "Accept-Encoding": "br" },
    });
    await response.arrayBuffer();
    return response;
  };

  const phaseGroups = async (expectedRecordCount: number): Promise<DashboardServerPhaseGroup[]> => {
    await vi.waitFor(() => {
      expect(
        events.listByKindSince(DASHBOARD_TIMING_EVENT_KIND, "2026-01-01T00:00:00.000Z", 100)
      ).toHaveLength(expectedRecordCount);
    });
    return timings.summary({ since: new Date(Date.now() - 60_000) }).serverPhases;
  };

  it("separates a cold quota history read from a slow authenticated obligation request", async () => {
    // A cold history read: fast auth, slow store read-through.
    delays.history = 80;
    expect((await get("/api/quota/history")).status).toBe(200);
    delays.history = 0;

    // A slow authenticated obligation request with parallel enrichment and compression.
    delays.auth = 80;
    delays.enrichment = 50;
    delays.compression = 40;
    const detail = await get("/api/mesh/obligations/phase-fixture");
    expect(detail.status).toBe(200);
    expect(detail.headers.get("content-encoding")).toBe("br");
    Object.assign(delays, { auth: 0, compression: 0, enrichment: 0 });

    // The snapshot route is a separate operation of the same fixed label.
    await get("/api/quota");

    const groups = await phaseGroups(3);
    const history = groups.find((group) => group.operation === "quota_history");
    const snapshot = groups.find((group) => group.operation === "quota_snapshot");
    const obligation = groups.find((group) => group.label === "mesh_obligation_detail");
    expect(history?.label).toBe("mesh_quota");
    expect(snapshot?.label).toBe("mesh_quota");
    expect(obligation?.operation).toBeUndefined();

    // The cold history read is dominated by its route (store) phase, not auth.
    expect(history?.phases.route?.p50Ms).toBeGreaterThanOrEqual(75);
    expect(history?.phases.route?.coverage).toEqual({
      numerator: 1,
      denominator: 1,
      state: "full",
    });
    // Quota responses are never enriched or compressed: those phases are absent, not zero.
    expect(Object.keys(history?.phases ?? {}).sort()).toEqual(["auth", "route", "serialization"]);

    // The slow obligation request is dominated by auth, and its two parallel
    // enrichments are one ~50 ms union rather than a 100 ms sum.
    expect(obligation?.phases.auth?.p50Ms).toBeGreaterThanOrEqual(75);
    expect(obligation?.phases.enrichment?.p50Ms).toBeGreaterThanOrEqual(45);
    expect(obligation?.phases.route?.p50Ms).toBeGreaterThanOrEqual(
      obligation?.phases.enrichment?.p50Ms ?? Number.POSITIVE_INFINITY
    );
    expect(obligation?.phases.compression?.p50Ms).toBeGreaterThanOrEqual(35);
    expect(obligation?.phases.serialization).toBeDefined();

    // The request-wide duration is kept, and the phases are not a partition of it.
    expect(obligation?.durationMs.p50Ms).toBeGreaterThanOrEqual(
      Math.max(obligation?.phases.auth?.p50Ms ?? 0, obligation?.phases.compression?.p50Ms ?? 0)
    );
  });

  it("leaves auth absent when the dashboard runs without an auth boundary", async () => {
    server.close();
    const handler = createDashboardRequestHandler({ port: 0, serveUi: false }, {
      timings,
    } as unknown as DashboardDataDeps);
    server = createServer(handler);
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

    await get("/api/dashboard/config");

    const [config] = await phaseGroups(1);
    expect(config.label).toBe("dashboard_config");
    expect(config.sampleCount).toBe(1);
    // The config route writes its own headers: route only, no auth or serialization phase.
    expect(Object.keys(config.phases)).toEqual(["route"]);
  });
});
