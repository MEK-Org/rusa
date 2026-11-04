import { describe, expect, it } from "vitest";
import { GracefulShutdown } from "../actor/graceful-shutdown.js";
import { MeshDrainer } from "./drain.js";
import { MaintenanceShutdownCoordinator } from "./maintenance-shutdown.js";
import type { DrainSeam } from "./orchestrator.js";

function setupCoordinator(opts?: {
  isBusy?: () => boolean;
  onExit?: (code: number) => void;
  notifyFails?: boolean;
}) {
  const graceful = new GracefulShutdown();
  const running = new Set<string>();
  const drainer = new MeshDrainer(graceful, () => new Set(running), "", 10);
  const notifications: string[] = [];
  const actions: string[] = [];
  let exitCode: number | null = null;
  let workResumedCount = 0;

  const coordinator = new MaintenanceShutdownCoordinator({
    drain: drainer,
    notify: {
      notify: async (text) => {
        if (opts?.notifyFails) {
          throw new Error("Chat network unavailable");
        }
        notifications.push(text);
      },
    },
    recordAction: (text) => {
      actions.push(text);
    },
    exit: (code) => {
      exitCode = code;
      opts?.onExit?.(code);
    },
    isBusy: opts?.isBusy,
    onResumeWork: () => {
      workResumedCount++;
    },
  });

  return {
    graceful,
    running,
    drainer,
    notifications,
    actions,
    getExitCode: () => exitCode,
    getWorkResumedCount: () => workResumedCount,
    coordinator,
  };
}

describe("MaintenanceShutdownCoordinator (#1225)", () => {
  it("engages admission brake synchronously and emits notification at request time", async () => {
    const { graceful, notifications, actions, coordinator, getExitCode } = setupCoordinator();

    const outcome = await coordinator.request({
      reason: "custom MCP registration config update",
      timeoutSeconds: 30,
    });

    expect(outcome.ok).toBe(true);
    expect(outcome.message).toContain("Graceful shutdown initiated");
    expect(outcome.message).toContain("custom MCP registration config update");

    // Admission brake engaged immediately (synchronously)
    expect(graceful.isShuttingDown()).toBe(true);
    expect(actions[0]).toContain("shutdown requested: custom MCP registration config update");

    // Notification posted to error chat at request time
    expect(notifications).toHaveLength(1);
    expect(notifications[0]).toContain(
      "🛑 Graceful shutdown requested: custom MCP registration config update"
    );
    expect(notifications[0]).toContain("timeout: 30s");

    // Quiesced immediately (running is empty) -> clean exit(0)
    const result = await outcome.completion;
    expect(result?.status).toBe("quiesced");
    expect(getExitCode()).toBe(0);
    expect(actions[1]).toContain("shutdown committed: drained in");
  });

  it("self-request return: requesting actor returns immediately without deadlock while active run finishes before clean exit", async () => {
    const { running, coordinator, getExitCode } = setupCoordinator();

    // Calling actor (root) and worker-1 are actively running
    running.add("root");
    running.add("worker-1");

    // Root calls request (simulating MCP tool invocation)
    const outcome = await coordinator.request({
      reason: "maintenance bounce",
      timeoutSeconds: 5,
    });

    // Request returns immediately to root so its turn finishes cleanly
    expect(outcome.ok).toBe(true);
    expect(outcome.message).toContain("Active runs will finish before shutdown");
    expect(getExitCode()).toBeNull();

    // Root finishes its turn and returns cleanly
    running.delete("root");
    expect(getExitCode()).toBeNull(); // worker-1 still running

    // Worker-1 finishes its run
    running.delete("worker-1");

    const result = await outcome.completion;
    expect(result?.status).toBe("quiesced");
    expect(getExitCode()).toBe(0);
  });

  it("timeout behavior: aborts shutdown, lifts brake, notifies chat, invokes onResumeWork, does NOT exit", async () => {
    const { graceful, running, notifications, coordinator, getExitCode, getWorkResumedCount } =
      setupCoordinator();

    // Worker remains running past timeout
    running.add("worker-long");

    const outcome = await coordinator.request({
      timeoutSeconds: 1,
      reason: "timeout test",
    });
    expect(outcome.ok).toBe(true);
    expect(graceful.isShuttingDown()).toBe(true);

    const result = await outcome.completion;
    expect(result?.status).toBe("cancelled");
    expect(result?.reason).toBe("timeout");

    // Exit must NOT have been called (never silently terminates)
    expect(getExitCode()).toBeNull();

    // Admission brake lifted and queued work resumed
    expect(graceful.isShuttingDown()).toBe(false);
    expect(getWorkResumedCount()).toBe(1);

    // Error chat notified
    expect(notifications).toHaveLength(2);
    expect(notifications[1]).toContain("⚠️ Graceful shutdown cancelled: drain timed out after 1s");
    expect(notifications[1]).toContain("Admission resumed");

    // Coordinator is ready for future requests
    expect(coordinator.isPending()).toBe(false);
  });

  it("explicit cancellation: cancels pending shutdown, lifts brake, notifies chat, invokes onResumeWork", async () => {
    const { graceful, running, notifications, coordinator, getExitCode, getWorkResumedCount } =
      setupCoordinator();

    running.add("worker-long");

    const outcome = await coordinator.request({
      timeoutSeconds: 60,
      reason: "operator cancel test",
    });
    expect(coordinator.isPending()).toBe(true);
    expect(graceful.isShuttingDown()).toBe(true);

    const cancelResult = coordinator.cancel("operator changed mind");
    expect(cancelResult.ok).toBe(true);
    expect(cancelResult.message).toContain("Graceful shutdown cancelled by operator");
    expect(coordinator.isPending()).toBe(false);

    // Brake lifted, work resumed, no exit
    expect(graceful.isShuttingDown()).toBe(false);
    expect(getExitCode()).toBeNull();
    expect(getWorkResumedCount()).toBe(1);

    const completion = await outcome.completion;
    expect(completion?.status).toBe("cancelled");
    expect(completion?.reason).toBe("explicit");

    expect(notifications).toHaveLength(2);
    expect(notifications[1]).toContain(
      "⚠️ Graceful shutdown cancelled by operator: operator changed mind. Admission resumed."
    );
  });

  it("stale background watcher does not clobber a subsequent request after cancel", async () => {
    const { running, coordinator } = setupCoordinator();

    running.add("worker-stuck");

    // 1. First request
    const _firstOutcome = await coordinator.request({ timeoutSeconds: 1, reason: "first" });
    expect(coordinator.isPending()).toBe(true);

    // 2. Cancel immediately
    const cancelRes = coordinator.cancel("abort first");
    expect(cancelRes.ok).toBe(true);
    expect(coordinator.isPending()).toBe(false);

    // 3. Second request starts right away
    const secondOutcome = await coordinator.request({ timeoutSeconds: 60, reason: "second" });
    expect(coordinator.isPending()).toBe(true);

    // 4. Wait for first watcher's timeout to pass
    await new Promise((r) => setTimeout(r, 1100));

    // Second request must STILL be active and not clobbered by the first watcher
    expect(coordinator.isPending()).toBe(true);

    // Now let worker finish so second request can quiesce
    running.delete("worker-stuck");
    const secondResult = await secondOutcome.completion;
    expect(secondResult?.status).toBe("quiesced");
    expect(coordinator.isPending()).toBe(false);
  });

  it("drain error aborts shutdown, lifts brake, notifies chat, records audit, and resumes work", async () => {
    let cancelled = false;
    const drain: DrainSeam = {
      engage() {},
      cancel() {
        cancelled = true;
      },
      async waitForQuiescence() {
        throw new Error("unexpected drain explosion");
      },
    };
    const notifications: string[] = [];
    const actions: string[] = [];
    let workResumed = false;

    const coordinator = new MaintenanceShutdownCoordinator({
      drain,
      notify: {
        notify: async (msg) => {
          notifications.push(msg);
        },
      },
      recordAction: (act) => {
        actions.push(act);
      },
      exit: () => {},
      onResumeWork: () => {
        workResumed = true;
      },
    });

    const outcome = await coordinator.request({ reason: "error test" });
    const completion = await outcome.completion;

    expect(completion?.status).toBe("cancelled");
    expect(completion?.reason).toBe("error");
    expect(cancelled).toBe(true);
    expect(workResumed).toBe(true);
    expect(notifications).toHaveLength(2);
    expect(notifications[1]).toContain(
      "⚠️ Graceful shutdown aborted: drain error (unexpected drain explosion). Admission resumed."
    );
    expect(actions[1]).toContain("shutdown aborted: drain error (unexpected drain explosion)");
  });

  it("chat notification failure does not crash the coordinator or strand the brake", async () => {
    const { graceful, coordinator, getExitCode } = setupCoordinator({ notifyFails: true });

    // Request succeeds even if error-chat send rejects
    const outcome = await coordinator.request({ reason: "chat-broken test" });
    expect(outcome.ok).toBe(true);
    expect(graceful.isShuttingDown()).toBe(true);

    const result = await outcome.completion;
    expect(result?.status).toBe("quiesced");
    expect(getExitCode()).toBe(0);
  });

  it("rejects duplicate requests and prevents collision when update is in progress", async () => {
    let updating = false;
    const { coordinator } = setupCoordinator({ isBusy: () => updating });

    // Refused when update is running
    updating = true;
    const refused = await coordinator.request({ reason: "while update running" });
    expect(refused.ok).toBe(false);
    expect(refused.message).toContain("An update is currently in progress");

    updating = false;
    const first = await coordinator.request({ reason: "first" });
    expect(first.ok).toBe(true);

    // Duplicate rejected
    const second = await coordinator.request({ reason: "duplicate" });
    expect(second.ok).toBe(false);
    expect(second.message).toContain("already in progress");

    coordinator.cancel();
  });

  it("failed shutdown commit does not strand the brake", async () => {
    const { graceful, notifications, coordinator, getWorkResumedCount } = setupCoordinator({
      onExit: () => {
        throw new Error("simulated e2e stop error");
      },
    });

    const outcome = await coordinator.request({ reason: "failing commit test" });
    expect(outcome.ok).toBe(true);

    const result = await outcome.completion;
    expect(result?.status).toBe("cancelled");
    expect(result?.reason).toBe("error");

    // Brake must be lifted, work resumed, coordinator freed
    expect(graceful.isShuttingDown()).toBe(false);
    expect(getWorkResumedCount()).toBe(1);
    expect(coordinator.isPending()).toBe(false);

    // Error chat notified that commit aborted and admission resumed
    expect(notifications).toHaveLength(2);
    expect(notifications[1]).toContain(
      "⚠️ Graceful shutdown aborted before commit: exit failed (simulated e2e stop error). Admission resumed."
    );
  });

  it("defaults to 300s timeout when unspecified", async () => {
    const graceful = new GracefulShutdown();
    const drainer = new MeshDrainer(graceful, () => new Set(), "");
    const notifications: string[] = [];
    const coordinator = new MaintenanceShutdownCoordinator({
      drain: drainer,
      notify: {
        notify: async (text) => {
          notifications.push(text);
        },
      },
      exit: () => {},
    });

    const outcome = await coordinator.request();
    expect(outcome.ok).toBe(true);
    expect(outcome.message).toContain("draining active runs with 300s timeout");
    expect(notifications[0]).toContain("timeout: 300s");
  });

  it("onResumeWork failure logs warning and does not crash abandon", async () => {
    const logs: string[] = [];
    const graceful = new GracefulShutdown();
    const drainer = new MeshDrainer(graceful, () => new Set(), "");
    const coordinator = new MaintenanceShutdownCoordinator({
      drain: drainer,
      exit: () => {},
      onResumeWork: () => {
        throw new Error("simulated resume failure");
      },
      log: (msg) => logs.push(msg),
    });

    await coordinator.request();
    coordinator.cancel();

    expect(logs.some((l) => l.includes("onResumeWork failed: simulated resume failure"))).toBe(
      true
    );
  });
});
