import type { ActorLifecycleListener } from "../actor/actor-lifecycle.js";
import type { RunMaterialBinding } from "../db/repositories/mesh-event-repository.js";
import type { Logger } from "../observability/logger.js";
import { type MaterialReadRequest, MaterialReadUnavailableError } from "./remote-instance.js";
import {
  RUN_MATERIAL_READ_MAX_BYTES,
  type RunMaterialKind,
  type RunMaterialRead,
  type RunMaterialStore,
} from "./run-material.js";

/**
 * The leader's half of a run bound to its execution host (#1020). The host
 * keeps the material; the leader keeps only what the host sent in full
 * because it could not keep it, in its own store under the same key, so a
 * reader can find every original.
 *
 * `recordLegacyPrompt` is the leader's prompt store for runs with no binding.
 */
export function runMaterialListener(
  actorId: string,
  store: RunMaterialStore,
  recordLegacyPrompt: (runId: string, prompt: string) => void,
  log: Logger
): ActorLifecycleListener {
  const boundRuns = new Set<string>();
  const retainFallback = (runId: string, item: "prompt" | "output", write: () => void) => {
    try {
      write();
      log.warn("run_material_fallback", { actorId, runId, item, retainedOn: "leader" });
    } catch (err) {
      log.error("run_material_fallback_failed", { actorId, runId, item, err });
    }
  };
  return {
    onStart: (event) => {
      if (!event.material) return;
      boundRuns.add(event.runId);
      store.openRun(actorId, event.runId);
    },
    onPrompt: (event) => {
      if (!boundRuns.has(event.runId) || event.attempt === undefined) {
        recordLegacyPrompt(event.runId, event.prompt);
        return;
      }
      const attempt = event.attempt;
      retainFallback(event.runId, "prompt", () =>
        store.putPrompt(actorId, event.runId, attempt, event.prompt)
      );
    },
    onEnd: (event) => {
      if (!boundRuns.delete(event.runId)) return;
      try {
        if (event.terminal.kind === "result" && !event.terminal.result.outputBound) {
          const { output } = event.terminal.result;
          retainFallback(event.runId, "output", () =>
            store.putOutput(actorId, event.runId, output)
          );
        }
      } finally {
        store.closeRun(actorId, event.runId);
      }
    },
  };
}

export interface RunMaterialReaderDeps {
  /** The run's owning actor, or undefined for an unknown run. */
  runActor: (runId: string) => string | undefined;
  binding: (actorId: string, runId: string) => RunMaterialBinding | undefined;
  /** The leader's own store: fallbacks for bound runs. */
  local: RunMaterialStore;
  /** Ask the run's execution host; rejects with {@link MaterialReadUnavailableError}. */
  remote: (
    host: string,
    actorId: string,
    request: MaterialReadRequest
  ) => Promise<RunMaterialRead | { status: "error"; error: string }>;
  /** The latest prompt of a run with no binding, from `run_prompts`. */
  legacyPrompt?: (runId: string) => string | undefined;
}

export interface RunMaterialResponse {
  status: number;
  body: Record<string, unknown>;
  /** Seconds, for a 503 the host may answer later. */
  retryAfter?: number;
}

type Outcome = {
  read: RunMaterialRead | { status: "error"; error: string };
  source: "leader" | "host";
};

/**
 * Read one original prompt or output of a run (#1020). A bound run's material
 * is read from the leader's fallback copy first, then from the host recorded
 * at its start, never from wherever the actor runs now. A latest-prompt read
 * needs both sides, since either may hold the highest attempt: if the host
 * cannot answer, the read fails rather than return an older attempt.
 */
export async function readRunMaterial(
  deps: RunMaterialReaderDeps,
  actorId: string,
  runId: string,
  kind: RunMaterialKind,
  attempt?: number
): Promise<RunMaterialResponse> {
  const binding = deps.binding(actorId, runId);
  if (!binding) {
    // Only the latest prompt of an unbound run was ever kept, in run_prompts.
    if (kind === "prompt" && attempt === undefined) {
      const prompt = deps.legacyPrompt?.(runId);
      if (prompt !== undefined) {
        // The established #866 response shape, unchanged for N−1 readers.
        return { status: 200, body: { prompt } };
      }
      return { status: 404, body: { error: "prompt not retained" } };
    }
    return { status: 404, body: { error: "materialHostUnknown" } };
  }
  try {
    const outcome = await readBound(deps, binding.host, actorId, { runId, kind, attempt });
    return respond(kind, outcome);
  } catch (err) {
    if (!(err instanceof MaterialReadUnavailableError)) throw err;
    return {
      status: 503,
      body: { error: "materialHostUnavailable", host: binding.host, reason: err.reason },
      ...(err.reason === "busy" ? { retryAfter: 1 } : {}),
    };
  }
}

async function readBound(
  deps: RunMaterialReaderDeps,
  host: string,
  actorId: string,
  request: MaterialReadRequest
): Promise<Outcome> {
  const { runId, kind, attempt } = request;
  if (kind === "prompt" && attempt === undefined) {
    const localLatest = deps.local.latestPromptAttempt(actorId, runId);
    const remote = await deps.remote(host, actorId, request);
    // The leader's copy wins only over a host attempt known to be older, or a
    // host-missing latest whose allocated key it has retained. A host answer
    // without an attempt is returned as the error it is.
    const remoteLatest =
      remote.status === "ok" || remote.status === "tooLarge" || remote.status === "missing"
        ? remote.attempt
        : undefined;
    const localIsNewer =
      localLatest !== undefined &&
      (remote.status === "missing"
        ? remoteLatest === undefined || localLatest >= remoteLatest
        : remoteLatest !== undefined && localLatest > remoteLatest);
    if (localIsNewer) {
      return { read: deps.local.read(actorId, runId, "prompt", localLatest), source: "leader" };
    }
    return { read: remote, source: "host" };
  }
  const local = deps.local.read(actorId, runId, kind, attempt);
  if (local.status !== "missing") return { read: local, source: "leader" };
  return { read: await deps.remote(host, actorId, request), source: "host" };
}

function respond(kind: RunMaterialKind, { read, source }: Outcome): RunMaterialResponse {
  switch (read.status) {
    case "ok":
      return {
        status: 200,
        body: {
          [kind]: read.content.toString("utf8"),
          ...(read.attempt === undefined ? {} : { attempt: read.attempt }),
          bytes: read.bytes,
          sha256: read.sha256,
          source,
        },
      };
    case "missing":
      return { status: 404, body: { error: `${kind} not retained` } };
    case "tooLarge":
      return {
        status: 413,
        body: {
          error: `${kind} exceeds the read limit`,
          ...(read.attempt === undefined ? {} : { attempt: read.attempt }),
          bytes: read.bytes,
          sha256: read.sha256,
          limitBytes: RUN_MATERIAL_READ_MAX_BYTES,
        },
      };
    case "integrity":
      return { status: 502, body: { error: "integrity", source } };
    case "error":
      return { status: 502, body: { error: "materialHostError", message: read.error, source } };
  }
}
