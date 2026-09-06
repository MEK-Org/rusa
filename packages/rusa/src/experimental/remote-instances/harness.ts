import { setTimeout as delay } from "node:timers/promises";
import { ActorMesh } from "../../actor/actor-mesh.js";
import { ExternalRootDriver } from "../../actor/external-root-driver.js";
import { InMemoryActorRepository } from "../../repositories/in-memory-actor-repository.js";
import { ActorHandle } from "./actor-handle.js";
import { createProvider } from "./fixture-provider.js";
import { FollowerInstance } from "./follower-instance.js";
import type { ActorEvent, ProviderFactory } from "./protocol.js";
import { RemoteInstance } from "./remote-instance.js";

export async function waitUntil(check: () => boolean, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!check()) {
    if (Date.now() >= deadline) throw new Error("Timed out waiting for instance actor");
    await delay(10);
  }
}

/** All coordinator state is ephemeral here. No production DB, config, or service access. */
export function createHarness(options: {
  cwd: string;
  delayMs?: number;
  providerFactory?: ProviderFactory;
}) {
  const actors = new InMemoryActorRepository();
  const runtimes = new Map<string, ActorHandle>();
  const remote = new RemoteInstance("test-follower", process.platform, process.pid);
  const follower = new FollowerInstance(
    options.cwd,
    false,
    (event) => queueMicrotask(() => remote.receive(structuredClone(event))),
    options.providerFactory ?? createProvider
  );
  // Exercise the same instance commands without opening a port in unit tests.
  remote.flush = () => {
    for (const command of remote.commands.splice(0))
      queueMicrotask(() => follower.dispatch(structuredClone(command)));
  };
  const messages: Array<{ fromId: string; toId: string; body: string }> = [];
  const events: Array<{ actorId: string; event: ActorEvent }> = [];
  const failures: Error[] = [];
  let sequence = 0;
  const mesh = new ActorMesh({
    actors,
    rootId: "root",
    maxConcurrent: 1,
    idgen: () => `instance-worker-${++sequence}`,
    recordChat: (message) => {
      messages.push({ fromId: message.senderId, toId: message.recipientId, body: message.body });
      return `message-${messages.length}`;
    },
    createActor: (context) => {
      let cursor = 0;
      let admittedCursor = 0;
      const runtime = new ActorHandle({
        host: remote.createHost(context.record.id),
        context,
        bootstrap: {
          id: context.record.id,
          cwd: options.cwd,
          modelConfig: context.record.modelConfig ? [...context.record.modelConfig] : undefined,
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
    follower,
    remote,
    runtime: (id: string) => {
      const runtime = runtimes.get(id);
      if (!runtime) throw new Error(`No runtime for ${id}`);
      return runtime;
    },
    spawn: (charter: string) => {
      const id = mesh.spawn({
        charter,
        parentId: "root",
        modelConfig: { provider: "instance-fixture", model: "scripted" },
      });
      mesh.sendMessage(id, "Begin your charter", "root");
      return id;
    },
    async close() {
      mesh.shutdownAll();
      await Promise.all([...runtimes.values()].map((runtime) => runtime.exited));
      follower.close();
      remote.close();
    },
  };
}
