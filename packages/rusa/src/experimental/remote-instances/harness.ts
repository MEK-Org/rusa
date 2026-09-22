import { setTimeout as delay } from "node:timers/promises";
import { ActorMesh } from "../../actor/actor-mesh.js";
import {
  InMemoryEventSourceOwnerStore,
  InMemoryEventSourceSubscriptionStore,
} from "../../actor/event-subscriptions.js";
import { ExternalRootDriver } from "../../actor/external-root-driver.js";
import type { MeshEventInput } from "../../actor/mesh-events.js";
import { type ProviderPacer, submitPoolGate } from "../../actor/provider-pacer.js";
import type { LogFields, Logger } from "../../observability/logger.js";
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
  /**
   * Leader-side provider pacing. Supplied only by tests about a run that waits
   * to be admitted; without it the mesh keeps its unpaced default gate.
   */
  pacer?: ProviderPacer;
}) {
  const actors = new InMemoryActorRepository();
  const runtimes = new Map<string, ActorHandle>();
  let remote = new RemoteInstance("test-follower", process.platform, process.pid);
  const follower = new FollowerInstance(
    options.cwd,
    false,
    (event) => queueMicrotask(() => remote.receive(structuredClone(event))),
    options.providerFactory ?? createProvider
  );
  // Exercise the same instance commands without opening a port in unit tests.
  const wire = (instance: RemoteInstance) => {
    instance.flush = () => {
      for (const command of instance.commands.splice(0))
        if ("actorId" in command) queueMicrotask(() => follower.dispatch(structuredClone(command)));
    };
  };
  wire(remote);
  const messages: Array<{ fromId: string; toId: string; body: string }> = [];
  const events: Array<{ actorId: string; event: ActorEvent }> = [];
  const meshEvents: MeshEventInput[] = [];
  // The leader's request/outcome distinction is only visible in its structured logs.
  const logs: Array<{ event: string; fields?: LogFields }> = [];
  const logger: Logger = {
    debug: () => {},
    info: (event, fields) => {
      logs.push({ event, fields });
    },
    warn: (event, fields) => {
      logs.push({ event, fields });
    },
    error: (event, fields) => {
      logs.push({ event, fields });
    },
    child: () => logger,
  };
  const failures: Error[] = [];
  let sequence = 0;
  const eventSourceOwners = new InMemoryEventSourceOwnerStore();
  const eventSourceSubscriptions = new InMemoryEventSourceSubscriptionStore();
  const pacer = options.pacer;
  // No event seam: these follower tests never route or deliver events, and a
  // mesh without one simply refuses those paths rather than inventing a ladder.
  const mesh = new ActorMesh({
    actors,
    rootId: "root",
    eventSourceOwners,
    eventSourceSubscriptions,
    maxConcurrent: 1,
    events: (event) => meshEvents.push(event),
    idgen: () => `instance-worker-${++sequence}`,
    ...(pacer
      ? {
          providerGate: (fn, candidates, request) =>
            submitPoolGate(fn, [{ config: candidates[0], lane: "instance-fixture", pacer }], {
              responsive: request.responsive,
              threadId: request.threadId,
              enqueueNormal: request.enqueueNormal,
            }),
        }
      : {}),
    recordChat: (message) => {
      messages.push({ fromId: message.senderId, toId: message.recipientId, body: message.body });
      return `message-${messages.length}`;
    },
    createActor: (context) => {
      let cursor = 0;
      let admittedCursor = 0;
      context.lifecycle.add({
        onEnd: (event) => {
          if (event.terminal.kind === "abandoned") {
            mesh.recordEvent({
              kind: "run_abandoned",
              actorId: context.record.id,
              detail: event.terminal.reason,
              payload: JSON.stringify({
                started: event.terminal.started,
                runId: event.runId,
              }),
            });
          }
        },
      });
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
        logger,
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
    meshEvents,
    logs,
    failures,
    follower,
    get remote() {
      return remote;
    },
    reconnect() {
      remote = new RemoteInstance("test-follower", process.platform, process.pid);
      wire(remote);
      return remote;
    },
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
