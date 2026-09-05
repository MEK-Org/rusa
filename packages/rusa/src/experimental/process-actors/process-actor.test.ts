import { execFileSync } from "node:child_process";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { createHarness, waitUntil } from "./harness.js";

const instances: ReturnType<typeof createHarness>[] = [];
beforeAll(() => {
  execFileSync("pnpm", ["exec", "tsup", "--config", "tsup.process-prototype.config.ts"], {
    cwd: process.cwd(),
    stdio: "pipe",
    timeout: 30_000,
  });
}, 35_000);
afterEach(async () => {
  await Promise.all(instances.splice(0).map((instance) => instance.close()));
});

function setup(delayMs = 25, providerModule?: string) {
  const harness = createHarness({
    childEntry: resolve("build/process-actors/child.js"),
    providerModule:
      providerModule ?? pathToFileURL(resolve("build/process-actors/fixture-provider.js")).href,
    cwd: process.cwd(),
    delayMs,
  });
  instances.push(harness);
  return harness;
}

describe("actor process boundary", () => {
  it("runs in another PID, exchanges mesh messages, resumes its session, and retires", async () => {
    const h = setup();
    const id = h.spawn("First charter");
    const runtime = h.runtime(id);
    expect(await runtime.ready).not.toBe(process.pid);
    const results = () => h.events.filter((entry) => entry.event.type === "result");
    await waitUntil(() => results().length === 1 && !runtime.isRunning && !runtime.isQueued);
    const sessionId = h.actors.get(id)?.sessionId;
    h.actors.patch(id, { charter: "Updated charter" });
    expect(h.mesh.sendMessage(id, "Make the next edit", "root").delivered).toBe(true);
    await waitUntil(() => results().length === 2 && !runtime.isRunning && !runtime.isQueued);
    const reports = h.messages
      .filter((message) => message.toId === "root")
      .map((message) => JSON.parse(message.body));
    expect(reports[1]).toMatchObject({
      pid: runtime.process.pid,
      resumed: true,
      sessionId,
      charter: "Updated charter",
      messages: ["Make the next edit"],
    });
    h.mesh.retire(id, { force: true });
    await runtime.exited;
    expect(h.actors.get(id)?.status).toBe("retired");
    expect(h.failures).toEqual([]);
  });

  it("shares the coordinator's gate and reads fresh work after waiting for admission", async () => {
    const h = setup(1500);
    const first = h.spawn("First");
    await waitUntil(() => h.runtime(first).isRunning);
    const second = h.spawn("Second");
    await waitUntil(() => h.runtime(second).isQueued);
    expect(h.runtime(second).isRunning).toBe(false);
    h.mesh.sendMessage(second, "Arrived while queued", "root");
    await waitUntil(() => h.messages.some((message) => message.fromId === second));
    const message = h.messages.find((message) => message.fromId === second);
    if (!message) throw new Error("Second actor did not report");
    const report = JSON.parse(message.body);
    expect(report.messages).toContain("Arrived while queued");
    const firstRelease = h.events.findIndex(
      (entry) => entry.actorId === first && entry.event.type === "release"
    );
    const secondStart = h.events.findIndex(
      (entry) => entry.actorId === second && entry.event.type === "runStart"
    );
    expect(firstRelease).toBeGreaterThan(-1);
    expect(secondStart).toBeGreaterThan(firstRelease);
  }, 15_000);

  it("releases central capacity after a child crashes so another actor can run", async () => {
    const h = setup(1500);
    const first = h.spawn("Will crash");
    await waitUntil(() => h.runtime(first).isRunning);
    const second = h.spawn("Must still run");
    await waitUntil(() => h.runtime(second).isQueued);
    h.runtime(first).process.kill("SIGKILL");
    await h.runtime(first).exited;
    await waitUntil(() => h.messages.some((message) => message.fromId === second));
    expect(h.failures).toHaveLength(1);
    expect(h.failures[0].message).toContain("SIGKILL");
  }, 15_000);

  it("reports startup failure and terminates the child", async () => {
    const h = setup(25, "file:///nonexistent/rusa-prototype-provider.js");
    const id = h.spawn("Cannot start");
    const runtime = h.runtime(id);
    await expect(runtime.ready).rejects.toThrow("exited");
    await runtime.exited;
    expect(h.failures).toHaveLength(1);
    expect(h.failures[0].message).toContain("Cannot find module");
  });
});
