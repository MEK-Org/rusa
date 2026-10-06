import { EventEmitter } from "node:events";
import type { IncomingMessage, ServerResponse } from "node:http";
import { performance } from "node:perf_hooks";
import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import type { ActorMesh } from "../actor/actor-mesh.js";
import type { ActorRecord } from "../actor/actor-record.js";
import { runMigrations } from "../db/migrations/runner.js";
import { MeshChatRepository } from "../db/repositories/mesh-chat-repository.js";
import { MeshEventRepository } from "../db/repositories/mesh-event-repository.js";
import { ObligationRepository } from "../db/repositories/obligation-repository.js";
import { PrincipalRepository } from "../db/repositories/principal-repository.js";
import { SqliteActorRepository } from "../db/repositories/sqlite-actor-repository.js";
import { SqliteInboxRepository } from "../db/repositories/sqlite-inbox-repository.js";
import { type DashboardDataDeps, handleMeshApiRequest } from "./api.js";
import { MeshEventEmitter } from "./mesh-event-emitter.js";
import { SseHub } from "./sse.js";

const ACTORS = 500;
const EVENT_COUNTS = [100_000, 500_000, 1_000_000];
const SWEEPS = 5;

class BenchRequest extends EventEmitter {
  method = "GET";
  headers: Record<string, string> = {};
  url = "/api/mesh/threads";
}

class BenchResponse extends EventEmitter {
  req: EventEmitter & { headers?: Record<string, string> } = new EventEmitter();
  statusCode = 0;
  headers: Record<string, string> = {};
  body: Uint8Array = Buffer.alloc(0);
  ended = false;

  writeHead(status: number, headers?: Record<string, string>): this {
    this.statusCode = status;
    this.headers = headers ?? {};
    return this;
  }

  end(body?: string | Buffer): this {
    this.body = Buffer.isBuffer(body) ? body : Buffer.from(body ?? "");
    this.ended = true;
    this.emit("finish");
    return this;
  }
}

function median(values: number[]): number {
  return [...values].sort((left, right) => left - right)[Math.floor(values.length / 2)];
}

function seed(db: Database.Database, actors: SqliteActorRepository, eventCount: number): string[] {
  const actorIds: string[] = [];
  for (let i = 0; i < ACTORS; i++) {
    const id = `actor-${i}`;
    actorIds.push(id);
    const record: ActorRecord = {
      id,
      charter: "Synthetic #934 actor-activity benchmark fixture; not production data.",
      parentId: i === 0 ? null : "actor-0",
      ...(i === 0 ? { isRoot: true } : {}),
      status: "active",
      sandboxed: i !== 0,
      createdAt: new Date(i * 1_000).toISOString(),
    };
    actors.upsert(record);
  }

  const insert = db.prepare(
    "INSERT INTO mesh_events (id, ts, kind, actor_id, detail, body, payload, success) VALUES (?, ?, ?, ?, ?, ?, ?, ?)"
  );
  db.transaction(() => {
    for (let i = 0; i < eventCount; i++) {
      insert.run(
        `event-${i}`,
        new Date(i * 1_000).toISOString(),
        "run_start",
        actorIds[i % ACTORS],
        null,
        null,
        null,
        null
      );
    }
  })();
  db.exec("ANALYZE");
  return actorIds;
}

async function requestThreads(
  deps: DashboardDataDeps,
  acceptEncoding: string | undefined
): Promise<{ milliseconds: number; bytes: number }> {
  const request = new BenchRequest();
  const response = new BenchResponse();
  if (acceptEncoding) response.req.headers = { "accept-encoding": acceptEncoding };
  const started = performance.now();
  await handleMeshApiRequest(
    request as unknown as IncomingMessage,
    response as unknown as ServerResponse,
    new URL(request.url, "http://localhost"),
    deps
  );
  if (!response.ended) await new Promise((resolve) => response.once("finish", resolve));
  expect(response.statusCode).toBe(200);
  return { milliseconds: performance.now() - started, bytes: response.body.byteLength };
}

describe.skipIf(process.env.RUSA_BENCH_934 !== "1")(
  "#934 synthetic threads-handler actor-activity benchmark",
  () => {
    it("measures full route, runtime repositories, and gzip across event history sizes", async () => {
      const cases = [];
      for (const eventCount of EVENT_COUNTS) {
        const db = new Database(":memory:");
        try {
          runMigrations(db);
          const actors = new SqliteActorRepository(db);
          const actorIds = seed(db, actors, eventCount);
          const deps: DashboardDataDeps = {
            actors,
            principals: new PrincipalRepository(db),
            meshEvents: new MeshEventRepository(db),
            meshChat: new MeshChatRepository(db),
            inbox: new SqliteInboxRepository(db),
            obligations: new ObligationRepository(db),
            sseHub: new SseHub(new MeshEventEmitter()),
            mesh: { getSelection: () => undefined } as unknown as ActorMesh,
          };
          const querySamples = [];
          const plainSamples = [];
          const gzipSamples = [];
          for (let sweep = 0; sweep < SWEEPS; sweep++) {
            const queryStarted = performance.now();
            deps.meshEvents.latestActivityByActor(actorIds);
            querySamples.push(performance.now() - queryStarted);
            plainSamples.push(await requestThreads(deps, undefined));
            gzipSamples.push(await requestThreads(deps, "gzip"));
          }
          cases.push({
            eventCount,
            actorCount: ACTORS,
            sweeps: SWEEPS,
            runtimeDeps: [
              "SqliteActorRepository",
              "PrincipalRepository",
              "MeshEventRepository",
              "MeshChatRepository",
              "SqliteInboxRepository",
              "ObligationRepository",
              "SseHub",
              "ActorMesh.getSelection",
            ],
            latestActivityMedianMs: median(querySamples),
            handlerIdentityMedianMs: median(plainSamples.map((sample) => sample.milliseconds)),
            handlerGzipMedianMs: median(gzipSamples.map((sample) => sample.milliseconds)),
            identityBytes: plainSamples[0]?.bytes,
            gzipBytes: gzipSamples[0]?.bytes,
          });
        } finally {
          db.close();
        }
      }
      console.log(JSON.stringify({ cases }));
    }, 120_000);
  }
);
