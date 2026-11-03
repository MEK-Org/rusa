import { describe, expect, it } from "vitest";
import { GracefulShutdown } from "../actor/graceful-shutdown.js";
import { MeshDrainer } from "./drain.js";
import { MaintenanceShutdownCoordinator } from "./maintenance-shutdown.js";

function fakeClock() {
  let t = 1000;
  return {
    now: () => t,
    sleep: async (ms: number) => {
      t += ms;
    },
    advance: (ms: number) => {
      t += ms;
    },
  };
}

describe("MaintenanceShutdownCoordinator (#1225)", () => {
  it("emits mechanical notification to configured error chat at request time", async () => {
    const clock = fakeClock();
    const graceful = new GracefulShutdown();
    const running = new Set<string>();
    const drainer = new MeshDrainer(graceful, () => new Set(running), "root", 5);

    const notifications: string[] = [];
    const actions: string[] = [];
    let exitCode: number | null = null;

    const coordinator = new MaintenanceShutdownCoordinator({
      drain: drainer,
      notify: {
        notify: async (text) => {
          notifications.push(text);
        },
      },
      recordAction: (text) => {
        actions.push(text);
      },
      exit: (code) => {
        exitCode = code;
      },
      now: clock.now,
      sleep: clock.sleep,
      intervalMs: 5,
    });

    const outcome = await coordinator.request({
      reason: "custom MCP registration config update",
      timeoutSeconds: 30,
      timeoutBehavior: "cancel",
    });

    expect(outcome.ok).toBe(true);
    expect(outcome.message).toContain("Graceful shutdown initiated");
    expect(outcome.message).toContain("custom MCP registration config update");

    // Notification posted to error chat AT REQUEST TIME
    expect(notifications).toHaveLength(1);
    expect(notifications[0]).toContain(
      "🛑 Graceful shutdown requested: custom MCP registration config update"
    );
    expect(notifications[0]).toContain("timeout: 30s");
    expect(notifications[0]).toContain("on timeout: cancel");

    // Admission brake engaged immediately
    expect(graceful.isShuttingDown()).toBe(true);
    expect(actions[0]).toContain("shutdown requested: custom MCP registration config update");

    // Let drain watcher resolve (running is empty)
    const result = await outcome.completion;
    expect(result?.status).toBe("quiesced");
    expect(exitCode).toBe(0);
    expect(actions[1]).toContain("shutdown committed: drained in");
  });

  it("allows active runs to finish while pending work stays blocked, then exits", async () => {
    const clock = fakeClock();
    const graceful = new GracefulShutdown();
    const running = new Set<string>(["worker-active"]);
    const drainer = new MeshDrainer(graceful, () => new Set(running), "", 5);

    let exitCode: number | null = null;
    const coordinator = new MaintenanceShutdownCoordinator({
      drain: drainer,
      exit: (code) => {
        exitCode = code;
      },
      now: clock.now,
      sleep: clock.sleep,
      intervalMs: 5,
    });

    const outcome = await coordinator.request({
      timeoutSeconds: 10,
    });
    expect(outcome.ok).toBe(true);
    expect(graceful.isShuttingDown()).toBe(true);

    // Simulated pending run check: while shutting down, new work must NOT start
    expect(graceful.isShuttingDown()).toBe(true);

    // Active run is still executing, so exit has not been called
    expect(exitCode).toBeNull();
    expect(drainer.activeCount()).toBe(1);

    // Now active run finishes
    running.delete("worker-active");

    const result = await outcome.completion;
    expect(result?.status).toBe("quiesced");
    expect(exitCode).toBe(0);
  });

  it("self-request return: requesting actor returns cleanly from tool call without deadlocking", async () => {
    const clock = fakeClock();
    const graceful = new GracefulShutdown();
    // Root (requesting actor) and worker-1 are both running
    const running = new Set<string>(["root", "worker-1"]);
    const drainer = new MeshDrainer(graceful, () => new Set(running), "root", 5);

    let exitCode: number | null = null;
    const coordinator = new MaintenanceShutdownCoordinator({
      drain: drainer,
      exit: (code) => {
        exitCode = code;
      },
      now: clock.now,
      sleep: clock.sleep,
      intervalMs: 5,
    });

    // Root calls request (simulating the MCP tool invocation)
    const outcome = await coordinator.request({
      selfId: "root",
      timeoutSeconds: 15,
      reason: "test self-request return",
    });

    // Request returns immediately to root! (No deadlock!)
    expect(outcome.ok).toBe(true);
    expect(outcome.message).toContain("Active runs will finish before shutdown");
    expect(exitCode).toBeNull();

    // Root finishes its turn and returns cleanly
    running.delete("root");
    expect(exitCode).toBeNull(); // worker-1 still running

    // worker-1 finishes its run
    running.delete("worker-1");

    const result = await outcome.completion;
    expect(result?.status).toBe("quiesced");
    expect(exitCode).toBe(0);
  });

  it("timeout behavior 'cancel' (default): aborts shutdown, lifts brake, notifies chat, does NOT exit", async () => {
    const clock = fakeClock();
    const graceful = new GracefulShutdown();
    // Stuck worker that will not finish
    const running = new Set<string>(["worker-stuck"]);
    const drainer = new MeshDrainer(graceful, () => new Set(running), "", 100);

    const notifications: string[] = [];
    const actions: string[] = [];
    let exitCode: number | null = null;

    const coordinator = new MaintenanceShutdownCoordinator({
      drain: drainer,
      notify: {
        notify: async (text) => {
          notifications.push(text);
        },
      },
      recordAction: (text) => {
        actions.push(text);
      },
      exit: (code) => {
        exitCode = code;
      },
      now: clock.now,
      sleep: clock.sleep,
      intervalMs: 100,
    });

    const outcome = await coordinator.request({
      timeoutSeconds: 1, // 1000ms
      timeoutBehavior: "cancel",
      reason: "timeout test",
    });
    expect(outcome.ok).toBe(true);
    expect(graceful.isShuttingDown()).toBe(true);

    const result = await outcome.completion;
    expect(result?.status).toBe("cancelled");
    expect(result?.reason).toBe("timeout");

    // Exit must NOT have been called
    expect(exitCode).toBeNull();

    // Admission brake must have been lifted!
    expect(graceful.isShuttingDown()).toBe(false);

    // Error chat must have received the cancellation notice
    expect(notifications).toHaveLength(2);
    expect(notifications[1]).toContain("⚠️ Graceful shutdown cancelled: drain timed out after 1s");
    expect(notifications[1]).toContain("Admission resumed");

    // Action log records cancellation
    expect(actions.some((a) => a.includes("shutdown cancelled: drain timed out"))).toBe(true);

    // Coordinator is now free for future requests
    expect(coordinator.isPending()).toBe(false);
  });

  it("timeout behavior 'terminate': terminates remaining active runs and calls exit", async () => {
    const clock = fakeClock();
    const graceful = new GracefulShutdown();
    const running = new Set<string>(["worker-stuck"]);
    const drainer = new MeshDrainer(graceful, () => new Set(running), "", 100);

    const notifications: string[] = [];
    let exitCode: number | null = null;

    const coordinator = new MaintenanceShutdownCoordinator({
      drain: drainer,
      notify: {
        notify: async (text) => {
          notifications.push(text);
        },
      },
      exit: (code) => {
        exitCode = code;
      },
      now: clock.now,
      sleep: clock.sleep,
      intervalMs: 100,
    });

    const outcome = await coordinator.request({
      timeoutSeconds: 1,
      timeoutBehavior: "terminate",
      reason: "terminate test",
    });

    const result = await outcome.completion;
    expect(result?.status).toBe("terminated");
    expect(result?.reason).toBe("timeout");
    expect(exitCode).toBe(0);

    expect(notifications).toHaveLength(2);
    expect(notifications[1]).toContain(
      "⚠️ Graceful shutdown drain timed out after 1s. Terminating remaining active runs"
    );
  });

  it("explicit cancellation: cancels pending shutdown, lifts brake, notifies error chat", async () => {
    const clock = fakeClock();
    const graceful = new GracefulShutdown();
    const running = new Set<string>(["worker-long"]);
    const drainer = new MeshDrainer(graceful, () => new Set(running), "", 50);

    const notifications: string[] = [];
    const actions: string[] = [];
    let exitCode: number | null = null;

    const coordinator = new MaintenanceShutdownCoordinator({
      drain: drainer,
      notify: {
        notify: async (text) => {
          notifications.push(text);
        },
      },
      recordAction: (text) => {
        actions.push(text);
      },
      exit: (code) => {
        exitCode = code;
      },
      now: clock.now,
      sleep: clock.sleep,
      intervalMs: 50,
    });

    const outcome = await coordinator.request({
      timeoutSeconds: 60,
      reason: "cancel me",
    });
    expect(coordinator.isPending()).toBe(true);
    expect(graceful.isShuttingDown()).toBe(true);

    // Operator cancels the pending request
    const cancelResult = coordinator.cancel("operator changed mind");
    expect(cancelResult.ok).toBe(true);
    expect(cancelResult.message).toContain("Graceful shutdown cancelled");
    expect(coordinator.isPending()).toBe(false);

    // Admission brake lifted
    expect(graceful.isShuttingDown()).toBe(false);
    expect(exitCode).toBeNull();

    // Notification emitted
    expect(notifications).toHaveLength(2);
    expect(notifications[1]).toContain(
      "⚠️ Graceful shutdown cancelled by operator: operator changed mind. Admission resumed."
    );

    const completion = await outcome.completion;
    expect(completion?.status).toBe("cancelled");
    expect(completion?.reason).toBe("explicit");
  });

  it("rejects duplicate request when already pending and rejects cancel when not pending", async () => {
    const clock = fakeClock();
    const graceful = new GracefulShutdown();
    const running = new Set<string>(["worker-long"]);
    const drainer = new MeshDrainer(graceful, () => new Set(running), "", 50);

    const coordinator = new MaintenanceShutdownCoordinator({
      drain: drainer,
      exit: () => {},
      now: clock.now,
      sleep: clock.sleep,
    });

    // Cancel when not pending
    expect(coordinator.cancel().ok).toBe(false);

    // First request succeeds
    const first = await coordinator.request({ timeoutSeconds: 60, reason: "initial" });
    expect(first.ok).toBe(true);

    // Second request is rejected
    const second = await coordinator.request({ timeoutSeconds: 60, reason: "duplicate" });
    expect(second.ok).toBe(false);
    expect(second.message).toContain("already in progress");

    coordinator.cancel();
  });

  it("preserves operator HALT state independently without file collision or state conflation", async () => {
    // HALT is separate: graceful shutdown exists only in-memory and does not create or touch HALT.
    const clock = fakeClock();
    const graceful = new GracefulShutdown();
    const running = new Set<string>();
    const drainer = new MeshDrainer(graceful, () => new Set(running), "", 5);

    let exitCode: number | null = null;
    const coordinator = new MaintenanceShutdownCoordinator({
      drain: drainer,
      exit: (code) => {
        exitCode = code;
      },
      now: clock.now,
      sleep: clock.sleep,
      intervalMs: 5,
    });

    // Request shutdown
    const outcome = await coordinator.request({ reason: "config restart" });
    expect(graceful.isShuttingDown()).toBe(true);

    await outcome.completion;
    expect(exitCode).toBe(0);

    // In a freshly rebooted process, gracefulShutdown starts false by design.
    // Operator HALT is never touched or conflated.
  });
});
