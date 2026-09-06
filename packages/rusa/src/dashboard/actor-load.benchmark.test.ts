import { EventEmitter } from "node:events";
import type { IncomingMessage, ServerResponse } from "node:http";
import { performance } from "node:perf_hooks";
import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import type { ActorRecord } from "../actor/actor-record.js";
import { runMigrations } from "../db/migrations/runner.js";
import { MeshChatRepository } from "../db/repositories/mesh-chat-repository.js";
import { MeshEventRepository } from "../db/repositories/mesh-event-repository.js";
import { SqliteActorRepository } from "../db/repositories/sqlite-actor-repository.js";
import { type DashboardDataDeps, handleMeshApiRequest } from "./api.js";
import { MeshEventEmitter } from "./mesh-event-emitter.js";
import { SseHub } from "./sse.js";

const ACTORS = 1_000;
const MESSAGES_PER_ACTOR = 100;
const HUMAN_MESSAGES_PER_ACTOR = 20;
const SWEEPS = 3;

class BenchRequest extends EventEmitter {
  method = "GET";
  headers: Record<string, string> = {};
  url = "/api/mesh/threads";
}

class BenchResponse extends EventEmitter {
  req: EventEmitter & { headers?: Record<string, string> } = new EventEmitter();
  statusCode = 0;
  headers: Record<string, string> = {};
  body: Uint8Array = new Uint8Array();
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
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.floor(sorted.length / 2)];
}

function seed(db: Database.Database, actors: SqliteActorRepository): void {
  for (let actor = 0; actor < ACTORS; actor++) {
    const record: ActorRecord = {
      id: `actor-${actor}`,
      charter: "Synthetic actor-load benchmark fixture; not production data.",
      parentId: actor === 0 ? null : "actor-0",
      ...(actor === 0 ? { isRoot: true } : {}),
      status: "active",
      createdAt: new Date(actor * 1000).toISOString(),
    };
    actors.upsert(record);
  }

  const insert = db.prepare(
    "INSERT INTO mesh_chat (id, ts, sender_id, recipient_id, body, session_id) VALUES (?, ?, ?, ?, ?, ?)"
  );
  db.transaction(() => {
    for (let actor = 0; actor < ACTORS; actor++) {
      for (let message = 0; message < MESSAGES_PER_ACTOR; message++) {
        const ordinal = actor * MESSAGES_PER_ACTOR + message;
        insert.run(
          `chat-${ordinal}`,
          new Date(ordinal * 1000).toISOString(),
          message < HUMAN_MESSAGES_PER_ACTOR ? "human:operator" : `peer-${message % 10}`,
          `actor-${actor}`,
          "synthetic",
          `session-${ordinal}`
        );
      }
    }
  })();
  db.exec("ANALYZE");
}

async function requestThreads(
  deps: DashboardDataDeps
): Promise<{ milliseconds: number; bytes: number }> {
  const request = new BenchRequest();
  const response = new BenchResponse();
  const startedAt = performance.now();
  await handleMeshApiRequest(
    request as unknown as IncomingMessage,
    response as unknown as ServerResponse,
    new URL(request.url, "http://localhost"),
    deps
  );
  if (!response.ended) await new Promise((resolve) => response.once("finish", resolve));
  expect(response.statusCode).toBe(200);
  return { milliseconds: performance.now() - startedAt, bytes: response.body.byteLength };
}

describe.skipIf(process.env.RUSA_BENCH_274 !== "1")(
  "#274 disposable /api/mesh/threads benchmark",
  () => {
    it("measures the actual route handler with the batched repository lookup", async () => {
      const db = new Database(":memory:");
      runMigrations(db);
      const actorRepository = new SqliteActorRepository(db);
      seed(db, actorRepository);
      const deps: DashboardDataDeps = {
        actors: actorRepository,
        meshEvents: new MeshEventRepository(db),
        meshChat: new MeshChatRepository(db),
        sseHub: new SseHub(new MeshEventEmitter()),
      };

      const batched = [];
      for (let sweep = 0; sweep < SWEEPS; sweep++) batched.push(await requestThreads(deps));

      console.log(
        JSON.stringify({
          dataset: {
            actorCount: ACTORS,
            messagesPerActor: MESSAGES_PER_ACTOR,
            humanMessagesPerActor: HUMAN_MESSAGES_PER_ACTOR,
            totalRows: ACTORS * MESSAGES_PER_ACTOR,
            sweeps: SWEEPS,
          },
          batched: {
            milliseconds: batched.map((sample) => sample.milliseconds),
            medianMilliseconds: median(batched.map((sample) => sample.milliseconds)),
            responseBytes: batched[0]?.bytes,
          },
        })
      );
      db.close();
    });
  }
);
