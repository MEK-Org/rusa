import { Actor } from "../../actor/actor.js";
import type {
  ActorEvent,
  Bootstrap,
  LeaderCommand,
  ProviderFactory,
  Request,
  RunSnapshot,
} from "./protocol.js";

/** One ordinary Actor inside the follower process. No process-global handlers or exits. */
export function createActorRuntime(
  createProvider: ProviderFactory,
  send: (message: ActorEvent) => void,
  onClosed: () => void
) {
  let actor: Actor | undefined;
  let sequence = 0;
  let stopping = false;
  let activeGates = 0;
  let closed = false;
  function finishClose(): void {
    if (stopping && !closed && activeGates === 0) {
      closed = true;
      onClosed();
    }
  }
  const pending = new Map<
    number,
    { resolve: (value: unknown) => void; reject: (error: Error) => void }
  >();

  function request<T>(payload: Request): { id: number; result: Promise<T> } {
    const id = ++sequence;
    if (stopping) return { id, result: Promise.reject(new Error("Actor is stopping")) };
    const result = new Promise<T>((resolve, reject) => {
      pending.set(id, { resolve: (value) => resolve(value as T), reject });
      send({ type: "request", requestId: id, request: payload });
    });
    return { id, result };
  }

  async function initialize(bootstrap: Bootstrap): Promise<void> {
    if (stopping) return;
    let snapshot: RunSnapshot;
    let sessionId = bootstrap.sessionId;
    const provider = await createProvider(
      {
        sendMessage: (to, body) => request({ op: "sendMessage", to, body }).result,
        yieldRun: (status, note) => {
          if (!actor) throw new Error("Actor is not initialized");
          actor.declareYield(status, note);
        },
      },
      bootstrap.providerOptions ?? {}
    );
    if (stopping) return;
    const mcpServers = bootstrap.mcpServers ?? [];
    actor = new Actor({
      ...bootstrap.actorOptions,
      id: bootstrap.id,
      cwd: bootstrap.cwd,
      provider,
      mcpServers,
      debounceMs: bootstrap.actorOptions?.debounceMs ?? 10,
      loadSessionId: () => sessionId,
      saveSessionId: (id) => {
        sessionId = id;
        send({ type: "session", sessionId: id });
      },
      buildPrompt: () => snapshot.promptBuild ?? { prompt: snapshot.prompt },
      prepareUnderstandingMount: () => request<string | undefined>({ op: "prepareMount" }).result,
      beforeRun: async ({ mode }) => {
        const reply = await request<{ allowed: boolean; sessionId?: string }>({
          op: "beforeRun",
          mode,
        }).result;
        sessionId = reply.sessionId;
        return reply.allowed;
      },
      gate: async (fn, provider, responsive) => {
        activeGates++;
        const admission = request<RunSnapshot>({ op: "admit", provider, responsive });
        try {
          snapshot = await admission.result;
          if (stopping) throw new Error("Actor stopped before admission");
          sessionId = snapshot.record.sessionId;
          if (snapshot.mcpServers) {
            // Actor holds the array by reference, matching the in-process tool refresh path.
            mcpServers.splice(0, mcpServers.length, ...snapshot.mcpServers);
          }
          return await fn();
        } finally {
          send({ type: "release", requestId: admission.id });
          activeGates--;
          finishClose();
        }
      },
      onQueued: (context) => send({ type: "queued", ...context }),
      onRunEnd: (result) =>
        stopping ? Promise.resolve() : request<void>({ op: "complete", result }).result,
      onRunStart: (responsive, injectRecord) =>
        send({ type: "runStart", responsive, injectRecord }),
      onFirstChunk: () => send({ type: "firstChunk" }),
      onRunAbandoned: (abandon) => send({ type: "abandoned", abandon }),
      onContinue: (count) => send({ type: "continue", count }),
      onContinuationCapped: (count) => send({ type: "capped", count }),
      onCoalesceAborted: (count, ageMs) => send({ type: "coalesced", count, ageMs }),
      onRuntimeStateChanged: (state) =>
        send({ type: "state", state, yielded: actor?.isYielded ?? false }),
      log: (chunk) => send({ type: "log", chunk }),
    });
    send({ type: "ready", pid: process.pid });
  }

  function stop(): void {
    if (stopping) return;
    stopping = true;
    actor?.interrupt("instance-actor-retirement");
    actor?.close();
    for (const call of pending.values())
      call.reject(new Error("Coordinator disconnected or stopped actor"));
    pending.clear();
    finishClose();
  }

  function dispatch(message: LeaderCommand): void {
    switch (message.type) {
      case "init":
        void initialize(message.bootstrap).catch((error) => {
          send({ type: "fatal", error: String(error) });
          stop();
        });
        break;
      case "reply": {
        const call = pending.get(message.requestId);
        pending.delete(message.requestId);
        if (message.error) call?.reject(new Error(message.error));
        else call?.resolve(message.value);
        break;
      }
      case "wake":
        if (!stopping) actor?.requestRun(message.nudge);
        break;
      case "yield":
        actor?.declareYield(message.status, message.note);
        break;
      case "unkillable":
        actor?.markUnkillable();
        break;
      case "stop":
        stop();
        break;
    }
  }
  return { dispatch, close: stop };
}
