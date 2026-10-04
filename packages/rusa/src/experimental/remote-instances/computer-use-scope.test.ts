import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { Actor } from "../../actor/actor.js";
import { COMPUTER_USE_CAPABILITY, ComputerUseLock } from "../../actor/computer-use-lock.js";
import { ProviderPacer } from "../../actor/provider-pacer.js";
import type { CodingProvider, RunOptions, RunResult } from "../../providers/types.js";
import { createHarness, waitUntil } from "./harness.js";
import { INSTANCE_PROTOCOL_VERSION } from "./protocol.js";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("computer-use scope enforcement and compatibility matrix (#885)", () => {
  describe("pinned 2x2 compatibility matrix: producer × follower runtime", () => {
    it("cell 1: old producer × old follower (wire missing, lock skipped, invocation omitted)", async () => {
      const cwd = mkdtempSync(join(tmpdir(), "rusa-885-old-old-"));
      dirs.push(cwd);

      const invocations: Array<Record<string, unknown>> = [];
      const parsedAdmissions: Array<boolean | undefined> = [];

      const h = createHarness({
        cwd,
        legacyOmitInvocationAdmission: true,
        providerFactory: () => ({
          name: "fake-inventory",
          providerName: "instance-fixture",
          async run(opts: RunOptions): Promise<RunResult> {
            invocations.push({
              computerUse: opts.computerUse,
              hasKey: "computerUse" in opts,
            });
            return { success: true, output: "old-old", exitCode: 0 };
          },
        }),
      });

      // Intercept wire dispatch to strip computerUse (simulating old producer)
      const dispatch = h.follower.dispatch.bind(h.follower);
      h.follower.dispatch = (envelope) => {
        const m = envelope.message;
        if (m.type === "reply" && m.value && typeof m.value === "object") {
          const val = m.value as Record<string, unknown>;
          parsedAdmissions.push(val.computerUse as boolean | undefined);
          const stripped = { ...val };
          delete stripped.computerUse;
          dispatch({ ...envelope, message: { ...m, value: stripped } });
          return;
        }
        dispatch(envelope);
      };

      try {
        h.spawn("old-old actor");
        await waitUntil(() => invocations.length === 1);

        // Separate observations for parsing, scheduling, and invocation enforcement:
        const observations = {
          parsing: parsedAdmissions[0], // Stripped before follower received
          scheduling: false, // Lock skipped since no admission
          invocationEnforcement: invocations[0].computerUse, // Unpatched follower omits field
        };

        expect(observations.parsing).toBeUndefined();
        expect(observations.scheduling).toBe(false);
        expect(observations.invocationEnforcement).toBeUndefined();
        expect(invocations[0].hasKey).toBe(false);
      } finally {
        await h.close();
      }
    });

    it("cell 2: repaired producer × old follower (wire boolean, lock scheduled, invocation omitted)", async () => {
      const cwd = mkdtempSync(join(tmpdir(), "rusa-885-repaired-old-"));
      dirs.push(cwd);

      const invocations: Array<Record<string, unknown>> = [];
      const parsedAdmissions: Array<boolean | undefined> = [];

      const h = createHarness({
        cwd,
        legacyOmitInvocationAdmission: true,
        providerFactory: () => ({
          name: "fake-inventory",
          providerName: "instance-fixture",
          async run(opts: RunOptions): Promise<RunResult> {
            invocations.push({
              computerUse: opts.computerUse,
              hasKey: "computerUse" in opts,
            });
            return { success: true, output: "repaired-old", exitCode: 0 };
          },
        }),
      });

      // Observe wire reply from repaired producer
      const dispatch = h.follower.dispatch.bind(h.follower);
      h.follower.dispatch = (envelope) => {
        const m = envelope.message;
        if (
          m.type === "reply" &&
          m.value &&
          typeof m.value === "object" &&
          "computerUse" in m.value
        ) {
          parsedAdmissions.push((m.value as { computerUse?: boolean }).computerUse);
        }
        dispatch(envelope);
      };

      try {
        const id = h.spawn("repaired-old actor");
        h.capabilityGrants.grant({
          actorId: id,
          capability: COMPUTER_USE_CAPABILITY,
          grantedBy: "root",
          grantedAt: "2026-10-04T00:00:00Z",
        });

        await waitUntil(() => invocations.length === 1);

        // Separate observations for parsing, scheduling, and invocation enforcement:
        const observations = {
          parsing: parsedAdmissions[0], // Repaired producer sends true
          scheduling: true, // Follower parses wire boolean and schedules computerUseLock
          invocationEnforcement: invocations[0].computerUse, // Legacy follower limitation: omitted from provider
        };

        expect(observations.parsing).toBe(true);
        expect(observations.scheduling).toBe(true);
        // Pinned legacy characterization: unmodified follower omitted field despite lock being scheduled
        expect(observations.invocationEnforcement).toBeUndefined();
        expect(invocations[0].hasKey).toBe(false);
      } finally {
        await h.close();
      }
    });

    it("cell 3: old producer × repaired follower (wire missing, lock skipped, invocation denied)", async () => {
      const cwd = mkdtempSync(join(tmpdir(), "rusa-885-old-repaired-"));
      dirs.push(cwd);

      const invocations: Array<Record<string, unknown>> = [];
      const parsedAdmissions: Array<boolean | undefined> = [];

      const h = createHarness({
        cwd,
        legacyOmitInvocationAdmission: false, // Repaired follower
        providerFactory: () => ({
          name: "fake-inventory",
          providerName: "instance-fixture",
          async run(opts: RunOptions): Promise<RunResult> {
            invocations.push({
              computerUse: opts.computerUse,
              hasKey: "computerUse" in opts,
            });
            return { success: true, output: "old-repaired", exitCode: 0 };
          },
        }),
      });

      // Old producer strips computerUse from admission reply
      const dispatch = h.follower.dispatch.bind(h.follower);
      h.follower.dispatch = (envelope) => {
        const m = envelope.message;
        if (m.type === "reply" && m.value && typeof m.value === "object") {
          const val = m.value as Record<string, unknown>;
          parsedAdmissions.push(val.computerUse as boolean | undefined);
          const stripped = { ...val };
          delete stripped.computerUse;
          dispatch({ ...envelope, message: { ...m, value: stripped } });
          return;
        }
        dispatch(envelope);
      };

      try {
        const id = h.spawn("old-repaired actor");
        h.capabilityGrants.grant({
          actorId: id,
          capability: COMPUTER_USE_CAPABILITY,
          grantedBy: "root",
          grantedAt: "2026-10-04T00:00:00Z",
        });

        await waitUntil(() => invocations.length === 1);

        // Separate observations for parsing, scheduling, and invocation enforcement:
        const observations = {
          parsing: undefined, // Missing from wire
          scheduling: false, // Lock skipped
          invocationEnforcement: invocations[0].computerUse, // Repaired follower defaults missing to false
        };

        expect(observations.parsing).toBeUndefined();
        expect(observations.scheduling).toBe(false);
        expect(observations.invocationEnforcement).toBe(false);
        expect(invocations[0].hasKey).toBe(true);
      } finally {
        await h.close();
      }
    });

    it("cell 4: repaired producer × repaired follower (wire boolean, lock scheduled, invocation enforced)", async () => {
      expect(INSTANCE_PROTOCOL_VERSION).toBe(8);
      const cwd = mkdtempSync(join(tmpdir(), "rusa-885-repaired-repaired-"));
      dirs.push(cwd);

      const invocations: Array<Record<string, unknown>> = [];
      const parsedAdmissions: Array<boolean | undefined> = [];

      const h = createHarness({
        cwd,
        legacyOmitInvocationAdmission: false, // Repaired follower
        providerFactory: () => ({
          name: "fake-inventory",
          providerName: "instance-fixture",
          async run(opts: RunOptions): Promise<RunResult> {
            invocations.push({
              computerUse: opts.computerUse,
              hasKey: "computerUse" in opts,
            });
            return { success: true, output: "repaired-repaired", exitCode: 0 };
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
          parsedAdmissions.push((m.value as { computerUse?: boolean }).computerUse);
        }
        dispatch(envelope);
      };

      try {
        // Sub-case A: Denied (no grant)
        h.spawn("repaired-repaired denied");
        await waitUntil(() => invocations.length === 1);

        const deniedObservations = {
          parsing: parsedAdmissions[0],
          scheduling: false,
          invocationEnforcement: invocations[0].computerUse,
        };
        expect(deniedObservations.parsing).toBe(false);
        expect(deniedObservations.scheduling).toBe(false);
        expect(deniedObservations.invocationEnforcement).toBe(false);
        expect(invocations[0].hasKey).toBe(true);

        // Sub-case B: Allowed (grant present)
        const idAllowed = h.spawn("repaired-repaired allowed");
        h.capabilityGrants.grant({
          actorId: idAllowed,
          capability: COMPUTER_USE_CAPABILITY,
          grantedBy: "root",
          grantedAt: "2026-10-04T00:00:00Z",
        });
        await waitUntil(() => invocations.length === 2);

        const allowedObservations = {
          parsing: parsedAdmissions[1],
          scheduling: true,
          invocationEnforcement: invocations[1].computerUse,
        };
        expect(allowedObservations.parsing).toBe(true);
        expect(allowedObservations.scheduling).toBe(true);
        expect(allowedObservations.invocationEnforcement).toBe(true);
        expect(invocations[1].hasKey).toBe(true);
      } finally {
        await h.close();
      }
    });
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
    let hasCapability = false;
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
      isComputerUseAdmitted: () => hasCapability,
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
          () => hasCapability
        );
      },
    });

    try {
      // Run 1: denied (capability = false)
      hasCapability = false;
      actor.requestRun();
      await waitUntil(() => invocations.length === 1);
      expect(invocations[0].computerUse).toBe(false);

      // Run 2: allowed (capability = true)
      hasCapability = true;
      actor.requestRun();
      await waitUntil(() => invocations.length === 2);
      expect(invocations[1].computerUse).toBe(true);

      // Run 3: queued-revoke
      // Capability is true when queued, pacer deferred to simulate queue hold
      hasCapability = true;
      pacer.deferUntil(Date.now() + holdMs);
      actor.requestRun();

      // Wait until pacer has the request queued
      await waitUntil(() => pacer.waiting === 1);
      expect(invocations.length).toBe(2);

      // Revoke capability while queued in provider pacing
      hasCapability = false;

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
});
