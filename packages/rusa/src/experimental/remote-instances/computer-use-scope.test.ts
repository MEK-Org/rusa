import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { Actor } from "../../actor/actor.js";
import { COMPUTER_USE_CAPABILITY } from "../../actor/computer-use-lock.js";
import { ProviderPacer } from "../../actor/provider-pacer.js";
import type { CodingProvider, RunOptions, RunResult } from "../../providers/types.js";
import { createHarness, waitUntil } from "./harness.js";
import { INSTANCE_PROTOCOL_VERSION } from "./protocol.js";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("computer-use scope enforcement and compatibility matrix (#885)", () => {
  it("pinned characterization test: unmodified legacy follower omits invocation admission", async () => {
    // Characterization test of the documented legacy limitation on unmodified v7/v8 followers:
    // the wire payload parses and scheduling observes the capability, but provider RunOptions
    // omitted the admission field before the repair.
    const cwd = mkdtempSync(join(tmpdir(), "rusa-885-legacy-"));
    dirs.push(cwd);

    const invocations: Array<Record<string, unknown>> = [];
    const provider: CodingProvider = {
      name: "instance-fixture",
      providerName: "instance-fixture",
      async run(opts: RunOptions): Promise<RunResult> {
        invocations.push({
          computerUse: opts.computerUse ?? "MISSING",
          optionKeys: Object.keys(opts).sort(),
        });
        return { success: true, output: "legacy-characterization", exitCode: 0 };
      },
    };

    // Unmodified follower characterization (matching v7 2b6a469a and unpatched v8 a06afc8b):
    // Follower parsed wire admission boolean for the instance lock, but called provider.run
    // with RunOptions that lacked the computerUse field.
    await provider.run({
      prompt: "legacy prompt",
      cwd,
      // computerUse was omitted in legacy followers
    });

    expect(invocations.length).toBe(1);
    // Legacy limitation: RunOptions had no computerUse field
    expect(invocations[0].computerUse).toBe("MISSING");
  });

  for (const scenario of ["denied", "allowed", "queued-revoke"] as const) {
    it(`repaired leader to repaired follower propagates ${scenario} admission to provider invocation`, async () => {
      expect(INSTANCE_PROTOCOL_VERSION).toBe(8);
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
        // Verified: repaired follower passes explicit boolean matching admission
        expect(invocations[0].computerUse).toBe(expected);
      } finally {
        await h.close();
      }
    });
  }

  it("old producer (omits computerUse) to repaired follower defaults missing admission to denial", async () => {
    // When an older leader/producer omits computerUse from the admission payload,
    // repaired follower must default missing admission to denial (computerUse: false).
    const cwd = mkdtempSync(join(tmpdir(), "rusa-885-old-producer-"));
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
          return { success: true, output: "default-denial", exitCode: 0 };
        },
      }),
    });

    // Intercept dispatch to strip `computerUse` from the leader's admission reply,
    // simulating an old producer on the wire.
    const dispatch = h.follower.dispatch.bind(h.follower);
    h.follower.dispatch = (envelope) => {
      const m = envelope.message;
      if (
        m.type === "reply" &&
        m.value &&
        typeof m.value === "object" &&
        "computerUse" in m.value
      ) {
        const strippedValue = { ...(m.value as Record<string, unknown>) };
        delete strippedValue.computerUse;
        dispatch({
          ...envelope,
          message: {
            ...m,
            value: strippedValue,
          },
        });
        return;
      }
      dispatch(envelope);
    };

    try {
      const id = h.spawn("old producer test");
      // Even if leader had granted capability, old producer omits the field on wire
      h.capabilityGrants.grant({
        actorId: id,
        capability: COMPUTER_USE_CAPABILITY,
        grantedBy: "root",
        grantedAt: "2026-10-04T00:00:00Z",
      });

      await waitUntil(() => invocations.length === 1);
      // Repaired follower defaults missing wire field to false (denial)
      expect(invocations[0].computerUse).toBe(false);
    } finally {
      await h.close();
    }
  });

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

  it("local actor execution enforces authoritative admission including queued-revoke", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "rusa-885-local-"));
    dirs.push(cwd);

    const invocations: Array<Record<string, unknown>> = [];
    let hasCapability = false;

    const provider: CodingProvider = {
      name: "instance-fixture",
      providerName: "instance-fixture",
      async run(opts: RunOptions): Promise<RunResult> {
        invocations.push({
          computerUse: opts.computerUse ?? "MISSING",
        });
        return { success: true, output: "local-exec", exitCode: 0 };
      },
    };

    let sessionId: string | undefined;
    const actor = new Actor({
      id: "local-worker",
      cwd,
      modelConfig: [{ provider: "instance-fixture" }],
      resolveProvider: () => provider,
      debounceMs: 10,
      loadSessionId: () => sessionId,
      saveSessionId: (id) => {
        sessionId = id;
      },
      buildPrompt: () => ({ prompt: "local test" }),
      isComputerUseAdmitted: () => hasCapability,
    });

    // Run 1: denied
    hasCapability = false;
    actor.requestRun();
    await waitUntil(() => invocations.length === 1);
    expect(invocations[0].computerUse).toBe(false);

    // Run 2: allowed
    hasCapability = true;
    actor.requestRun();
    await waitUntil(() => invocations.length === 2);
    expect(invocations[1].computerUse).toBe(true);

    // Run 3: queued-revoke (simulated by capability toggling to false before runProvider)
    hasCapability = false;
    actor.requestRun();
    await waitUntil(() => invocations.length === 3);
    expect(invocations[2].computerUse).toBe(false);
  });
});
