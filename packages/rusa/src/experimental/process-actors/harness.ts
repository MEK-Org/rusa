import { setTimeout as delay } from "node:timers/promises";
import { ActorMesh } from "../../actor/actor-mesh.js";
import { ExternalRootDriver } from "../../actor/external-root-driver.js";
import { InMemoryActorRepository } from "../../repositories/in-memory-actor-repository.js";
import { ProcessActor } from "./process-actor.js";
import type { ChildMessage } from "./protocol.js";

export async function waitUntil(check: () => boolean, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!check()) {
    if (Date.now() >= deadline) throw new Error("Timed out waiting for process actor");
    await delay(10);
  }
}

/** All coordinator state is ephemeral here. No production DB, config, or service access. */
export function createHarness(options: {
  childEntry: string | URL;
  providerModule: string;
  cwd: string;
  delayMs?: number;
}) {
  const actors = new InMemoryActorRepository();
  const runtimes = new Map<string, ProcessActor>();
  const messages: Array<{ fromId: string; toId: string; body: string }> = [];
  const events: Array<{ actorId: string; event: ChildMessage }> = [];
  const failures: Error[] = [];
  let sequence = 0;
  const mesh = new ActorMesh({
    actors,
    rootId: "root",
    maxConcurrent: 1,
    idgen: () => `process-worker-${++sequence}`,
    recordChat: (message) => {
      messages.push({ fromId: message.senderId, toId: message.recipientId, body: message.body });
      return `message-${messages.length}`;
    },
    createActor: (context) => {
      let cursor = 0;
      let admittedCursor = 0;
      const runtime = new ProcessActor({
        childEntry: options.childEntry,
        context,
        bootstrap: {
          id: context.record.id,
          cwd: options.cwd,
          providerModule: options.providerModule,
          providerOptions: { delayMs: options.delayMs },
          sessionId: context.record.sessionId,
        },
        snapshot: () => {
          const record = context.getRecord();
          if (!record) throw new Error("Actor record is missing");
          admittedCursor = messages.length;
          return {
            record,
            prompt: JSON.stringify({
              charter: record.charter,
              parentId: record.parentId,
              messages: messages
                .slice(cursor, admittedCursor)
                .filter((message) => message.toId === record.id)
                .map((message) => message.body),
            }),
          };
        },
        saveSession: (sessionId) => actors.patch(context.record.id, { sessionId }),
        onEvent: (event) => {
          events.push({ actorId: context.record.id, event });
          if (event.type === "result" && event.result.success) cursor = admittedCursor;
        },
        onFailure: (error) => {
          failures.push(error);
        },
      });
      runtimes.set(context.record.id, runtime);
      return runtime;
    },
  });
  mesh.adopt(
    {
      id: "root",
      parentId: null,
      charter: "Coordinate the prototype",
      status: "active",
      createdAt: new Date().toISOString(),
    },
    new ExternalRootDriver("root")
  );

  return {
    mesh,
    actors,
    runtimes,
    messages,
    events,
    failures,
    runtime: (id: string) => {
      const runtime = runtimes.get(id);
      if (!runtime) throw new Error(`No runtime for ${id}`);
      return runtime;
    },
    spawn: (charter: string) => {
      const id = mesh.spawn({
        charter,
        parentId: "root",
        provider: "process-fixture",
        model: "scripted",
      });
      mesh.sendMessage(id, "Begin your charter", "root");
      return id;
    },
    async close() {
      mesh.shutdownAll();
      await Promise.all([...runtimes.values()].map((runtime) => runtime.exited));
    },
  };
}
