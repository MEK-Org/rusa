import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { deterministicExhaustionFallback } from "../providers/exhaustion-classifier.js";
import { FakeProvider } from "../providers/fake-provider.js";
import type { RawProviderModelConfig } from "../providers/model-config.js";
import * as sandboxModule from "../providers/sandbox.js";
import { formatSigtermResult } from "../providers/termination-attribution.js";
import type { CodingProvider, RunOptions, RunResult } from "../providers/types.js";
import {
  Actor,
  type ActorOptions,
  formatPoolExhaustedFailure,
  type PoolFallbackDiagnostic,
  type RunAbandon,
  WATCHDOG_CEILING_TIMEOUT_MS,
  WATCHDOG_STALL_TIMEOUT_MS,
} from "./actor.js";
import { createActorLifecycle } from "./actor-lifecycle.js";
import type { ActorRecord } from "./actor-record.js";
import {
  ConcurrencyLimiter,
  PoolExhaustedError,
  RunStartCancelledError,
  type RunStartHandle,
} from "./concurrency-limiter.js";
import { routeRunFailure } from "./failure-sink.js";

/** Let the timer-less corrective-run microtasks drain. */
const flush = async () => {
  for (let i = 0; i < 30; i++) await Promise.resolve();
};

type TestActorHooks = {
  onQueued?: (event: { responsive: boolean; mode: string }) => unknown;
  onRunStart?: (
    responsive: boolean,
    injectRecord?: unknown,
    selected?: RawProviderModelConfig
  ) => unknown;
  onRunEnd?: (result: RunResult) => unknown;
  onRunAbandoned?: (abandon: RunAbandon) => unknown;
};

function makeActor(
  over: Partial<ActorOptions> & TestActorHooks = {},
  provider = new FakeProvider()
): Actor {
  let session: string | undefined;
  const {
    onQueued,
    onRunStart,
    onRunEnd,
    onRunAbandoned,
    lifecycle: explicitLifecycle,
    ...actorOpts
  } = over;
  const lifecycle = explicitLifecycle ?? createActorLifecycle();
  if (onQueued || onRunStart || onRunEnd || onRunAbandoned) {
    lifecycle.add({
      onQueued: onQueued
        ? async (event) => {
            await onQueued({ responsive: event.responsive, mode: event.mode });
          }
        : undefined,
      onStart: onRunStart
        ? async (event) => {
            await onRunStart(event.responsive, event.injectRecord, event.selected);
          }
        : undefined,
      onEnd: async (event) => {
        if (event.terminal.kind === "result") {
          await onRunEnd?.(event.terminal.result);
        } else {
          await onRunAbandoned?.({
            reason: event.terminal.reason,
            started: event.terminal.started,
          });
        }
      },
    });
  }
  return new Actor({
    id: "a1",
    cwd: "/tmp/a1",
    modelConfig: [{ provider: provider.providerName }],
    resolveProvider: () => provider,
    mcpServers: [],
    loadSessionId: () => session,
    saveSessionId: (id) => {
      session = id;
    },
    buildPrompt: () => ({ prompt: "PROMPT: inbox work" }),
    debounceMs: 10,
    lifecycle,
    ...actorOpts,
  });
}

describe("Actor", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("runs the provider with the built prompt after debounce", async () => {
    let actor!: Actor;
    const provider = new FakeProvider(() => {
      actor.declareYield();
      return {};
    });
    actor = makeActor({}, provider);
    actor.requestRun();
    expect(provider.calls).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(10);
    expect(provider.calls).toHaveLength(1);
    expect(provider.calls[0]?.prompt).toBe("PROMPT: inbox work");
  });

  it("reports the instantiated provider immediately before it runs", async () => {
    let actor!: Actor;
    const provider = new FakeProvider(
      () => {
        actor.declareYield();
        return {};
      },
      "codex",
      "gpt-5.6-terra"
    );
    const attempts: RawProviderModelConfig[] = [];
    actor = makeActor(
      {
        modelConfig: [
          { provider: provider.providerName, model: "gpt-5.6-sol", effort: "medium" },
          { provider: provider.providerName, model: "gpt-5.6-terra" },
        ],
        gate: (fn, candidates) => fn(candidates[1]),
        onProviderAttempt: (attempt) =>
          attempts.push({
            provider: attempt.providerName,
            model: attempt.model,
            effort: attempt.effort,
          }),
      },
      provider
    );

    actor.requestRun();
    await vi.advanceTimersByTimeAsync(10);

    expect(provider.calls[0]?.prompt).toBe("PROMPT: inbox work");
    expect(attempts).toEqual([{ provider: provider.providerName, model: "gpt-5.6-terra" }]);
  });

  it("keeps active attempt attribution on its launched model when a later model is staged", async () => {
    let actor!: Actor;
    let runCount = 0;
    const attempts: RawProviderModelConfig[] = [];
    actor = makeActor(
      {
        modelConfig: [{ provider: "codex", model: "gpt-5.6-sol", effort: "low" }],
        resolveProvider: (selected) =>
          new FakeProvider(
            () => {
              if (runCount++ === 0) {
                actor.setModelConfig([
                  { provider: "codex", model: "gpt-5.6-terra", effort: "high" },
                ]);
              }
              actor.declareYield();
              return {};
            },
            selected.provider,
            selected.model,
            selected.effort
          ),
        onProviderAttempt: (attempt) =>
          attempts.push({
            provider: attempt.providerName,
            model: attempt.model,
            effort: attempt.effort,
          }),
      },
      new FakeProvider()
    );

    actor.requestRun();
    await vi.advanceTimersByTimeAsync(10);
    actor.requestRun();
    await vi.advanceTimersByTimeAsync(10);

    expect(attempts).toEqual([
      { provider: "codex", model: "gpt-5.6-sol", effort: "low" },
      { provider: "codex", model: "gpt-5.6-terra", effort: "high" },
    ]);
  });

  it("publishes actor-owned runtime transitions and waits for outer flag clear before idle", async () => {
    let resolveProvider!: (result: Partial<RunResult>) => void;
    let resolveRunEnd!: () => void;
    const provider = new FakeProvider(
      () => new Promise<Partial<RunResult>>((resolve) => (resolveProvider = resolve))
    );
    const states: string[] = [];
    const actor = makeActor(
      {
        onRuntimeStateChanged: (state) => states.push(state),
        onRunEnd: () => new Promise<void>((resolve) => (resolveRunEnd = resolve)),
      },
      provider
    );

    actor.requestRun();
    await vi.advanceTimersByTimeAsync(10);
    expect(states).toEqual(["queued", "running"]);

    actor.declareYield();
    expect(states).toEqual(["queued", "running", "winding_down"]);
    resolveProvider({ success: true, output: "done", exitCode: 0 });
    await flush();
    expect(states).toEqual(["queued", "running", "winding_down"]);

    resolveRunEnd();
    await flush();
    expect(states).toEqual(["queued", "running", "winding_down", "idle"]);
  });

  it("passes bwrap sandbox options to the provider when enabled", async () => {
    const provider = new FakeProvider();
    const actor = makeActor({ sandbox: true }, provider);

    actor.requestRun();
    await vi.advanceTimersByTimeAsync(10);

    expect(provider.calls[0]?.sandbox).toEqual({
      worktreePath: "/tmp/a1",
    });
  });

  it("invokes prepareUnderstandingMount and passes host mount directory to sandbox options", async () => {
    let actor!: Actor;
    const provider = new FakeProvider(() => {
      actor.declareYield();
      return {};
    });
    const prepareMountMock = vi.fn().mockResolvedValue("/tmp/test-snapshot-mount");
    actor = makeActor(
      {
        sandbox: true,
        prepareUnderstandingMount: prepareMountMock,
      },
      provider
    );

    actor.requestRun();
    await vi.advanceTimersByTimeAsync(10);

    expect(prepareMountMock).toHaveBeenCalledTimes(1);
    expect(provider.calls[0]?.sandbox).toEqual({
      worktreePath: "/tmp/a1",
      understandingMount: "/tmp/test-snapshot-mount",
    });
  });

  it("skips provider sandbox options when disabled", async () => {
    const provider = new FakeProvider();
    const actor = makeActor({ sandbox: false }, provider);

    actor.requestRun();
    await vi.advanceTimersByTimeAsync(10);

    expect(provider.calls[0]?.sandbox).toBeUndefined();
    expect(provider.calls[0]?.cwd).toBe("/tmp/a1");
  });

  it("persists and resumes its session across runs", async () => {
    const provider = new FakeProvider();
    const actor = makeActor({}, provider);
    actor.requestRun();
    await vi.advanceTimersByTimeAsync(10);
    const created = provider.calls[0]?.session?.id;
    expect(created).toBeUndefined(); // first run creates
    actor.requestRun();
    await vi.advanceTimersByTimeAsync(10);
    // second run resumes the id the first minted (FakeProvider mints fake-session-1)
    expect(provider.calls[1]?.session?.id).toBe("fake-session-1");
  });

  it("resolves the live provider per-run, so an in-place swap takes effect on the next run", async () => {
    let actor!: Actor;
    const provider1 = new FakeProvider(() => {
      actor.declareYield();
      return {};
    });
    const provider2 = new FakeProvider(() => {
      actor.declareYield();
      return {};
    });
    let live: FakeProvider = provider1;
    actor = makeActor({ resolveProvider: () => live }, provider1);

    actor.requestRun();
    await vi.advanceTimersByTimeAsync(10);
    expect(provider1.calls).toHaveLength(1);
    expect(provider2.calls).toHaveLength(0);

    live = provider2;

    actor.requestRun();
    await vi.advanceTimersByTimeAsync(10);
    expect(provider1.calls).toHaveLength(1);
    expect(provider2.calls).toHaveLength(1);
    // Session is retained across the provider update
    expect(provider2.calls[0]?.session?.id).toBe("fake-session-1");
  });

  it("skips the run when beforeRun returns false", async () => {
    const provider = new FakeProvider();
    const actor = makeActor({ beforeRun: () => false }, provider);
    actor.requestRun();
    await vi.advanceTimersByTimeAsync(10);
    expect(provider.calls).toHaveLength(0);
  });

  it("skips the run when preempted during async beforeRun (admission epoch)", async () => {
    const provider = new FakeProvider();
    let resolveBeforeRun!: (val: boolean) => void;
    let beforeRunEntered!: () => void;
    const beforeRunPromise = new Promise<void>((r) => (beforeRunEntered = r));
    const actor = makeActor(
      {
        beforeRun: () => {
          beforeRunEntered();
          return new Promise((resolve) => {
            resolveBeforeRun = resolve;
          });
        },
      },
      provider
    );
    actor.requestRun();
    await vi.advanceTimersByTimeAsync(50);
    await beforeRunPromise;

    // Actor is awaiting beforeRun
    const preemption = actor.preemptForResponsive();
    if (preemption.preempted === false) throw new Error("Expected preemption");
    expect(preemption.phase).toBe("queued"); // TriggerRunner is busy but not executing yet

    // Queue the replacement that preempted it
    actor.requestRun({ priority: "responsive" });

    // Resolve beforeRun for the stale run
    resolveBeforeRun(true);
    await flush();

    // The responsive replacement starts and hits beforeRun. Resolve it too.
    resolveBeforeRun(true);
    await flush();

    // The ordinary run is skipped due to admission epoch change, and exactly one
    // run (the responsive replacement) is executed.
    expect(provider.calls).toHaveLength(1);
  });

  it("skips the run when preempted in the gap after scheduler pops but before invoke", async () => {
    let resolveInvoke!: () => void;
    let invokeCalled = false;
    const provider = new FakeProvider(() => {
      actor.declareYield("complete");
      return {
        success: true,
        output: "simulated output",
        exitCode: 0,
        sessionId: "s1",
      };
    });
    const actor = makeActor(
      {
        gate: (invoke, candidates) => {
          if (invokeCalled) {
            return invoke(candidates[0]);
          }
          return {
            started: false,
            cancel: () => false, // simulate scheduler popping the callback
            promote: () => {},
            result: new Promise((resolve) => {
              // Defer invoke() to capture the exact gap
              resolveInvoke = () => {
                invokeCalled = true;
                try {
                  resolve(invoke(candidates[0]));
                } catch (e) {
                  resolve(Promise.reject(e));
                }
              };
            }),
          };
        },
      },
      provider
    );
    actor.requestRun();
    await vi.advanceTimersByTimeAsync(50);
    // Gate has returned the start handle, but invoke() hasn't run yet.
    // This perfectly simulates the cancel() === false window.

    const preemption = actor.preemptForResponsive();
    if (preemption.preempted === false) throw new Error("Expected preemption");
    expect(preemption.phase).toBe("queued");
    // Ensure we are testing the gap before executing
    expect(actor.isRunning).toBe(false);

    // Enqueue the replacement
    actor.requestRun({ priority: "responsive" });

    // Now let invoke() run; it should throw RunStartCancelledError due to preemption flag
    resolveInvoke();
    await flush();
    await vi.advanceTimersByTimeAsync(50);
    expect(invokeCalled).toBe(true);
    // Only the responsive replacement ran
    expect(provider.calls).toHaveLength(1);
  });

  it("routes the run through the gate and calls onRun", async () => {
    let actor!: Actor;
    const provider = new FakeProvider(() => {
      actor.declareYield();
      return {};
    });
    const seen: RunResult[] = [];
    let gated = 0;
    let gatedProvider: string | undefined;
    actor = makeActor(
      {
        gate: async (fn, candidates) => {
          gated++;
          gatedProvider = candidates[0]?.provider;
          return fn(candidates[0]);
        },
        onRunEnd: (r) => {
          seen.push(r);
        },
      },
      provider
    );
    actor.requestRun();
    await vi.advanceTimersByTimeAsync(10);
    expect(gated).toBe(1);
    expect(gatedProvider).toBe(provider.providerName);
    expect(seen).toHaveLength(1);
    expect(seen[0]?.success).toBe(true);
  });

  it("promotes a queued normal run when a responsive wake arrives", async () => {
    let actor!: Actor;
    const provider = new FakeProvider(() => {
      actor.declareYield();
      return {};
    });
    let promotions = 0;
    const priorities: boolean[] = [];
    const startPriorities: boolean[] = [];
    const gate: NonNullable<ActorOptions["gate"]> = <T>(
      fn: (selected: RawProviderModelConfig) => Promise<T>,
      candidates: readonly RawProviderModelConfig[],
      responsive: boolean
    ) => {
      priorities.push(responsive);
      if (responsive) {
        return {
          result: Promise.resolve().then(() => fn(candidates[0])),
          started: false,
          promote: () => {},
        };
      }
      let resolve!: (result: T) => void;
      const result = new Promise<T>((res) => (resolve = res));
      return {
        result,
        started: false,
        promote: () => {
          promotions++;
          queueMicrotask(() => void fn(candidates[0]).then(resolve));
        },
      };
    };
    actor = makeActor(
      {
        gate,
        onRunStart: (responsive) => startPriorities.push(responsive),
      },
      provider
    );

    actor.requestRun();
    await vi.advanceTimersByTimeAsync(10);
    expect(provider.calls).toHaveLength(0);

    actor.requestRun({ priority: "responsive", voiceTimestamp: Date.now() });
    await flush();

    expect(promotions).toBe(1);
    expect(priorities).toEqual([false]);
    expect(startPriorities).toEqual([true]);
    expect(provider.calls).toHaveLength(1);
  });

  it("cancels a queued run and replays its wake after resume", async () => {
    const limiter = new ConcurrencyLimiter(1);
    let releaseBlocker!: () => void;
    void limiter.run(() => new Promise<void>((resolve) => (releaseBlocker = resolve)));
    await flush();
    let actor!: Actor;
    const provider = new FakeProvider(() => {
      actor.declareYield();
      return {};
    });
    actor = makeActor(
      {
        gate: (fn, candidates) => limiter.enqueue(() => fn(candidates[0])),
      },
      provider
    );

    actor.requestRun();
    await vi.advanceTimersByTimeAsync(10);
    expect(actor.cancelQueuedRun()).toBe(true);
    await flush();
    expect(provider.calls).toHaveLength(0);

    releaseBlocker();
    await flush();
    expect(actor.resumeCancelledRun()).toBe(true);
    await vi.advanceTimersByTimeAsync(10);
    await flush();
    expect(provider.calls[0]?.prompt).toBe("PROMPT: inbox work");
  });

  it("requotes a queued run without changing its responsive corrective nudge", async () => {
    const queued: Array<{ responsive: boolean; mode: string }> = [];
    const gated: boolean[] = [];
    const rejects: Array<(reason: unknown) => void> = [];
    const actor = makeActor({
      onQueued: (event) => queued.push(event),
      gate: <T>(
        _fn: (selected: RawProviderModelConfig) => Promise<T>,
        _candidates: readonly RawProviderModelConfig[],
        responsive: boolean
      ): RunStartHandle<T> => {
        gated.push(responsive);
        return {
          started: false,
          promote: () => {},
          cancel: () => {
            rejects.shift()?.(new RunStartCancelledError());
            return true;
          },
          result: new Promise<T>((_resolve, reject) => rejects.push(reject)),
        };
      },
    });

    actor.requestRun({ priority: "responsive", mode: "yield-elicitation" });
    await flush();
    expect(queued).toEqual([{ responsive: true, mode: "yield-elicitation" }]);
    expect(gated).toEqual([true]);

    expect(actor.rescheduleQueuedRun()).toBe(true);
    await flush();

    // A re-quote retries the same scheduling opportunity: it must remain a
    // responsive corrective run rather than becoming a fresh ordinary wake.
    expect(queued).toEqual([
      { responsive: true, mode: "yield-elicitation" },
      { responsive: true, mode: "yield-elicitation" },
    ]);
    expect(gated).toEqual([true, true]);

    actor.close();
    await flush();
  });

  it("parks a requeue when halt arrives during its preflight, then resumes it once", async () => {
    let actor!: Actor;
    let preflightCalls = 0;
    let releaseReplacementPreflight!: (allowed: boolean) => void;
    let firstGateReject!: (reason: unknown) => void;
    let gateCalls = 0;
    const provider = new FakeProvider(() => {
      actor.declareYield();
      return {};
    });
    actor = makeActor(
      {
        beforeRun: () => {
          preflightCalls++;
          if (preflightCalls !== 2) return true;
          return new Promise<boolean>((resolve) => {
            releaseReplacementPreflight = resolve;
          });
        },
        gate: <T>(
          fn: (selected: RawProviderModelConfig) => Promise<T>,
          candidates: readonly RawProviderModelConfig[]
        ): RunStartHandle<T> | Promise<T> => {
          gateCalls++;
          const candidate = candidates[0];
          if (!candidate) throw new Error("test gate expected a model candidate");
          if (gateCalls !== 1) return Promise.resolve().then(() => fn(candidate));
          return {
            started: false,
            promote: () => {},
            cancel: () => {
              firstGateReject(new RunStartCancelledError());
              return true;
            },
            result: new Promise<T>((_resolve, reject) => {
              firstGateReject = reject;
            }),
          };
        },
      },
      provider
    );

    actor.requestRun();
    await vi.advanceTimersByTimeAsync(10);
    expect(gateCalls).toBe(1);

    // The old queued reservation has already rejected and its one requeue is
    // now paused in the replacement preflight — the race a provider halt can
    // otherwise use to consume the dirty bit without leaving a resume record.
    expect(actor.rescheduleQueuedRun()).toBe(true);
    await flush();
    expect(preflightCalls).toBe(2);
    expect(actor.cancelQueuedRun()).toBe(true);

    releaseReplacementPreflight(true);
    await flush();
    expect(gateCalls).toBe(1);
    expect(provider.calls).toHaveLength(0);

    expect(actor.resumeCancelledRun()).toBe(true);
    await vi.advanceTimersByTimeAsync(10);
    await flush();
    expect(gateCalls).toBe(2);
    expect(provider.calls).toHaveLength(1);
  });

  it("replaces a queued normal run with one responsive opportunity", async () => {
    const limiter = new ConcurrencyLimiter(1);
    let releaseBlocker!: () => void;
    void limiter.run(() => new Promise<void>((resolve) => (releaseBlocker = resolve)));
    await flush();
    let actor!: Actor;
    const provider = new FakeProvider(() => {
      actor.declareYield();
      return {};
    });
    actor = makeActor(
      {
        gate: (fn, candidates) => limiter.enqueue(() => fn(candidates[0])),
      },
      provider
    );

    actor.requestRun();
    await vi.advanceTimersByTimeAsync(10);
    expect(actor.isQueued).toBe(true);

    expect(actor.preemptForResponsive()).toEqual({ preempted: true, phase: "queued" });
    actor.requestRun({ priority: "responsive" });
    await flush();
    expect(provider.calls).toHaveLength(0);

    releaseBlocker();
    await flush();
    expect(provider.calls).toHaveLength(1);
    expect(provider.calls[0]?.prompt).toBe("PROMPT: inbox work");
    expect(actor.resumeCancelledRun()).toBe(false);
  });

  describe("every queued opportunity reports exactly one terminal signal ", () => {
    it("reports a completed run through onRunEnd and never as abandoned", async () => {
      // The counter-assertion for the cells below: if onRunAbandoned fired on the
      // ordinary path too, they would all pass while the signal meant nothing.
      const abandoned: RunAbandon[] = [];
      let ended = 0;
      let actor!: Actor;
      // Yield inside the run, so this is ONE opportunity: an actor that ends a
      // run without yielding earns a corrective run, which is a second queue and
      // legitimately a second onRunEnd.
      const provider = new FakeProvider(() => {
        actor.declareYield();
        return {};
      });
      actor = makeActor(
        {
          onRunEnd: () => {
            ended++;
          },
          onRunAbandoned: (abandon) => abandoned.push(abandon),
        },
        provider
      );

      actor.requestRun();
      await vi.advanceTimersByTimeAsync(10);
      await flush();

      expect(ended).toBe(1);
      expect(abandoned).toEqual([]);
    });

    it("reports a cancelled queued start as abandoned, and its replay as ended", async () => {
      const limiter = new ConcurrencyLimiter(1);
      let releaseBlocker!: () => void;
      void limiter.run(() => new Promise<void>((resolve) => (releaseBlocker = resolve)));
      await flush();
      const abandoned: RunAbandon[] = [];
      let ended = 0;
      let actor!: Actor;
      const provider = new FakeProvider(() => {
        actor.declareYield();
        return {};
      });
      actor = makeActor(
        {
          gate: (fn, candidates) => limiter.enqueue(() => fn(candidates[0])),
          onRunEnd: () => {
            ended++;
          },
          onRunAbandoned: (abandon) => abandoned.push(abandon),
        },
        provider
      );

      actor.requestRun();
      await vi.advanceTimersByTimeAsync(10);
      expect(actor.cancelQueuedRun()).toBe(true);
      await flush();

      // The run never reached the provider, so it has no result to report — but
      // the opportunity it opened at onQueued still has to close, or whatever
      // counted the queue never counts it back down.
      expect(provider.calls).toHaveLength(0);
      expect(ended).toBe(0);
      // started:false — the gate cancelled it BEFORE the provider invoke, so this
      // abandonment closes no run_start. A reader that tracks started runs must not
      // count it (wait-idle would otherwise cancel out an unrelated live run).
      expect(abandoned).toEqual([{ reason: "start-cancelled", started: false }]);

      releaseBlocker();
      await flush();
      expect(actor.resumeCancelledRun()).toBe(true);
      await vi.advanceTimersByTimeAsync(10);
      await flush();

      expect(ended).toBe(1);
      expect(abandoned).toEqual([{ reason: "start-cancelled", started: false }]);
    });

    it("reports an admitted start cancelled by actor close as abandoned without calling onRunEnd or provider ", async () => {
      let runInvoke!: () => Promise<unknown>;
      const abandoned: RunAbandon[] = [];
      let ended = 0;
      let startCalls = 0;
      let providerCalls = 0;

      const provider = new FakeProvider(() => {
        providerCalls++;
        return {};
      });

      let resolveResult!: (val: unknown) => void;
      let rejectResult!: (err: unknown) => void;
      const resultPromise = new Promise<unknown>((res, rej) => {
        resolveResult = res;
        rejectResult = rej;
      });

      const actor = makeActor(
        {
          gate: <T>(
            fn: (selected: RawProviderModelConfig) => Promise<T>,
            candidates: readonly RawProviderModelConfig[]
          ): RunStartHandle<T> => {
            runInvoke = async () => {
              try {
                const res = await fn(candidates[0]);
                resolveResult(res);
                return res;
              } catch (err) {
                rejectResult(err);
                throw err;
              }
            };
            return {
              result: resultPromise as unknown as Promise<T>,
              started: true,
              promote: () => {},
              cancel: () => false,
            };
          },
          onRunStart: () => {
            startCalls++;
          },
          onRunEnd: () => {
            ended++;
          },
          onRunAbandoned: (abandon) => abandoned.push(abandon),
        },
        provider
      );

      actor.requestRun();
      await vi.advanceTimersByTimeAsync(10);
      await flush();

      expect(runInvoke).toBeDefined();
      expect(providerCalls).toBe(0);
      expect(startCalls).toBe(0);
      expect(ended).toBe(0);
      expect(abandoned).toEqual([]);

      actor.close();

      await expect(runInvoke()).rejects.toThrow(RunStartCancelledError);
      await flush();

      expect(providerCalls).toBe(0);
      expect(startCalls).toBe(0);
      expect(ended).toBe(0);
      expect(abandoned).toEqual([{ reason: "start-cancelled", started: false }]);
    });

    it("reports a coalesce-aborted run as abandoned", async () => {
      let resolveRun!: (res: RunResult) => void;
      const provider = new FakeProvider(() => {
        return new Promise<RunResult>((resolve) => {
          resolveRun = resolve;
        });
      });
      const abandoned: RunAbandon[] = [];
      let ended = 0;
      const actor = makeActor(
        {
          debounceMs: 30000,
          onRunEnd: () => {
            ended++;
          },
          onRunAbandoned: (abandon) => abandoned.push(abandon),
        },
        provider
      );

      const now = Date.now();
      actor.requestRun({ priority: "responsive", voiceTimestamp: now });
      await flush();
      actor.requestRun({ priority: "responsive", voiceTimestamp: now + 100 });
      await flush();
      resolveRun({ success: false, exitCode: 143, output: "aborted" });
      await flush();

      // started:true — the contrast with the cancelled-start cell above. The
      // provider invoke had begun, so this DOES close a run_start.
      expect(ended).toBe(0);
      expect(abandoned).toEqual([{ reason: "coalesced", started: true }]);

      resolveRun({ success: true, exitCode: 0, output: "done" });
      await flush();

      expect(ended).toBe(1);
      expect(abandoned).toEqual([{ reason: "coalesced", started: true }]);
    });

    it("reports nothing at all when the pre-run gate declines the wake", async () => {
      // No opportunity was opened: beforeRun returns before onQueued, so a
      // terminal signal here would be one decrement with no matching increment.
      const abandoned: RunAbandon[] = [];
      let queued = 0;
      let ended = 0;
      const actor = makeActor({
        beforeRun: async () => false,
        onQueued: () => {
          queued++;
        },
        onRunEnd: () => {
          ended++;
        },
        onRunAbandoned: (abandon) => abandoned.push(abandon),
      });

      actor.requestRun();
      await vi.advanceTimersByTimeAsync(10);
      await flush();

      expect(queued).toBe(0);
      expect(ended).toBe(0);
      expect(abandoned).toEqual([]);
    });
  });

  it("calls onRun with the failure result when the provider reports failure", async () => {
    const provider = new FakeProvider(() => ({ success: false, output: "nope", exitCode: 2 }));
    const seen: RunResult[] = [];
    const actor = makeActor(
      {
        onRunEnd: (r) => {
          seen.push(r);
        },
      },
      provider
    );
    actor.requestRun();
    await vi.advanceTimersByTimeAsync(10);
    expect(seen).toHaveLength(1);
    expect(seen[0]?.success).toBe(false);
    expect(seen[0]?.exitCode).toBe(2);
  });

  it("keeps a first-entry success as a single provider attempt", async () => {
    const provider = new FakeProvider(
      () => ({ success: true, output: "done", exitCode: 0 }),
      "primary-model"
    );
    const recovery = new FakeProvider(undefined, "recovery-model");
    const classify = vi.fn(async () => ({ exhausted: true }));
    const diagnostics: unknown[] = [];
    const actor = makeActor(
      {
        modelConfig: [
          { provider: "primary", model: "first" },
          { provider: "recovery", model: "second" },
        ],
        resolveProvider: (entry) => (entry.provider === "recovery" ? recovery : provider),
        classifyExhaustion: classify,
        onPoolFallback: (diagnostic) => diagnostics.push(diagnostic),
      },
      provider
    );

    actor.requestRun();
    await vi.advanceTimersByTimeAsync(10);

    expect(classify).not.toHaveBeenCalled();
    expect(recovery.calls).toHaveLength(0);
    expect(diagnostics).toEqual([]);
  });

  it("does not enter the remaining pool when the classifier rejects exhaustion", async () => {
    const primary = new FakeProvider(
      () => ({ success: false, output: "ordinary failure", exitCode: 1 }),
      "primary-model"
    );
    const fallbackProvider = new FakeProvider(undefined, "fallback-model");
    const seen: RunResult[] = [];
    const actor = makeActor(
      {
        modelConfig: [
          { provider: "primary", model: "primary-model" },
          { provider: "recovery", model: "fallback-model" },
        ],
        resolveProvider: (entry) => (entry.provider === "recovery" ? fallbackProvider : primary),
        classifyExhaustion: async () => ({ exhausted: false }),
        onRunEnd: (result) => {
          seen.push(result);
        },
      },
      primary
    );

    actor.requestRun();
    await vi.advanceTimersByTimeAsync(10);

    expect(fallbackProvider.calls).toHaveLength(0);
    expect(seen[0]?.output).toBe("ordinary failure");
  });

  it("recovers through a later configured pool entry in order with intact tuples", async () => {
    let actor!: Actor;
    const primary = new FakeProvider(
      () => ({ success: false, output: "quota exhausted first", exitCode: 1 }),
      "claude",
      "claude-opus",
      "high"
    );
    const second = new FakeProvider(
      () => ({ success: false, output: "quota exhausted second", exitCode: 2 }),
      "codex",
      "gpt-5.6-terra",
      "medium"
    );
    const third = new FakeProvider(
      () => {
        actor.declareYield();
        return { output: "recovered", model: "gemini-3.1-pro-bound" };
      },
      "agy",
      "gemini-3.1-pro",
      "low"
    );
    const diagnostics: Array<{
      attempt: number;
      failed: RawProviderModelConfig;
      next: RawProviderModelConfig;
      remainingAfter: number;
    }> = [];
    actor = makeActor(
      {
        modelConfig: [
          { provider: "claude", model: "claude-opus", effort: "high" },
          { provider: "codex", model: "gpt-5.6-terra", effort: "medium" },
          { provider: "agy", model: "gemini-3.1-pro", effort: "low" },
        ],
        resolveProvider: (entry) =>
          ({ claude: primary, codex: second, agy: third })[entry.provider] ?? primary,
        classifyExhaustion: async (result) => ({
          exhausted: result.output.includes("quota exhausted"),
        }),
        onPoolFallback: (diagnostic) => diagnostics.push(diagnostic),
      },
      primary
    );

    actor.requestRun();
    await vi.advanceTimersByTimeAsync(10);

    expect(primary.calls).toHaveLength(1);
    expect(second.calls).toHaveLength(1);
    expect(third.calls).toHaveLength(1);
    expect(diagnostics).toMatchObject([
      {
        attempt: 2,
        failed: { provider: "claude", model: "claude-opus", effort: "high" },
        next: { provider: "codex", model: "gpt-5.6-terra", effort: "medium" },
        remainingAfter: 1,
      },
      {
        attempt: 3,
        failed: { provider: "codex", model: "gpt-5.6-terra", effort: "medium" },
        next: { provider: "agy", model: "gemini-3.1-pro", effort: "low" },
        remainingAfter: 0,
      },
    ]);
  });

  it("reports each pool provider's actual model and effort before its attempt", async () => {
    let actor!: Actor;
    const primary = new FakeProvider(
      () => ({ success: false, output: "quota exhausted", exitCode: 1 }),
      "primary-provider",
      "primary-model",
      "high"
    );
    const fallbackProvider = new FakeProvider(
      () => {
        actor.declareYield();
        return { output: "fallback ok" };
      },
      "fallback-provider",
      "fallback-model",
      "low"
    );
    const resolvePoolEntry = vi.fn((entry: RawProviderModelConfig) =>
      entry.provider === "fallback-provider" ? fallbackProvider : primary
    );
    const attempts: RawProviderModelConfig[] = [];
    actor = makeActor(
      {
        modelConfig: [
          { provider: primary.providerName, model: "primary-model", effort: "high" },
          { provider: fallbackProvider.providerName, model: "fallback-model", effort: "low" },
        ],
        resolveProvider: resolvePoolEntry,
        classifyExhaustion: async () => ({ exhausted: true }),
        onProviderAttempt: (attempt) =>
          attempts.push({
            provider: attempt.providerName,
            model: attempt.model,
            effort: attempt.effort,
          }),
      },
      primary
    );

    actor.requestRun();
    await vi.advanceTimersByTimeAsync(10);

    expect(primary.calls[0]?.prompt).toBe("PROMPT: inbox work");
    expect(fallbackProvider.calls[0]?.prompt).toBe("PROMPT: inbox work");
    expect(attempts).toEqual([
      { provider: primary.providerName, model: "primary-model", effort: "high" },
      { provider: fallbackProvider.providerName, model: "fallback-model", effort: "low" },
    ]);
    expect(resolvePoolEntry).toHaveBeenLastCalledWith({
      provider: "fallback-provider",
      model: "fallback-model",
      effort: "low",
    });
  });

  it("uses the recovery pool entry rather than a model-only fallback pin", async () => {
    let actor!: Actor;
    const primary = new FakeProvider(
      () => ({ success: false, output: "quota exhausted", exitCode: 1 }),
      "primary-provider",
      "primary-model"
    );
    const fallbackProvider = new FakeProvider(
      () => {
        actor.declareYield();
        return { output: "fallback ok" };
      },
      "codex",
      "gpt-5.6-sol",
      "medium"
    );
    const resolvePoolEntry = vi.fn((entry: RawProviderModelConfig) =>
      entry.provider === "codex" ? fallbackProvider : primary
    );
    const attempts: RawProviderModelConfig[] = [];
    actor = makeActor(
      {
        modelConfig: [
          { provider: primary.providerName, model: "primary-model" },
          { provider: "codex", model: "gpt-5.6-sol", effort: "medium" },
        ],
        resolveProvider: resolvePoolEntry,
        classifyExhaustion: async () => ({ exhausted: true }),
        onProviderAttempt: (attempt) =>
          attempts.push({
            provider: attempt.providerName,
            model: attempt.model,
            effort: attempt.effort,
          }),
      },
      primary
    );

    actor.requestRun();
    await vi.advanceTimersByTimeAsync(10);

    expect(resolvePoolEntry).toHaveBeenLastCalledWith({
      provider: "codex",
      model: "gpt-5.6-sol",
      effort: "medium",
    });
    expect(attempts).toEqual([
      { provider: primary.providerName, model: "primary-model" },
      { provider: fallbackProvider.providerName, model: "gpt-5.6-sol", effort: "medium" },
    ]);
  });

  it("uses the next pool entry for a classified Claude session-limit exhaustion", async () => {
    let actor!: Actor;
    const primary = new FakeProvider(
      () => ({
        success: false,
        output: "You've hit your session limit · resets 6:20pm (UTC)",
        exitCode: 1,
      }),
      "claude-opus"
    );
    const fallbackProvider = new FakeProvider(() => {
      actor.declareYield();
      return { output: "fallback ok" };
    }, "sonnet");
    const seen: RunResult[] = [];
    actor = makeActor(
      {
        modelConfig: [
          { provider: "claude-opus", model: "opus" },
          { provider: "sonnet", model: "sonnet" },
        ],
        resolveProvider: (entry) => (entry.provider === "sonnet" ? fallbackProvider : primary),
        classifyExhaustion: async (result) => ({
          exhausted: deterministicExhaustionFallback(result.output) === "quota",
        }),
        onRunEnd: (r) => {
          seen.push(r);
        },
      },
      primary
    );
    actor.requestRun();
    await vi.advanceTimersByTimeAsync(10);
    expect(primary.calls).toHaveLength(1);
    expect(fallbackProvider.calls).toHaveLength(1);
    expect(seen[0]?.success).toBe(true);
  });

  it("does not retry a later pool candidate that the gate selected first", async () => {
    let actor!: Actor;
    const candidates: RawProviderModelConfig[] = [
      { provider: "provider-a", model: "model-a" },
      { provider: "provider-b", model: "model-b" },
      { provider: "provider-c", model: "model-c" },
    ];
    const calls: string[] = [];
    const providerB = new FakeProvider(
      () => ({
        success: false,
        output: "provider-b exhausted",
        exitCode: 1,
      }),
      "provider-b"
    );
    const providerA = new FakeProvider(() => {
      calls.push("provider-a");
      actor.declareYield();
      return { output: "recovered on a" };
    }, "provider-a");
    const providerC = new FakeProvider(() => {
      calls.push("provider-c");
      return { output: "never reached" };
    }, "provider-c");

    const seen: RunResult[] = [];
    actor = makeActor(
      {
        modelConfig: candidates,
        // Gate selects provider-b (index 1) first:
        gate: (fn, poolCandidates) => {
          const chosen = poolCandidates[1];
          if (!chosen) throw new Error("expected candidate at index 1");
          return fn(chosen);
        },
        resolveProvider: (entry) => {
          if (entry.provider === "provider-b") return providerB;
          if (entry.provider === "provider-a") return providerA;
          return providerC;
        },
        classifyExhaustion: async (r) => ({
          exhausted: r.output.includes("exhausted"),
        }),
        onRunEnd: (r) => {
          seen.push(r);
        },
      },
      providerB
    );

    actor.requestRun();
    await vi.advanceTimersByTimeAsync(10);

    expect(providerB.calls).toHaveLength(1);
    expect(calls).toEqual(["provider-a"]);
    expect(providerC.calls).toHaveLength(0);
    expect(seen[0]?.success).toBe(true);
    expect(seen[0]?.output).toBe("recovered on a");
  });

  it("skips a halted recovery candidate and tries the next configured pool entry", async () => {
    let actor!: Actor;
    const primary = new FakeProvider(
      () => ({ success: false, output: "quota exhausted primary", exitCode: 1 }),
      "primary-model"
    );
    const haltedProvider = new FakeProvider(() => ({ output: "should not run" }), "halted-model");
    const nextProvider = new FakeProvider(() => {
      actor.declareYield();
      return { output: "recovered after halt skip", exitCode: 0, success: true };
    }, "next-model");
    const diagnostics: PoolFallbackDiagnostic[] = [];
    const seen: RunResult[] = [];

    actor = makeActor(
      {
        modelConfig: [
          { provider: "primary", model: "first" },
          { provider: "halted-p", model: "second" },
          { provider: "next-p", model: "third" },
        ],
        resolveProvider: (entry) => {
          if (entry.provider === "halted-p") return haltedProvider;
          if (entry.provider === "next-p") return nextProvider;
          return primary;
        },
        classifyExhaustion: async (r) => ({
          exhausted: r.output.includes("quota exhausted"),
        }),
        recoveryEligibility: (entry) =>
          entry.provider === "halted-p"
            ? { eligible: false, reason: "halted" }
            : { eligible: true },
        onPoolFallback: (d) => diagnostics.push(d),
        onRunEnd: (r) => seen.push(r),
      },
      primary
    );

    actor.requestRun();
    await vi.advanceTimersByTimeAsync(10);

    expect(primary.calls).toHaveLength(1);
    expect(haltedProvider.calls).toHaveLength(0);
    expect(nextProvider.calls).toHaveLength(1);
    expect(seen[0]?.success).toBe(true);
    expect(seen[0]?.output).toBe("recovered after halt skip");
    expect(diagnostics).toMatchObject([
      {
        attempt: 2,
        failed: { provider: "primary", model: "first" },
        next: { provider: "halted-p", model: "second" },
        remainingAfter: 1,
        skipReason: "halted",
      },
      {
        attempt: 3,
        failed: { provider: "primary", model: "first" },
        next: { provider: "next-p", model: "third" },
        remainingAfter: 0,
      },
    ]);
    expect(diagnostics[1]?.skipReason).toBeUndefined();
  });

  it("skips a pacing-ineligible candidate and tries the next configured pool entry", async () => {
    let actor!: Actor;
    const primary = new FakeProvider(
      () => ({ success: false, output: "quota exhausted primary", exitCode: 1 }),
      "primary-model"
    );
    const pacingProvider = new FakeProvider(() => ({ output: "should not run" }), "pacing-model");
    const nextProvider = new FakeProvider(() => {
      actor.declareYield();
      return { output: "recovered after pacing skip", exitCode: 0, success: true };
    }, "next-model");
    const diagnostics: PoolFallbackDiagnostic[] = [];
    const seen: RunResult[] = [];

    actor = makeActor(
      {
        modelConfig: [
          { provider: "primary", model: "first" },
          { provider: "pacing-p", model: "second" },
          { provider: "next-p", model: "third" },
        ],
        resolveProvider: (entry) => {
          if (entry.provider === "pacing-p") return pacingProvider;
          if (entry.provider === "next-p") return nextProvider;
          return primary;
        },
        classifyExhaustion: async (r) => ({
          exhausted: r.output.includes("quota exhausted"),
        }),
        recoveryEligibility: (entry) =>
          entry.provider === "pacing-p"
            ? { eligible: false, reason: "pacing" }
            : { eligible: true },
        onPoolFallback: (d) => diagnostics.push(d),
        onRunEnd: (r) => seen.push(r),
      },
      primary
    );

    actor.requestRun();
    await vi.advanceTimersByTimeAsync(10);

    expect(primary.calls).toHaveLength(1);
    expect(pacingProvider.calls).toHaveLength(0);
    expect(nextProvider.calls).toHaveLength(1);
    expect(seen[0]?.success).toBe(true);
    expect(seen[0]?.output).toBe("recovered after pacing skip");
    expect(diagnostics[0]).toMatchObject({
      attempt: 2,
      failed: { provider: "primary", model: "first" },
      next: { provider: "pacing-p", model: "second" },
      remainingAfter: 1,
      skipReason: "pacing",
    });
    expect(diagnostics[1]).toMatchObject({
      attempt: 3,
      failed: { provider: "primary", model: "first" },
      next: { provider: "next-p", model: "third" },
      remainingAfter: 0,
    });
    expect(diagnostics[1]?.skipReason).toBeUndefined();
  });

  it("retries an entry the gate passed over earlier only when the hook reports it eligible", async () => {
    let eligible = false;
    let actor!: Actor;
    const providerA = new FakeProvider(() => {
      actor.declareYield();
      return { success: true, output: "recovered on entry-a", exitCode: 0 };
    }, "model-a");
    const providerB = new FakeProvider(
      () => ({ success: false, output: "quota exhausted on entry-b", exitCode: 1 }),
      "model-b"
    );

    const candidates = [
      { provider: "provider-a", model: "model-a" },
      { provider: "provider-b", model: "model-b" },
    ];

    const seen: RunResult[] = [];
    actor = makeActor(
      {
        modelConfig: candidates,
        gate: (fn, poolCandidates) => {
          // Gate passed over provider-a at launch and chose provider-b (index 1)
          const chosen = poolCandidates[1];
          if (!chosen) throw new Error("expected candidate at index 1");
          return fn(chosen);
        },
        resolveProvider: (entry) => (entry.provider === "provider-a" ? providerA : providerB),
        classifyExhaustion: async (r) => ({
          exhausted: r.output.includes("quota exhausted"),
        }),
        recoveryEligibility: (entry) =>
          entry.provider === "provider-a" && !eligible
            ? { eligible: false, reason: "pacing" }
            : { eligible: true },
        onRunEnd: (r) => seen.push(r),
      },
      providerB
    );

    // First attempt with provider-a ineligible (still pacing):
    actor.requestRun();
    await vi.advanceTimersByTimeAsync(10);

    expect(providerB.calls).toHaveLength(1);
    expect(providerA.calls).toHaveLength(0);
    expect(seen).toHaveLength(1);
    expect(seen[0]?.success).toBe(false);
    expect(seen[0]?.output).toContain("model pool exhausted");
    expect(seen[0]?.output).toContain("provider-a:model-a (pacing)");

    // Now provider-a becomes eligible:
    eligible = true;
    actor.requestRun();
    await vi.advanceTimersByTimeAsync(10);

    expect(providerB.calls).toHaveLength(2);
    expect(providerA.calls).toHaveLength(1);
    expect(seen).toHaveLength(2);
    expect(seen[1]?.success).toBe(true);
    expect(seen[1]?.output).toBe("recovered on entry-a");
  });

  it("surfaces terminal error naming reasons when all remaining pool entries are ineligible", async () => {
    const primary = new FakeProvider(
      () => ({
        success: false,
        output: "quota exhausted on primary",
        exitCode: 1,
      }),
      "primary-model"
    );
    const haltedProvider = new FakeProvider(undefined, "halted-model");
    const pacingProvider = new FakeProvider(undefined, "pacing-model");
    const seen: RunResult[] = [];

    const actor = makeActor(
      {
        modelConfig: [
          { provider: "primary", model: "first" },
          { provider: "provider-halted", model: "second" },
          { provider: "provider-pacing", model: "third" },
        ],
        resolveProvider: (entry) => {
          if (entry.provider === "provider-halted") return haltedProvider;
          if (entry.provider === "provider-pacing") return pacingProvider;
          return primary;
        },
        classifyExhaustion: async () => ({ exhausted: true }),
        recoveryEligibility: (entry) => {
          if (entry.provider === "provider-halted") {
            return { eligible: false, reason: "halted" };
          }
          if (entry.provider === "provider-pacing") {
            return { eligible: false, reason: "pacing" };
          }
          return { eligible: true };
        },
        onRunEnd: (r) => seen.push(r),
      },
      primary
    );

    actor.requestRun();
    await vi.advanceTimersByTimeAsync(10);

    expect(primary.calls).toHaveLength(1);
    expect(haltedProvider.calls).toHaveLength(0);
    expect(pacingProvider.calls).toHaveLength(0);
    expect(seen).toHaveLength(1);
    expect(seen[0]?.success).toBe(false);
    expect(seen[0]?.output).toContain("model pool exhausted");
    expect(seen[0]?.output).toContain("Attempted in order: primary:first");
    expect(seen[0]?.output).toContain("provider-halted:second (halted)");
    expect(seen[0]?.output).toContain("provider-pacing:third (pacing)");
  });

  it("keeps existing fallback behaviour when recoveryEligibility hook is absent", async () => {
    let actor!: Actor;
    const primary = new FakeProvider(
      () => ({ success: false, output: "quota exhausted on primary", exitCode: 1 }),
      "primary-model"
    );
    const fallbackProvider = new FakeProvider(() => {
      actor.declareYield();
      return { success: true, output: "recovered without hook", exitCode: 0 };
    }, "fallback-model");
    const seen: RunResult[] = [];

    actor = makeActor(
      {
        modelConfig: [
          { provider: "primary", model: "first" },
          { provider: "recovery", model: "second" },
        ],
        resolveProvider: (entry) => (entry.provider === "recovery" ? fallbackProvider : primary),
        classifyExhaustion: async () => ({ exhausted: true }),
        onRunEnd: (r) => seen.push(r),
      },
      primary
    );

    actor.requestRun();
    await vi.advanceTimersByTimeAsync(10);

    expect(primary.calls).toHaveLength(1);
    expect(fallbackProvider.calls).toHaveLength(1);
    expect(seen[0]?.success).toBe(true);
    expect(seen[0]?.output).toBe("recovered without hook");
  });

  it("surfaces targeted single-entry exhaustion advice mentioning portable precondition", () => {
    const message = formatPoolExhaustedFailure({
      attempted: [{ provider: "claude", model: "opus" }],
    });
    expect(message).toContain("all 1 configured pool entry");
    expect(message).toContain("switch to a portable actor (context.type: portable)");
  });

  it("reports the fail-fast all-skipped shape without an attempted list (#655)", () => {
    const message = formatPoolExhaustedFailure({
      attempted: [],
      skipped: [
        { entry: { provider: "claude", model: "opus" }, reason: "exhausted" },
        { entry: { provider: "codex", model: "gpt" }, reason: "exhausted" },
      ],
    });
    expect(message).toContain("model pool exhausted");
    expect(message).toContain("all 2 configured pool entries are currently ineligible");
    expect(message).toContain("none was attempted");
    expect(message).toContain("claude:opus (exhausted)");
    expect(message).toContain("codex:gpt (exhausted)");
    expect(message).not.toContain("Attempted in order");
  });

  it("surfaces a fail-fast pool exhaustion rejection verbatim, without a stack (#655)", async () => {
    const seen: RunResult[] = [];
    const actor = makeActor(
      {
        modelConfig: [
          { provider: "claude", model: "first" },
          { provider: "codex", model: "second" },
        ],
        gate: () =>
          Promise.reject(
            new PoolExhaustedError(
              formatPoolExhaustedFailure({
                attempted: [],
                skipped: [
                  { entry: { provider: "claude", model: "first" }, reason: "exhausted" },
                  { entry: { provider: "codex", model: "second" }, reason: "exhausted" },
                ],
              })
            )
          ),
        onRunEnd: (r) => seen.push(r),
      },
      new FakeProvider()
    );

    actor.requestRun();
    await vi.advanceTimersByTimeAsync(10);

    expect(seen).toHaveLength(1);
    expect(seen[0]?.success).toBe(false);
    expect(seen[0]?.output).toContain("model pool exhausted");
    expect(seen[0]?.output).toContain("none was attempted");
    expect(seen[0]?.output).toContain("claude:first (exhausted)");
    expect(seen[0]?.output).toContain("codex:second (exhausted)");
    // The summary is the whole output: no stack frames from the run boundary.
    expect(seen[0]?.output).not.toContain("PoolExhaustedError");
    expect(seen[0]?.output).not.toContain("    at ");
  });

  it("surfaces an actionable, ordered pool-exhaustion error without provider output", async () => {
    const primary = new FakeProvider(
      () => ({
        success: false,
        output: "RAW PRIMARY: usage credits depleted for prompt secret=abc",
        exitCode: 1,
      }),
      "primary-model"
    );
    const fallbackProvider = new FakeProvider(
      () => ({
        success: false,
        output: "RAW FALLBACK: rate limit exceeded for request body secret=xyz",
        exitCode: 1,
      }),
      "fallback-model"
    );
    const seen: RunResult[] = [];
    const actor = makeActor(
      {
        modelConfig: [
          { provider: "primary", model: "first", effort: "high" },
          { provider: "recovery", model: "second", effort: "low" },
        ],
        resolveProvider: (entry) => (entry.provider === "recovery" ? fallbackProvider : primary),
        classifyExhaustion: async () => ({ exhausted: true }),
        onRunEnd: (r) => {
          seen.push(r);
        },
      },
      primary
    );
    actor.requestRun();
    await vi.advanceTimersByTimeAsync(10);
    expect(primary.calls).toHaveLength(1);
    expect(fallbackProvider.calls).toHaveLength(1);
    expect(seen).toHaveLength(1);
    expect(seen[0]?.success).toBe(false);
    expect(seen[0]?.output).toContain("model pool exhausted");
    expect(seen[0]?.output).toContain(
      "Attempted in order: primary:first @ high -> recovery:second @ low."
    );
    expect(seen[0]?.output).toContain("Wait for a quota reset");
    expect(seen[0]?.output).not.toContain("RAW PRIMARY");
    expect(seen[0]?.output).not.toContain("RAW FALLBACK");
    expect(seen[0]?.output).not.toContain("secret=");
  });

  // When a recovery entry fails for a reason that is NOT exhaustion, the
  // report must still name the initial entry's exhaustion. Reverting the
  // `formatFallbackRecoveryFailure` wrap in actor.ts back to a bare
  // `return fallbackResult` turns this RED.
  it("reports the initial exhaustion when a recovery entry fails for a non-exhaustion reason", async () => {
    const primary = new FakeProvider(
      () => ({
        success: false,
        output: "RAW PRIMARY: usage credits depleted for prompt secret=abc",
        exitCode: 1,
      }),
      "primary-model"
    );
    // The real ISSUE_NUM shape: the fallback never starts because its model slug is
    // not configured. Nothing here is exhaustion — before the fix this error was
    // returned bare and became the whole story.
    const fallbackProvider = new FakeProvider(
      () => ({
        success: false,
        output: 'error: invalid --model "claude-sonnet-5": model is not recognized',
        exitCode: 1,
      }),
      "fallback-model"
    );
    const seen: RunResult[] = [];
    const actor = makeActor(
      {
        modelConfig: [
          { provider: "primary", model: "first" },
          { provider: "recovery", model: "fallback-model" },
        ],
        resolveProvider: (entry) => (entry.provider === "recovery" ? fallbackProvider : primary),
        // The initial failure classifies exhausted; recovery's failure does not.
        classifyExhaustion: async (r: RunResult) => ({
          exhausted: r.output.includes("RAW PRIMARY"),
        }),
        onRunEnd: (r) => {
          seen.push(r);
        },
      },
      primary
    );
    actor.requestRun();
    await vi.advanceTimersByTimeAsync(10);
    expect(primary.calls).toHaveLength(1);
    expect(fallbackProvider.calls).toHaveLength(1);
    expect(seen).toHaveLength(1);
    expect(seen[0]?.success).toBe(false);

    // The load-bearing fact: the primary ran out of quota. Without it, the reader's
    // first hypothesis is a bad model pin, and the true state is "wait 4 hours".
    expect(seen[0]?.output).toContain("primary:first exhausted");
    // The fallback's error is kept as context — it is how a real wiring bug stays
    // findable — but it must not be presented as the cause.
    expect(seen[0]?.output).toContain("recovery failed");
    expect(seen[0]?.output).toContain('invalid --model "claude-sonnet-5"');
    // ISSUE_NUM's scrub still holds: the primary is named as a condition, never pasted
    // raw, because provider output echoes the prompt and the prompt holds secrets.
    expect(seen[0]?.output).not.toContain("RAW PRIMARY");
    expect(seen[0]?.output).not.toContain("secret=");
  });

  // A configured recovery entry that cannot be resolved is a configuration
  // failure, not permission to reinterpret or skip its tuple. It is still
  // reported exhaustion-first: without this wrap the
  // resolver throw escapes to the terminal boundary as a bare stack and the
  // reader's first hypothesis is again a bad model pin, not "wait for quota".
  it("reports the initial exhaustion when the next pool entry cannot be resolved", async () => {
    const primary = new FakeProvider(
      () => ({
        success: false,
        output: "RAW PRIMARY: usage credits depleted for prompt secret=abc",
        exitCode: 7,
        sessionId: "primary-session",
      }),
      "primary-model"
    );
    const resolvePoolEntry = vi.fn((entry: RawProviderModelConfig): CodingProvider => {
      if (entry.provider === "primary") return primary;
      throw new Error(
        'model pin validation failed for provider "claude": rejected "fallback-model"'
      );
    });
    const seen: RunResult[] = [];
    const actor = makeActor(
      {
        modelConfig: [
          { provider: "primary", model: "first" },
          { provider: "recovery", model: "fallback-model" },
          { provider: "never", model: "never-reached" },
        ],
        resolveProvider: resolvePoolEntry,
        classifyExhaustion: async (r: RunResult) => ({
          exhausted: r.output.includes("RAW PRIMARY"),
        }),
        onRunEnd: (r) => {
          seen.push(r);
        },
      },
      primary
    );
    actor.requestRun();
    await vi.advanceTimersByTimeAsync(10);
    expect(primary.calls).toHaveLength(1);
    // Resolution failing is terminal for recovery, exactly like a recovery
    // attempt that failed for a non-exhaustion reason: later entries are not
    // tried under some other interpretation.
    expect(resolvePoolEntry).toHaveBeenCalledTimes(2);
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({ success: false, exitCode: 7, sessionId: "primary-session" });
    expect(seen[0]?.output).toContain("primary:first exhausted");
    expect(seen[0]?.output).toContain("recovery failed");
    expect(seen[0]?.output).toContain('model pin validation failed for provider "claude"');
    expect(seen[0]?.output).not.toContain("RAW PRIMARY");
    expect(seen[0]?.output).not.toContain("secret=");
  });

  it("synthesizes a failure result and still calls onRun when the provider throws", async () => {
    const provider = new FakeProvider(() => {
      throw new Error("spawn blew up");
    });
    const seen: RunResult[] = [];
    const actor = makeActor(
      {
        onRunEnd: (r) => {
          seen.push(r);
        },
      },
      provider
    );
    actor.requestRun();
    await vi.advanceTimersByTimeAsync(10);
    expect(seen).toHaveLength(1);
    expect(seen[0]?.success).toBe(false);
    expect(seen[0]?.output).toContain("spawn blew up");
  });

  it("synthesizes a failure and forwards it when buildPrompt throws (no escape)", async () => {
    // Same invariant as the provider-throw case above, adjacent failure mode:
    // prompt assembly runs inside the terminal-failure boundary (the portable-
    // context path reads mesh events and can throw). A build-throw must be
    // caught → synthesized failure → forwarded to onRun, and must NOT escape
    // executeTurn (which would leave the parent never told the worker died).
    const provider = new FakeProvider();
    const seen: RunResult[] = [];
    const actor = makeActor(
      {
        buildPrompt: () => {
          throw new Error("assembly blew up");
        },
        onRunEnd: (r) => {
          seen.push(r);
        },
      },
      provider
    );
    actor.requestRun();
    // If executeTurn let the build-throw escape, this await would reject and fail
    // the test — draining the timers cleanly is the no-escape assertion.
    await vi.advanceTimersByTimeAsync(10);
    expect(seen).toHaveLength(1);
    expect(seen[0]?.success).toBe(false);
    expect(seen[0]?.output).toContain("assembly blew up");
    expect(provider.calls).toHaveLength(0); // threw before the provider was invoked
  });

  it("settles cleanly without a corrective yield prompt when a run ends without yield (#664)", async () => {
    const provider = new FakeProvider();
    const actor = makeActor({}, provider);
    actor.requestRun();
    await vi.advanceTimersByTimeAsync(10);
    await flush();
    expect(provider.calls).toHaveLength(1);
  });

  it("does not synthesize capping or run failures when a run ends without yield (#664)", async () => {
    const continued: number[] = [];
    const capped = vi.fn();
    const seen: RunResult[] = [];
    const provider = new FakeProvider(); // never yields
    const actor = makeActor(
      {
        onContinue: (n) => continued.push(n),
        onContinuationCapped: capped,
        onRunEnd: (result) => {
          seen.push(result);
        },
      },
      provider
    );
    actor.requestRun();
    await vi.advanceTimersByTimeAsync(10);
    await flush();
    expect(provider.calls).toHaveLength(1);
    expect(continued).toEqual([]);
    expect(capped).not.toHaveBeenCalled();
    expect(seen).toHaveLength(1);
    expect(seen[0]?.success).toBe(true);
  });

  it("does not queue responsive yield-elicitation runs when a run completes (#664)", async () => {
    const queuedEvents: { responsive: boolean; mode: string }[] = [];
    const provider = new FakeProvider();
    const actor = makeActor(
      {
        onQueued: (event) => queuedEvents.push(event),
      },
      provider
    );
    actor.requestRun();
    await vi.advanceTimersByTimeAsync(10);
    await flush();
    expect(provider.calls).toHaveLength(1);
    expect(queuedEvents).toEqual([{ responsive: false, mode: "ordinary" }]);
  });

  it("does not notify parent of failure when a run ends without yield (#664)", async () => {
    const toParent: string[] = [];
    const provider = new FakeProvider();
    const deps = {
      actors: { get: () => ({ id: "a1", parentId: "root" }) as ActorRecord },
      sendToParent: (_toId: string, body: string) => toParent.push(body),
      postToErrorChat: null,
      rootId: "root",
      log: () => {},
    };
    const actor = makeActor(
      {
        onRunEnd: async (result) => {
          if (!result.success && !result.capped) {
            await routeRunFailure(deps, "a1", result);
          }
        },
      },
      provider
    );
    actor.requestRun();
    await vi.advanceTimersByTimeAsync(10);
    await flush();
    expect(provider.calls).toHaveLength(1);
    expect(toParent).toHaveLength(0);
  });

  it("runs only once when maxContinuations is zero and does not yield (#664)", async () => {
    const provider = new FakeProvider();
    const actor = makeActor({ maxContinuations: 0 }, provider);
    actor.requestRun();
    await vi.advanceTimersByTimeAsync(10);
    await flush();
    expect(provider.calls).toHaveLength(1);
  });

  it("does not elicit yield after a failed run", async () => {
    const provider = new FakeProvider(() => ({ success: false, output: "boom", exitCode: 1 }));
    const onContinue = vi.fn();
    const actor = makeActor({ maxContinuations: 5, onContinue }, provider);
    actor.requestRun();
    await vi.advanceTimersByTimeAsync(10);
    await flush();
    expect(provider.calls).toHaveLength(1);
    expect(onContinue).not.toHaveBeenCalled();
  });

  it("does not elicit yield for a wake that beforeRun gated off", async () => {
    const provider = new FakeProvider();
    const onContinue = vi.fn();
    const actor = makeActor({ maxContinuations: 5, beforeRun: () => false, onContinue }, provider);
    actor.requestRun();
    await vi.advanceTimersByTimeAsync(10);
    await flush();
    expect(provider.calls).toHaveLength(0); // gated off
    expect(onContinue).not.toHaveBeenCalled();
  });

  it("exposes content-free lifecycle context only after beforeRun passes", async () => {
    const queued = vi.fn();
    const provider = new FakeProvider();
    const blocked = makeActor({ beforeRun: () => false, onQueued: queued }, provider);
    blocked.requestRun();
    await vi.advanceTimersByTimeAsync(10);
    await flush();
    expect(queued).not.toHaveBeenCalled();

    const accepted = makeActor({ beforeRun: () => true, onQueued: queued }, provider);
    accepted.requestRun();
    await vi.advanceTimersByTimeAsync(10);
    await flush();
    expect(queued).toHaveBeenCalledWith({ responsive: false, mode: "ordinary" });
  });

  it("passes mcpServers and addDirs through to the provider", async () => {
    const provider = new FakeProvider();
    const mcpServers = [{ name: "tracker", url: "http://x/mcp/tracker" }];
    const actor = makeActor({ mcpServers, addDirs: ["/repo"] }, provider);
    actor.requestRun();
    await vi.advanceTimersByTimeAsync(10);
    const call = provider.calls[0] as RunOptions;
    expect(call.mcpServers).toEqual(mcpServers);
    expect(call.addDirs).toEqual(["/repo"]);
  });

  describe("run start lifecycle", () => {
    // onQueued fires outside the gate; onRunStart means "started" and fires
    // inside it. Collapsing the two is what made a
    // queued run indistinguishable from a stalled one on the timeline: both
    // show a queued event and no output.
    it("fires onRunStart inside the gate, not when the run is merely queued", async () => {
      let releaseGate!: () => void;
      const gateHeld = new Promise<void>((resolve) => {
        releaseGate = resolve;
      });
      const order: string[] = [];
      let actor!: Actor;
      const provider = new FakeProvider(() => {
        actor.declareYield();
        return {};
      });
      actor = makeActor(
        {
          onQueued: () => order.push("queued"),
          onRunStart: () => order.push("start"),
          gate: async (fn, candidates) => {
            await gateHeld;
            return fn(candidates[0]);
          },
        },
        provider
      );

      actor.requestRun();
      await vi.advanceTimersByTimeAsync(10); // Debounce

      // Queued: requested, but the provider has not been invoked. This is the
      // window a stall report must not confuse for a started run.
      expect(order).toEqual(["queued"]);
      expect(provider.calls).toHaveLength(0);

      releaseGate();
      await flush();

      expect(order).toEqual(["queued", "start"]);
      expect(provider.calls).toHaveLength(1);
    });

    it("does not fire onRunStart for a run beforeRun gated off", async () => {
      let started = 0;
      const provider = new FakeProvider();
      const actor = makeActor({ beforeRun: () => false, onRunStart: () => started++ }, provider);

      actor.requestRun();
      await vi.advanceTimersByTimeAsync(10);

      expect(started).toBe(0);
      expect(provider.calls).toHaveLength(0);
    });

    it("contains an onStart observer failure without aborting the run or preventing provider execution", async () => {
      const results: RunResult[] = [];
      let actor!: Actor;
      const provider = new FakeProvider(() => {
        actor.declareYield();
        return { success: true, exitCode: 0, output: "done" };
      });
      const errors: unknown[] = [];
      const lifecycle = createActorLifecycle(
        [
          {
            onStart: () => {
              throw new Error("launch configuration rejected");
            },
            onEnd: (event) => {
              if (event.terminal.kind === "result") {
                results.push(event.terminal.result);
              }
            },
          },
        ],
        (failure) => errors.push(failure.error)
      );
      actor = makeActor({ lifecycle }, provider);

      actor.requestRun();
      await vi.advanceTimersByTimeAsync(10);
      await flush();

      expect(provider.calls).toHaveLength(1);
      expect(errors).toHaveLength(1);
      expect(results).toHaveLength(1);
      expect(results[0]).toMatchObject({
        success: true,
        exitCode: 0,
      });
    });

    // The third timestamp : start says the provider was invoked, the
    // first chunk says it started ANSWERING. Without the pair, "started and
    // silent" and "answered then stopped" are the same shape on the timeline —
    // and every watchdog kill on record is the former wearing the latter's name.
    it("fires onFirstChunk once on the provider's first chunk, not per chunk", async () => {
      const order: string[] = [];
      let actor!: Actor;
      const provider = new FakeProvider((opts) => {
        opts.onChunk?.("first");
        opts.onChunk?.("second");
        opts.onChunk?.("third");
        actor.declareYield();
        return {};
      });
      actor = makeActor(
        {
          onRunStart: () => order.push("start"),
          onFirstChunk: () => order.push("first-chunk"),
        },
        provider
      );

      actor.requestRun();
      await vi.advanceTimersByTimeAsync(10); // Debounce
      await flush();

      // Once, and strictly after start — three chunks, one hook.
      expect(order).toEqual(["start", "first-chunk"]);
    });

    // The absence IS the datum: a run killed before the provider answers must
    // leave started-with-no-first-chunk on the timeline. Synthesizing a first
    // chunk on the silent path would collapse the distinction this exists for.
    it("does not fire onFirstChunk when the provider emits nothing", async () => {
      let firstChunks = 0;
      let started = 0;
      let actor!: Actor;
      const provider = new FakeProvider(() => {
        actor.declareYield();
        return {}; // never calls onChunk — the zero-byte run
      });
      actor = makeActor(
        {
          onRunStart: () => started++,
          onFirstChunk: () => firstChunks++,
        },
        provider
      );

      actor.requestRun();
      await vi.advanceTimersByTimeAsync(10); // Debounce
      await flush();

      expect(started).toBe(1);
      expect(firstChunks).toBe(0);
    });
  });

  describe("activity watchdog", () => {
    // The watchdog measures *execution*, not queueing. The gate (rate limit +
    // a maxConcurrent-bounded FIFO) can hold a run far longer than either
    // timeout; a run that hasn't started has by definition produced no output,
    // so a timer running across the gate reads "queued" as "stalled".
    it("queue time does not count against the stall timer", async () => {
      let releaseGate!: () => void;
      const gateHeld = new Promise<void>((resolve) => {
        releaseGate = resolve;
      });
      const provider = new FakeProvider();
      const actor = makeActor(
        {
          gate: async (fn, candidates) => {
            await gateHeld;
            return fn(candidates[0]);
          },
        },
        provider
      );

      actor.requestRun();
      await vi.advanceTimersByTimeAsync(10); // Debounce

      // Queued behind other runs for longer than the stall timeout.
      await vi.advanceTimersByTimeAsync(WATCHDOG_STALL_TIMEOUT_MS + 60_000);
      expect(provider.calls).toHaveLength(0);

      releaseGate();
      await flush();

      // The run must start alive: abort() is idempotent, so a queue-time abort
      // burns the only abort the run will ever get and leaves it unwatched for
      // the rest of its life.
      expect(provider.calls.length).toBeGreaterThanOrEqual(1);
      expect((provider.calls[0] as RunOptions).signal?.aborted).toBe(false);
    });

    it("queue time does not count against the run ceiling", async () => {
      let releaseGate!: () => void;
      const gateHeld = new Promise<void>((resolve) => {
        releaseGate = resolve;
      });
      const provider = new FakeProvider();
      const actor = makeActor(
        {
          timeoutMs: 60_000,
          gate: async (fn, candidates) => {
            await gateHeld;
            return fn(candidates[0]);
          },
        },
        provider
      );

      actor.requestRun();
      await vi.advanceTimersByTimeAsync(10); // Debounce

      await vi.advanceTimersByTimeAsync(120_000); // twice the ceiling, all queued
      expect(provider.calls).toHaveLength(0);

      releaseGate();
      await flush();

      expect(provider.calls.length).toBeGreaterThanOrEqual(1);
      expect((provider.calls[0] as RunOptions).signal?.aborted).toBe(false);
    });

    it("output chunks reset the stall timer", async () => {
      let resolveRun!: (res: RunResult) => void;
      const runPromise = new Promise<RunResult>((resolve) => {
        resolveRun = resolve;
      });
      const provider = new FakeProvider(() => runPromise);
      const actor = makeActor({}, provider);

      actor.requestRun();
      await vi.advanceTimersByTimeAsync(10); // Debounce

      const call = provider.calls[0] as RunOptions;
      expect(call.signal?.aborted).toBe(false);

      // Advance by 4 minutes (less than 15 min stall)
      await vi.advanceTimersByTimeAsync(4 * 60 * 1000);
      expect(call.signal?.aborted).toBe(false);

      // Send a chunk, which should reset the stall timer
      call.onChunk?.("chunk");

      // Advance by another 4 minutes (total 8 minutes execution, but only 4 min since last chunk)
      await vi.advanceTimersByTimeAsync(4 * 60 * 1000);
      expect(call.signal?.aborted).toBe(false);

      // Resolve the run
      resolveRun({
        success: true,
        exitCode: 0,
        output: "done",
      });
      await flush();
    });

    it("15-min silence triggers kill", async () => {
      let resolveRun!: (res: RunResult) => void;
      const runPromise = new Promise<RunResult>((resolve) => {
        resolveRun = resolve;
      });
      const provider = new FakeProvider(() => runPromise);
      const actor = makeActor({}, provider);

      actor.requestRun();
      await vi.advanceTimersByTimeAsync(10); // Debounce

      const call = provider.calls[0] as RunOptions;
      expect(call.signal?.aborted).toBe(false);

      // Advance by 15 minutes
      await vi.advanceTimersByTimeAsync(WATCHDOG_STALL_TIMEOUT_MS);
      expect(call.signal?.aborted).toBe(true);

      resolveRun({
        success: false,
        exitCode: 143,
        output: "stalled",
      });
      await flush();
    });

    it("gives the provider a 30-second grace margin past the actor ceiling timeoutMs", async () => {
      let resolveRun!: (res: RunResult) => void;
      const runPromise = new Promise<RunResult>((resolve) => {
        resolveRun = resolve;
      });
      const provider = new FakeProvider(() => runPromise);
      const actor = makeActor({}, provider);

      actor.requestRun();
      await vi.advanceTimersByTimeAsync(10); // Debounce

      const call = provider.calls[0] as RunOptions;
      expect(call.timeoutMs).toBe(WATCHDOG_CEILING_TIMEOUT_MS + 30_000);

      resolveRun({
        success: true,
        exitCode: 0,
        output: "done",
      });
      await flush();
    });

    it("a normal completing run is never killed", async () => {
      let resolveRun!: (res: RunResult) => void;
      const runPromise = new Promise<RunResult>((resolve) => {
        resolveRun = resolve;
      });
      const provider = new FakeProvider(() => runPromise);
      const actor = makeActor({}, provider);

      actor.requestRun();
      await vi.advanceTimersByTimeAsync(10); // Debounce

      const call = provider.calls[0] as RunOptions;
      expect(call.signal?.aborted).toBe(false);

      // Advance by 3 minutes (less than stall, less than ceiling)
      await vi.advanceTimersByTimeAsync(3 * 60 * 1000);
      expect(call.signal?.aborted).toBe(false);

      // Complete the run successfully
      resolveRun({
        success: true,
        exitCode: 0,
        output: "done",
      });
      await vi.advanceTimersByTimeAsync(0);
      await flush();

      // Now advance time past the stall timeout (e.g. another 10 minutes)
      await vi.advanceTimersByTimeAsync(10 * 60 * 1000);
      // It should not be aborted since timers should have been cleaned up
      expect(call.signal?.aborted).toBe(false);
    });
  });

  describe("Voice Quick-Start Coalesce-Kill", () => {
    it("(a) a responsive voice nudge quick-starts — bypasses the debounce timer", async () => {
      let resolveRun!: (res: RunResult) => void;
      const provider = new FakeProvider(() => {
        return new Promise<RunResult>((resolve) => {
          resolveRun = resolve;
        });
      });
      const actor = makeActor({ debounceMs: 30000 }, provider);
      actor.requestRun({ priority: "responsive", voiceTimestamp: Date.now() });
      // Bypasses debounce, should run immediately without advancing time
      await flush();
      expect(provider.calls).toHaveLength(1);

      resolveRun({
        success: true,
        exitCode: 0,
        output: "done",
      });
      await flush();
    });

    it("(b) coalesce-kill retains a dirty follow-up and surfaces the coalesced count", async () => {
      let resolveRun!: (res: RunResult) => void;
      const runPromises: Array<Promise<RunResult>> = [];
      const provider = new FakeProvider(() => {
        const p = new Promise<RunResult>((resolve) => {
          resolveRun = resolve;
        });
        runPromises.push(p);
        return p;
      });
      const events: { kind: string; detail: string }[] = [];
      let completedRuns = 0;
      const actor = makeActor(
        {
          debounceMs: 30000,
          onCoalesceAborted: (count, _ageMs) =>
            events.push({ kind: "run_coalesced", detail: `count: ${count}` }),
          onRunEnd: async () => {
            completedRuns++;
          },
        },
        provider
      );

      const now = Date.now();
      actor.requestRun({ priority: "responsive", voiceTimestamp: now });
      await flush();
      expect(provider.calls).toHaveLength(1);

      // Second voice event during the first run
      actor.requestRun({ priority: "responsive", voiceTimestamp: now + 100 });
      await flush();

      const call1 = provider.calls[0] as RunOptions;
      expect(call1.signal?.aborted).toBe(true);

      // Resolve the aborted run
      resolveRun({
        success: false,
        exitCode: 143,
        output: "aborted",
      });
      await flush();

      // A content-free dirty follow-up starts automatically.
      expect(provider.calls).toHaveLength(2);
      expect(provider.calls[1].prompt).toBe("PROMPT: inbox work");

      expect(completedRuns).toBe(0);

      const coalesceEvents = events.filter((e) => e.kind === "run_coalesced");
      expect(coalesceEvents).toHaveLength(1);
      // the run_coalesced event is emitted with coalesceCount
      expect(coalesceEvents[0].detail).toContain("count: 2");

      // Complete the second run successfully
      resolveRun({
        success: true,
        exitCode: 0,
        output: "done",
      });
      await flush();

      expect(completedRuns).toBe(1);
    });

    it("(c) first-outward-act flips killability", async () => {
      let resolveRun!: (res: RunResult) => void;
      const provider = new FakeProvider(() => {
        return new Promise<RunResult>((resolve) => {
          resolveRun = resolve;
        });
      });
      const actor = makeActor({ debounceMs: 30000 }, provider);

      actor.requestRun({ priority: "responsive", voiceTimestamp: Date.now() });
      await flush();
      expect(provider.calls).toHaveLength(1);

      actor.markUnkillable();

      actor.requestRun({ priority: "responsive", voiceTimestamp: Date.now() });
      await flush();

      const call1 = provider.calls[0] as RunOptions;
      expect(call1.signal?.aborted).toBe(false); // First run is NOT aborted!
      expect(provider.calls).toHaveLength(1);

      resolveRun({
        success: true,
        exitCode: 0,
        output: "done",
      });
      await flush();

      // Wait for debounce since the new run is dirty but first run completed?
      // Wait, voice events bypass debounce, so it should run immediately.
      await flush();
      expect(provider.calls).toHaveLength(2);
    });

    it("(d) maxAge belt — past voiceCoalesceMaxAgeMs the in-flight run is no longer killable", async () => {
      let resolveRun!: (res: RunResult) => void;
      const provider = new FakeProvider(() => {
        return new Promise<RunResult>((resolve) => {
          resolveRun = resolve;
        });
      });
      const actor = makeActor({ debounceMs: 30000, voiceCoalesceMaxAgeMs: 5000 }, provider);

      const now = Date.now();
      actor.requestRun({ priority: "responsive", voiceTimestamp: now });
      await flush();
      expect(provider.calls).toHaveLength(1);

      // Advance time beyond the max age
      await vi.advanceTimersByTimeAsync(6000);

      actor.requestRun({ priority: "responsive", voiceTimestamp: now + 6000 });
      await flush();

      const call1 = provider.calls[0] as RunOptions;
      expect(call1.signal?.aborted).toBe(false); // First run is NOT aborted!

      resolveRun({
        success: true,
        exitCode: 0,
        output: "done",
      });
      await flush();

      // Wait for debounce/voice fast-track
      await flush();
      expect(provider.calls).toHaveLength(2);
    });
  });

  describe("interrupt ", () => {
    it("aborts in-flight provider run with attributed interrupt reason and sets watermark", async () => {
      let resolveRun!: (res: RunResult) => void;
      const provider = new FakeProvider(() => {
        return new Promise<RunResult>((resolve) => {
          resolveRun = resolve;
        });
      });
      const onRunEnd = vi.fn();
      const actor = makeActor({ onRunEnd }, provider);

      actor.requestRun({ priority: "responsive" });
      await flush();

      expect(actor.isRunning).toBe(true);
      expect(provider.calls).toHaveLength(1);

      const call = provider.calls[0] as RunOptions;
      expect(call.signal?.aborted).toBe(false);

      const res = actor.interrupt("root");
      expect(res.interrupted).toBe(true);
      expect(res.runStartTime).toBeInstanceOf(Date);
      expect(call.signal?.aborted).toBe(true);
      expect(call.signal?.reason).toBe("interrupt:root");
      expect(actor.getInterruptedWatermark()).toEqual(res.runStartTime);

      resolveRun({
        success: false,
        exitCode: 143,
        cancelled: true,
        interrupted: true,
        output: "[Task interrupted by root]",
      });
      await flush();

      expect(onRunEnd).toHaveBeenCalledTimes(1);
      expect(onRunEnd.mock.calls[0][0]).toMatchObject({
        success: false,
        exitCode: 143,
        cancelled: true,
        interrupted: true,
        output: expect.stringContaining("interrupted by root"),
      });
    });

    it("forces success=false for non-grace aborts even if provider returns success=true", async () => {
      let resolveRun!: (res: RunResult) => void;
      const provider = new FakeProvider(() => {
        return new Promise<RunResult>((resolve) => {
          resolveRun = resolve;
        });
      });
      const onRunEnd = vi.fn();
      const actor = makeActor({ onRunEnd }, provider);

      actor.requestRun({ priority: "responsive" });
      await flush();

      actor.interrupt("root");

      // Provider incorrectly thinks it succeeded despite the abort
      resolveRun({
        success: true,
        exitCode: 0,
        output: "i am done",
      });
      await flush();

      expect(onRunEnd).toHaveBeenCalledTimes(1);
      expect(onRunEnd.mock.calls[0][0]).toMatchObject({
        success: false,
        exitCode: 143,
        cancelled: true,
        interrupted: true,
        interruptSource: "root",
        output: expect.stringContaining("i am done\n[Task interrupted by root]"),
      });
    });

    it("returns interrupted: false when actor is idle", async () => {
      const provider = new FakeProvider();
      const actor = makeActor({}, provider);

      expect(actor.isRunning).toBe(false);
      const res = actor.interrupt("human:operator");
      expect(res.interrupted).toBe(false);
    });

    it("preemptForResponsive bypasses markUnkillable and voice max-age", async () => {
      let resolveRun!: (res: RunResult) => void;
      const provider = new FakeProvider(() => {
        return new Promise<RunResult>((resolve) => {
          resolveRun = resolve;
        });
      });
      const actor = makeActor({ debounceMs: 30000, voiceCoalesceMaxAgeMs: 5000 }, provider);

      const now = Date.now();
      actor.requestRun({ priority: "responsive", voiceTimestamp: now });
      await flush();
      expect(provider.calls).toHaveLength(1);

      // Advance past max-age
      await vi.advanceTimersByTimeAsync(6000);

      // Mark unkillable
      actor.markUnkillable();

      const call = provider.calls[0] as RunOptions;
      expect(call.signal?.aborted).toBe(false);

      // Preempt
      const preemption = actor.preemptForResponsive();
      if (preemption.preempted === false) throw new Error("Expected preemption");
      expect(preemption.phase).toBe("running");
      expect(call.signal?.aborted).toBe(true);
      expect(call.signal?.reason).toBe("interrupt:responsive-notification");

      resolveRun({ success: false, exitCode: 1, output: "aborted" });
      await flush();
    });

    it("source-to-RunResult responsive attribution via termination-builder path", async () => {
      let resolveRun!: (res: RunResult) => void;
      const seen: RunResult[] = [];
      const provider = new FakeProvider(() => {
        return new Promise<RunResult>((resolve) => {
          resolveRun = resolve;
        });
      });
      const actor = makeActor(
        {
          onRunEnd: async (r) => {
            seen.push(r);
          },
        },
        provider
      );

      actor.requestRun();
      await vi.advanceTimersByTimeAsync(10);
      expect(actor.isRunning).toBe(true);

      // Preempt the executing run with a responsive wake
      const preemption = actor.preemptForResponsive();
      expect(preemption.preempted).toBe(true);

      // Resolve the provider without any manual attribution (it didn't use subprocess-execution)
      resolveRun({ success: false, output: "simulated output", exitCode: 1 });
      await flush();

      expect(seen).toHaveLength(1);
      const res = seen[0] as RunResult;
      expect(res.interrupted).toBe(true);
      expect(res.interruptSource).toBe("responsive-notification");
      expect(res.output).toContain("[Task interrupted by responsive-notification]");
    });
  });

  describe("yield grace period & isYielded", () => {
    it("reports isYielded accurately across run lifecycle", async () => {
      let actor!: Actor;
      const provider = new FakeProvider(() => {
        expect(actor.isYielded).toBe(false);
        actor.declareYield();
        expect(actor.isYielded).toBe(true);
        return { success: true };
      });
      actor = makeActor({}, provider);
      actor.requestRun();
      await vi.advanceTimersByTimeAsync(10);
      await flush();
      expect(actor.isYielded).toBe(true);
    });

    it("aborts run if process does not exit within yieldGraceMs and preserves yield status with graceKilled: true", async () => {
      let actor!: Actor;
      let abortedSignal: AbortSignal | undefined;
      const onRunEnd = vi.fn();

      const provider = new FakeProvider(async (opts: RunOptions) => {
        abortedSignal = opts.signal;
        actor.declareYield("complete");
        // Simulate a rogue process that keeps living after yield
        return new Promise<RunResult>((resolve) => {
          opts.signal?.addEventListener("abort", () => {
            resolve({
              success: false,
              exitCode: 143,
              cancelled: true,
              graceKilled: true,
              output: "[Task killed by supervisor (yield grace period exceeded)]",
            });
          });
        });
      });

      actor = makeActor({ yieldGraceMs: 5000, onRunEnd }, provider);
      actor.requestRun();
      await vi.advanceTimersByTimeAsync(10); // debounce

      expect(actor.isRunning).toBe(true);
      expect(actor.isYielded).toBe(true);
      expect(abortedSignal?.aborted).toBe(false);

      // Advance past 5000ms grace period
      await vi.advanceTimersByTimeAsync(5000);
      await flush();

      expect(abortedSignal?.aborted).toBe(true);
      expect(abortedSignal?.reason).toBe("yield-grace-exceeded");
      expect(onRunEnd).toHaveBeenCalledWith(
        expect.objectContaining({
          success: true,
          graceKilled: true,
          yieldStatus: "complete",
          exitCode: 143,
          output: expect.stringContaining("yield grace period exceeded"),
        })
      );
    });

    it("preserves blocked yield status when grace-killed", async () => {
      let actor!: Actor;
      const onRunEnd = vi.fn();

      const provider = new FakeProvider(async (opts: RunOptions) => {
        actor.declareYield("blocked", "waiting for reviewer");
        return new Promise<RunResult>((resolve) => {
          opts.signal?.addEventListener("abort", () => {
            resolve({
              success: false,
              exitCode: 143,
              cancelled: true,
              graceKilled: true,
              output: "[Task killed by supervisor (yield grace period exceeded)]",
            });
          });
        });
      });

      actor = makeActor({ yieldGraceMs: 3000, onRunEnd }, provider);
      actor.requestRun();
      await vi.advanceTimersByTimeAsync(10);

      await vi.advanceTimersByTimeAsync(3000);
      await flush();

      expect(onRunEnd).toHaveBeenCalledWith(
        expect.objectContaining({
          success: true,
          graceKilled: true,
          yieldStatus: "blocked",
          yieldNote: "waiting for reviewer",
          exitCode: 143,
        })
      );
    });

    it("reports kill without prior yield as failed", async () => {
      const onRunEnd = vi.fn();

      const provider = new FakeProvider(() => ({
        // Never calls declareYield
        success: false,
        exitCode: 143,
        cancelled: true,
        graceKilled: true,
        output: "[Task killed by supervisor (yield grace period exceeded)]",
      }));

      const actor = makeActor({ onRunEnd }, provider);
      actor.requestRun();
      await vi.advanceTimersByTimeAsync(10);
      await flush();

      expect(onRunEnd).toHaveBeenCalledWith(
        expect.objectContaining({
          success: false,
          graceKilled: true,
          exitCode: 143,
        })
      );
    });

    // #257 arbiter: a supervisor grace-kill is a cleanup termination, not a
    // capacity failure. Deleting the `graceKilled` short-circuit in
    // `runWithPoolFallback` turns this RED — the chain classifies the killed run,
    // relaunches on an already-aborted signal, and the run-end output becomes a
    // both-tiers-exhausted summary with the real termination diagnostic gone.
    it("does not spend the root pool on a supervisor grace-kill", async () => {
      let actor!: Actor;
      const onRunEnd = vi.fn();
      const classify = vi.fn(async () => ({ exhausted: true }));

      const primary = new FakeProvider(
        async (opts: RunOptions) =>
          new Promise<Partial<RunResult>>((resolve) => {
            actor.declareYield("complete", "work pushed");
            opts.signal?.addEventListener("abort", () => {
              // Exactly what a real provider builds on a SIGTERM path.
              resolve({ success: false, ...formatSigtermResult("agent transcript", opts.signal) });
            });
          }),
        "primary-model"
      );
      const fallbackProvider = new FakeProvider(undefined, "fallback-model");

      actor = makeActor(
        {
          yieldGraceMs: 5000,
          modelConfig: [
            { provider: "primary", model: "primary-model" },
            { provider: "recovery", model: "fallback-model" },
          ],
          resolveProvider: (entry) => (entry.provider === "recovery" ? fallbackProvider : primary),
          classifyExhaustion: classify,
          onRunEnd,
        },
        primary
      );
      actor.requestRun();
      await vi.advanceTimersByTimeAsync(10);
      await vi.advanceTimersByTimeAsync(5000);
      await flush();

      expect(classify).not.toHaveBeenCalled();
      expect(fallbackProvider.calls).toHaveLength(0);
      expect(onRunEnd).toHaveBeenCalledWith(
        expect.objectContaining({
          success: true,
          graceKilled: true,
          yieldStatus: "complete",
          yieldNote: "work pushed",
          exitCode: 143,
          // The raw termination diagnostic survives the run end.
          output: expect.stringContaining(
            "[Task killed by supervisor (yield grace period exceeded)]"
          ),
        })
      );
    });

    it("still reports a post-yield failure that is not a cleanup termination", async () => {
      let actor!: Actor;
      const onRunEnd = vi.fn();

      const provider = new FakeProvider(() => {
        actor.declareYield("complete", "done");
        // An unrelated error after the yield was accepted — no grace kill.
        return { success: false, exitCode: 1, output: "post-yield MCP write failed" };
      });

      actor = makeActor({ onRunEnd }, provider);
      actor.requestRun();
      await vi.advanceTimersByTimeAsync(10);
      await flush();

      expect(onRunEnd).toHaveBeenCalledWith(
        expect.objectContaining({
          success: false,
          exitCode: 1,
          yieldStatus: "complete",
          output: "post-yield MCP write failed",
        })
      );
      expect(onRunEnd.mock.calls[0]?.[0]?.graceKilled).toBeUndefined();
    });
  });

  describe("sandbox mount teardown on all exit paths ", () => {
    let teardownSpy: ReturnType<typeof vi.spyOn>;

    beforeEach(() => {
      teardownSpy = vi.spyOn(sandboxModule, "teardownFlutterOverlay");
    });

    afterEach(() => {
      teardownSpy.mockRestore();
    });

    it("tears down sandbox mounts on normal completion when sandbox is enabled", async () => {
      let actor!: Actor;
      const provider = new FakeProvider(() => {
        actor.declareYield("complete");
        return { success: true, exitCode: 0 };
      });

      actor = makeActor({ cwd: "/tmp/test-actor-normal", sandbox: true }, provider);
      actor.requestRun();
      await vi.advanceTimersByTimeAsync(10);
      await flush();

      expect(teardownSpy).toHaveBeenCalledWith("/tmp/test-actor-normal");
    });

    it("tears down sandbox mounts on error exit path when sandbox is enabled", async () => {
      const provider = new FakeProvider(() => {
        throw new Error("Provider spawn exploded");
      });

      const actor = makeActor({ cwd: "/tmp/test-actor-error", sandbox: true }, provider);
      actor.requestRun();
      await vi.advanceTimersByTimeAsync(10);
      await flush();

      expect(teardownSpy).toHaveBeenCalledWith("/tmp/test-actor-error");
    });

    it("tears down sandbox mounts on supervisor grace-kill exit path ", async () => {
      let actor!: Actor;

      const provider = new FakeProvider(async (opts: RunOptions) => {
        actor.declareYield("complete");
        // Simulate a process that hangs after yield until aborted by grace-kill
        return new Promise<RunResult>((resolve) => {
          opts.signal?.addEventListener("abort", () => {
            resolve({
              success: false,
              exitCode: 143,
              cancelled: true,
              graceKilled: true,
              output: "[Task killed by supervisor (yield grace period exceeded)]",
            });
          });
        });
      });

      actor = makeActor(
        { cwd: "/tmp/test-actor-grace-kill", sandbox: true, yieldGraceMs: 5000 },
        provider
      );
      actor.requestRun();
      await vi.advanceTimersByTimeAsync(10); // debounce

      expect(actor.isRunning).toBe(true);
      expect(teardownSpy).not.toHaveBeenCalled();

      // Grace period expires -> supervisor terminates process
      await vi.advanceTimersByTimeAsync(5000);
      await flush();

      expect(teardownSpy).toHaveBeenCalledWith("/tmp/test-actor-grace-kill");
    });

    it("tears down sandbox mounts on watchdog stall / ceiling timeout exit path", async () => {
      const provider = new FakeProvider(async (opts: RunOptions) => {
        return new Promise<RunResult>((resolve) => {
          opts.signal?.addEventListener("abort", () => {
            resolve({
              success: false,
              exitCode: 143,
              cancelled: true,
              output: "watchdog killed",
            });
          });
        });
      });

      const actor = makeActor(
        { cwd: "/tmp/test-actor-watchdog", sandbox: true, timeoutMs: 2000 },
        provider
      );
      actor.requestRun();
      await vi.advanceTimersByTimeAsync(10); // debounce

      // Advance past timeout
      await vi.advanceTimersByTimeAsync(2000);
      await flush();

      expect(teardownSpy).toHaveBeenCalledWith("/tmp/test-actor-watchdog");
    });

    it("tears down sandbox mounts on actor close", async () => {
      const actor = makeActor({ cwd: "/tmp/test-actor-close", sandbox: true });

      actor.close();

      expect(teardownSpy).toHaveBeenCalledWith("/tmp/test-actor-close");
    });

    it("skips teardown when sandbox is disabled", async () => {
      let actor!: Actor;
      const provider = new FakeProvider(() => {
        actor.declareYield("complete");
        return { success: true };
      });

      actor = makeActor({ cwd: "/tmp/test-actor-no-sandbox", sandbox: false }, provider);
      actor.requestRun();
      await vi.advanceTimersByTimeAsync(10);
      await flush();

      expect(teardownSpy).not.toHaveBeenCalledWith("/tmp/test-actor-no-sandbox");
    });
  });
});
