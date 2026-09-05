import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createHarness, waitUntil } from "./harness.js";

const instances: ReturnType<typeof createHarness>[] = [];
const dirs: string[] = [];
function setup(options: { delayMs?: number; failInit?: boolean } = {}) {
  const cwd = mkdtempSync(join(tmpdir(), "rusa-follower-unit-"));
  dirs.push(cwd);
  const h = createHarness({
    cwd,
    delayMs: options.delayMs ?? 25,
    providerFactory: options.failInit
      ? () => {
          throw new Error("test provider initialization failed");
        }
      : undefined,
  });
  instances.push(h);
  return h;
}
afterEach(async () => {
  for (const h of instances.splice(0)) await h.close();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("monolithic follower instance", () => {
  it("hosts multiple Actors in one PID and retires one without stopping its sibling", async () => {
    const h = setup();
    const first = h.spawn("First charter");
    const second = h.spawn("Second charter");
    expect(await h.runtime(first).ready).toBe(process.pid);
    expect(await h.runtime(second).ready).toBe(process.pid);
    await waitUntil(
      () =>
        h.events.filter((e) => e.event.type === "result").length === 2 &&
        !h.mesh.runningThreadIds().size
    );
    h.mesh.retire(first, { force: true });
    await h.runtime(first).exited;
    expect(h.follower.actorIds).toEqual([second]);
    expect(h.remote.hosts.has(second)).toBe(true);
    h.mesh.sendMessage(second, "Still connected", "root");
    await waitUntil(() => h.events.filter((e) => e.event.type === "result").length === 3);
    expect(h.failures).toEqual([]);
  });

  it("preserves per-actor session and gets fresh prompt/messages after admission", async () => {
    const h = setup({ delayMs: 150 });
    const first = h.spawn("First");
    await waitUntil(() => h.runtime(first).isRunning);
    const second = h.spawn("Second");
    await waitUntil(() => h.runtime(second).isQueued);
    h.actors.patch(second, { charter: "Updated second" });
    h.mesh.sendMessage(second, "Fresh queued message", "root");
    await waitUntil(
      () =>
        h.events.filter((e) => e.event.type === "result").length === 2 &&
        !h.runtime(second).isRunning
    );
    const session = h.actors.get(second)?.sessionId;
    expect(session).toBeTruthy();
    expect(session).not.toBe(h.actors.get(first)?.sessionId);
    const report = JSON.parse(h.messages.filter((m) => m.fromId === second).at(-1)?.body ?? "{}");
    expect(report.charter).toBe("Updated second");
    expect(report.messages).toContain("Fresh queued message");
    h.mesh.sendMessage(second, "Resume", "root");
    await waitUntil(() => h.events.filter((e) => e.event.type === "result").length === 3);
    expect(h.actors.get(second)?.sessionId).toBe(session);
    expect(
      JSON.parse(h.messages.filter((m) => m.fromId === second).at(-1)?.body ?? "{}").resumed
    ).toBe(true);
  });

  it("contains initialization failure to the actor without closing the instance", async () => {
    const h = setup({ failInit: true });
    const id = h.spawn("Broken");
    await expect(h.runtime(id).ready).rejects.toThrow();
    await h.runtime(id).exited;
    expect(h.failures[0]?.message).toContain("test provider initialization failed");
    expect(h.follower.actorIds).toEqual([]);
    expect(h.remote.hosts.size).toBe(0);
  });

  it("closes all actor handles and releases admission on instance disconnect", async () => {
    const h = setup({ delayMs: 250 });
    const a = h.spawn("A");
    const b = h.spawn("B");
    await waitUntil(() => h.runtime(a).isRunning && h.runtime(b).isQueued);
    h.follower.close();
    h.remote.close();
    await Promise.all([h.runtime(a).exited, h.runtime(b).exited]);
    await waitUntil(() => h.follower.actorIds.length === 0);
    expect(h.follower.actorIds).toEqual([]);
    expect(h.runtime(a).isRunning).toBe(false);
    expect(h.runtime(b).isQueued).toBe(false);
  });

  it("interrupts a running actor without killing the instance or stranding its queued sibling", async () => {
    const h = setup({ delayMs: 250 });
    const a = h.spawn("Retire me");
    const b = h.spawn("Keep running");
    await waitUntil(() => h.runtime(a).isRunning && h.runtime(b).isQueued);
    h.mesh.retire(a, { force: true });
    await h.runtime(a).exited;
    await waitUntil(() => h.events.some((e) => e.actorId === b && e.event.type === "result"));
    expect(h.follower.actorIds).toEqual([b]);
    expect(h.failures).toEqual([]);
  });
});
