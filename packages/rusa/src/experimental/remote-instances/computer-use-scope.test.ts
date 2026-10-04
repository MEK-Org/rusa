import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Actor } from "../../actor/actor.js";
import { InMemoryCapabilityGrantStore } from "../../actor/capability-grants.js";
import {
  COMPUTER_USE_CAPABILITY,
  ComputerUseLock,
  createComputerUseAdmission,
} from "../../actor/computer-use-lock.js";
import { ProviderPacer } from "../../actor/provider-pacer.js";
import type { CodingProvider, RunOptions, RunResult } from "../../providers/types.js";
import { createHarness, waitUntil } from "./harness.js";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("computer-use scope enforcement and compatibility matrix (#885)", () => {
  it("a missing admission field denies on the repaired follower and skips the computer-use lock", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "rusa-885-missing-"));
    dirs.push(cwd);
    const invocations: RunOptions[] = [];
    const lock = vi.spyOn(ComputerUseLock.prototype, "gate");
    const h = createHarness({
      cwd,
      providerFactory: () => ({
        name: "fake-inventory",
        providerName: "instance-fixture",
        async run(opts) {
          invocations.push(opts);
          return { success: true, output: "fake-only", exitCode: 0 };
        },
      }),
    });
    const dispatch = h.follower.dispatch.bind(h.follower);
    h.follower.dispatch = (envelope) => {
      const message = envelope.message;
      if (
        message.type === "reply" &&
        message.value &&
        typeof message.value === "object" &&
        "computerUse" in message.value
      ) {
        const value = { ...message.value };
        delete (value as { computerUse?: boolean }).computerUse;
        dispatch({ ...envelope, message: { ...message, value } });
      } else dispatch(envelope);
    };
    try {
      h.spawn("synthetic missing admission");
      await waitUntil(() => invocations.length === 1);
      expect(invocations[0].computerUse).toBe(false);
      expect(lock).not.toHaveBeenCalled();
    } finally {
      await h.close();
      lock.mockRestore();
    }
  });

  for (const scenario of ["denied", "allowed", "queued-revoke"] as const) {
    it(`repaired leader to repaired follower propagates ${scenario} admission to provider invocation`, async () => {
      const cwd = mkdtempSync(join(tmpdir(), "rusa-885-repaired-"));
      dirs.push(cwd);

      const invocations: Array<Record<string, unknown>> = [];
      const admissions: boolean[] = [];
      const holdMs = 3_600_000;
      let skew = 0;
      const pacer = new ProviderPacer(0, () => Date.now() + skew);
      pacer.deferUntil(Date.now() + holdMs);

      const h = createHarness({
        cwd,
        pacer,
        providerFactory: () => ({
          name: "fake-inventory",
          providerName: "instance-fixture",
          async run(opts) {
            invocations.push({
              computerUse: opts.computerUse ?? "MISSING",
              optionKeys: Object.keys(opts).sort(),
            });
            return { success: true, output: "fake-only", exitCode: 0 };
          },
        }),
      });

      const dispatch = h.follower.dispatch.bind(h.follower);
      h.follower.dispatch = (envelope) => {
        const m = envelope.message;
        if (
          m.type === "reply" &&
          m.value &&
          typeof m.value === "object" &&
          "computerUse" in m.value
        ) {
          admissions.push((m.value as { computerUse: boolean }).computerUse);
        }
        dispatch(envelope);
      };

      try {
        const id = h.spawn(`synthetic ${scenario}`);
        if (scenario !== "denied") {
          h.capabilityGrants.grant({
            actorId: id,
            capability: COMPUTER_USE_CAPABILITY,
            grantedBy: "root",
            grantedAt: "2026-10-04T00:00:00Z",
          });
        }
        await waitUntil(() => h.runtime(id).isQueued);
        if (scenario === "queued-revoke") {
          h.capabilityGrants.revoke(id, COMPUTER_USE_CAPABILITY, "2026-10-04T00:01:00Z");
        }
        skew = holdMs * 2;
        pacer.deferUntil(0);
        await waitUntil(() => invocations.length === 1);

        const expected = scenario === "allowed";
        expect(admissions).toEqual([expected]);
        expect(invocations[0].computerUse).toBe(expected);
      } finally {
        await h.close();
      }
    });
  }

  it("repaired follower handles allowed-after-denied across sequential runs", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "rusa-885-allowed-after-denied-"));
    dirs.push(cwd);

    const invocations: Array<Record<string, unknown>> = [];
    const h = createHarness({
      cwd,
      providerFactory: () => ({
        name: "fake-inventory",
        providerName: "instance-fixture",
        async run(opts) {
          invocations.push({
            computerUse: opts.computerUse ?? "MISSING",
          });
          return { success: true, output: "sequential", exitCode: 0 };
        },
      }),
    });

    try {
      const id = h.spawn("sequential actor");
      // Run 1: denied (no grant)
      await waitUntil(() => invocations.length === 1);
      expect(invocations[0].computerUse).toBe(false);

      // Grant capability for Run 2
      h.capabilityGrants.grant({
        actorId: id,
        capability: COMPUTER_USE_CAPABILITY,
        grantedBy: "root",
        grantedAt: "2026-10-04T00:02:00Z",
      });

      // Trigger second run
      h.runtime(id).requestRun();
      await waitUntil(() => invocations.length === 2);
      expect(invocations[1].computerUse).toBe(true);
    } finally {
      await h.close();
    }
  });

  it("local actor execution integrates ComputerUseLock.gateAfterProvider and ProviderPacer to enforce authoritative admission including queued-revoke", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "rusa-885-local-"));
    dirs.push(cwd);

    const invocations: Array<Record<string, unknown>> = [];
    const grants = new InMemoryCapabilityGrantStore();
    const hasCapability = () => grants.activeFor("local-worker").includes(COMPUTER_USE_CAPABILITY);
    const admission = createComputerUseAdmission(hasCapability);
    const grant = () =>
      grants.grant({
        actorId: "local-worker",
        capability: COMPUTER_USE_CAPABILITY,
        grantedBy: "root",
        grantedAt: "2026-10-04T00:00:00Z",
      });
    const revoke = () =>
      grants.revoke("local-worker", COMPUTER_USE_CAPABILITY, "2026-10-04T00:01:00Z");
    const computerUseLock = new ComputerUseLock();
    let skew = 0;
    const holdMs = 3_600_000;
    const pacer = new ProviderPacer(0, () => Date.now() + skew);

    const provider: CodingProvider = {
      name: "instance-fixture",
      providerName: "instance-fixture",
      async run(opts: RunOptions): Promise<RunResult> {
        invocations.push({
          computerUse: opts.computerUse,
          hasKey: "computerUse" in opts,
        });
        return { success: true, output: "local-exec", exitCode: 0 };
      },
    };

    let sessionId: string | undefined;
    const actor = new Actor({
      id: "local-worker",
      cwd,
      modelConfig: [{ provider: "instance-fixture" }],
      mcpServers: [],
      resolveProvider: () => provider,
      debounceMs: 10,
      loadSessionId: () => sessionId,
      saveSessionId: (id) => {
        sessionId = id;
      },
      buildPrompt: () => ({ prompt: "local test" }),
      isComputerUseAdmitted: admission.isAdmitted,
      gate: (invoke, candidates, responsive) => {
        return computerUseLock.gateAfterProvider(
          "local-worker",
          responsive,
          (start) => {
            return pacer.submit(() => start(candidates[0]), {
              responsive,
              threadId: "local-worker",
              enqueueNormal: (fn) => ({
                result: fn(),
                started: true,
                promote: () => {},
                cancel: () => false,
              }),
            });
          },
          invoke,
          admission.shouldLock
        );
      },
    });

    try {
      // Run 1: denied (capability = false)
      revoke();
      actor.requestRun();
      await waitUntil(() => invocations.length === 1);
      expect(invocations[0].computerUse).toBe(false);

      // Run 2: allowed (capability = true)
      grant();
      actor.requestRun();
      await waitUntil(() => invocations.length === 2);
      expect(invocations[1].computerUse).toBe(true);

      // Run 3: queued-revoke
      // Capability is true when queued, pacer deferred to simulate queue hold
      grant();
      pacer.deferUntil(Date.now() + holdMs);
      actor.requestRun();

      // Wait until pacer has the request queued
      await waitUntil(() => pacer.waiting === 1);
      expect(invocations.length).toBe(2);

      // Revoke capability while queued in provider pacing
      revoke();

      // Release provider pacing by advancing time past holdMs
      skew = holdMs * 2;
      pacer.deferUntil(0);
      await waitUntil(() => invocations.length === 3);

      // Authoritative evaluation at launch observes revocation: evaluates to false
      expect(invocations[2].computerUse).toBe(false);
    } finally {
      computerUseLock.close();
    }
  });

  for (const [change, changeAt] of [
    ["grant", "primary"],
    ["grant", "fallback"],
    ["revoke", "primary"],
    ["revoke", "fallback"],
  ] as const) {
    it(`${change} at the ${changeAt} invocation respects the run's lock admission`, async () => {
      const cwd = mkdtempSync(join(tmpdir(), "rusa-885-late-grant-"));
      dirs.push(cwd);
      const grants = new InMemoryCapabilityGrantStore();
      const hasCapability = () =>
        grants.activeFor("local-worker").includes(COMPUTER_USE_CAPABILITY);
      const grant = () =>
        grants.grant({
          actorId: "local-worker",
          capability: COMPUTER_USE_CAPABILITY,
          grantedBy: "root",
          grantedAt: "2026-10-04T00:00:00Z",
        });
      if (change === "revoke") grant();
      const admission = createComputerUseAdmission(hasCapability);
      const lock = new ComputerUseLock();
      const lockGate = vi.spyOn(lock, "gate");
      const admissions: boolean[] = [];
      const invocations: Array<boolean | undefined> = [];
      const actor = new Actor({
        id: "local-worker",
        cwd,
        modelConfig: [{ provider: "primary" }, { provider: "fallback" }],
        mcpServers: [],
        resolveProvider: ({ provider }) => ({
          name: provider,
          providerName: provider,
          async run(opts) {
            invocations.push(opts.computerUse);
            return {
              success: provider === "fallback",
              output: "synthetic",
              exitCode: provider === "fallback" ? 0 : 1,
            };
          },
        }),
        classifyExhaustion: async () => ({ exhausted: true }),
        debounceMs: 10,
        loadSessionId: () => undefined,
        saveSessionId: () => {},
        buildPrompt: () => ({ prompt: "synthetic late grant" }),
        isComputerUseAdmitted: admission.isAdmitted,
        onProviderAttempt: async (attempt) => {
          if (attempt.providerName === changeAt) {
            if (change === "grant") grant();
            else grants.revoke("local-worker", COMPUTER_USE_CAPABILITY, "2026-10-04T00:01:00Z");
          }
        },
        gate: (invoke, candidates, responsive) =>
          lock.gateAfterProvider(
            "local-worker",
            responsive,
            (start) => start(candidates[0]),
            invoke,
            () => {
              const admitted = admission.shouldLock();
              admissions.push(admitted);
              return admitted;
            }
          ),
      });
      try {
        actor.requestRun();
        await waitUntil(() => invocations.length === 2 && !actor.isRunning);
        expect(admissions).toEqual([change === "revoke"]);
        expect(lockGate).toHaveBeenCalledTimes(change === "revoke" ? 1 : 0);
        expect(hasCapability()).toBe(change === "grant");
        expect(invocations).toEqual([change === "revoke" && changeAt === "fallback", false]);
      } finally {
        lock.close();
      }
    });
  }
});
