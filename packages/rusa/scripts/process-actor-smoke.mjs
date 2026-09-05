import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { parseArgs } from "node:util";

// Drives the existing disposable E2E control API; invokes the selected real provider.
const { values } = parseArgs({
  options: {
    root: { type: "string" },
    provider: { type: "string" },
    model: { type: "string" },
    effort: { type: "string" },
    port: { type: "string", default: "8086" },
    "timeout-ms": { type: "string", default: "240000" },
  },
});
for (const key of ["root", "provider", "model"]) {
  if (!values[key]) throw new Error(`--${key} is required`);
}
const port = Number(values.port);
const timeoutMs = Number(values["timeout-ms"]);
assert(Number.isInteger(port) && port > 0 && port <= 65535, "invalid port");
assert(Number.isFinite(timeoutMs) && timeoutMs > 0, "invalid timeout");
const api = async (path, body) => {
  const response = await fetch(`http://127.0.0.1:${port}${path}`, {
    method: body === undefined ? "GET" : "POST",
    headers: { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(10000),
  });
  if (!response.ok) throw new Error(`${path}: ${response.status} ${await response.text()}`);
  return response.json();
};
const nonce = randomUUID();
const first = `first-${nonce}`;
const second = `second-${nonce}`;
const file = "process-actor-smoke.txt";
const { id } = await api("/actors", {
  provider: values.provider,
  model: values.model,
  effort: values.effort,
  title: "Process actor smoke test",
  charter:
    "Perform only the bounded local smoke-test work in the latest inbox message. " +
    "Work in your own current directory. Do not spawn children, access external repositories, " +
    "or create obligations. Use the real inbox tools to read/select work and mark it handled. " +
    "After verifying the requested file, send a concise result to your parent through mesh " +
    "send_message and call yield_run with status complete.",
});
console.log(`Smoke actor: ${id}`);
const artifact = join(resolve(values.root), "home", "workers", id, file);
const record = () => api(`/actors/${id}`);
const deadline = Date.now() + timeoutMs;
async function waitForFile(expected, previousSession) {
  while (Date.now() < deadline) {
    const current = await record();
    let contents;
    try {
      contents = await readFile(artifact, "utf8");
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
    if (contents === expected && current.sessionId && !current.running && !current.queued) {
      const { events } = await api(`/actors/${id}/context`);
      const completed = events.filter((event) => event.kind === "run_end").at(-1);
      assert(
        completed && (completed.success === true || completed.success === 1),
        "Latest run did not succeed"
      );
      assert.equal(JSON.parse(completed.payload ?? "{}").yieldStatus, "complete");
      assert.equal(current.execution?.runtime, "process");
      assert.notEqual(current.execution.actorPid, current.execution.coordinatorPid);
      if (previousSession) assert.equal(current.sessionId, previousSession);
      return current;
    }
    await delay(1000);
  }
  throw new Error(`Timed out waiting for verified idle actor and artifact ${artifact}`);
}
try {
  await api(`/actors/${id}/messages`, {
    body:
      `Create ${file} in your current directory with exactly one line: ${first}\n` +
      "Verify it by reading it back, report to your parent, mark the inbox work handled, and yield complete.",
  });
  const initial = await waitForFile(`${first}\n`);
  console.log(
    `First run passed: coordinator=${initial.execution.coordinatorPid}, actor=${initial.execution.actorPid}`
  );
  await api(`/actors/${id}/messages`, {
    body:
      `Read existing ${file}. It must contain ${first}. Append exactly one new line: ${second}\n` +
      "Preserve the first line. Read back and verify both lines, report to your parent, mark the work handled, and yield complete.",
  });
  const resumed = await waitForFile(`${first}\n${second}\n`, initial.sessionId);
  assert.equal(resumed.execution.actorPid, initial.execution.actorPid);
  const inbox = await api("/root/inbox");
  assert(
    inbox.entries.some((entry) => entry.payload.fromId === id),
    "Expected a reply in the parent's real inbox"
  );
  const evidenceDir = join(resolve(values.root), "process-actor-smoke", id);
  await mkdir(evidenceDir, { recursive: true });
  const savedArtifact = join(evidenceDir, file);
  await writeFile(savedArtifact, await readFile(artifact));
  const report = {
    passed: true,
    actorId: id,
    ...resumed.execution,
    sessionId: resumed.sessionId,
    artifact: savedArtifact,
    verifiedRuns: 2,
    parentReply: true,
  };
  await writeFile(join(evidenceDir, "report.json"), `${JSON.stringify(report, null, 2)}\n`);
  console.log(JSON.stringify(report, null, 2));
} finally {
  // Only retire this test's worker; retain the instance and its artifacts for inspection.
  const current = await record();
  if (!current.running && !current.queued) await api(`/actors/${id}/retire`, {});
  else console.error(`Actor ${id} is still active; inspect or stop this disposable instance.`);
}
