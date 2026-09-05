import assert from "node:assert/strict";
import { setTimeout as delay } from "node:timers/promises";
import { parseArgs } from "node:util";

const { values } = parseArgs({
  options: {
    target: { type: "string" },
    port: { type: "string", default: "8286" },
  },
});
if (!values.target)
  throw new Error("Usage: node scripts/follower-smoke.mjs --target NAME [--port PORT]");
const api = async (path, body) => {
  const response = await fetch(`http://127.0.0.1:${Number(values.port)}${path}`, {
    method: body === undefined ? "GET" : "POST",
    headers: { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(10000),
  });
  if (!response.ok) throw new Error(`${path}: ${response.status} ${await response.text()}`);
  return response.json();
};
const { followers } = await api("/followers");
assert(
  followers.some((f) => f.id === values.target),
  "Follower must register before spawning"
);
const { actors } = await api("/actors");
const root = actors.find((actor) => actor.parentId === null);
assert(root, "Root actor required");
const spawn = () =>
  api("/actors", {
    target: values.target,
    provider: "fake",
    model: "scripted",
    charter:
      "Exercise remote MCP tool calls.\nFAKE_PROVIDER_OUTPUT: " +
      JSON.stringify({
        output: "Follower transport smoke passed",
        toolCalls: [
          {
            id: "report",
            name: "mcp_mesh_send_message",
            arguments: { thread_id: root.id, body: "Follower MCP reply" },
          },
          {
            id: "yield",
            name: "mcp_mesh_yield_run",
            arguments: { status: "complete", note: "Follower MCP round trip complete" },
          },
        ],
      }),
  });
const { id } = await spawn();
let sibling;
async function waitForRun(count) {
  const end = Date.now() + 30_000;
  while (Date.now() < end) {
    const [record, context] = await Promise.all([
      api(`/actors/${id}`),
      api(`/actors/${id}/context`),
    ]);
    const runs = context.events.filter((event) => event.kind === "run_end");
    if (runs.some((event) => !event.success))
      throw new Error(`Actor failed: ${JSON.stringify(runs)}`);
    if (runs.length >= count && !record.running && !record.queued) return record;
    await delay(100);
  }
  throw new Error("Follower smoke timed out");
}
try {
  ({ id: sibling } = await spawn());
  await api(`/actors/${id}/messages`, { body: "First round trip" });
  const first = await waitForRun(1);
  assert.equal(first.execution.followerId, values.target);
  assert(first.execution.actorPid);
  await api(`/actors/${id}/messages`, { body: "Second round trip" });
  const second = await waitForRun(2);
  assert.equal(second.sessionId, first.sessionId);
  assert.equal(second.execution.actorPid, first.execution.actorPid);
  const inbox = await api("/root/inbox");
  assert(inbox.entries.filter((entry) => entry.payload.fromId === id).length >= 2);
  await api(`/actors/${id}/retire`, {});
  const remaining = (await api("/followers")).followers.find((f) => f.id === values.target);
  assert(
    remaining?.actors.includes(sibling),
    "Retiring one actor must leave its sibling and follower connected"
  );
  console.log(
    JSON.stringify(
      {
        passed: true,
        scriptedProvider: true,
        follower: values.target,
        actorId: id,
        ...second.execution,
        sessionId: second.sessionId,
        runs: 2,
        parentReplies: 2,
        followerSurvivesRetirement: true,
      },
      null,
      2
    )
  );
} finally {
  for (const actorId of [id, sibling].filter(Boolean)) {
    const record = await api(`/actors/${actorId}`);
    if (record.status !== "retired" && !record.running && !record.queued)
      await api(`/actors/${actorId}/retire`, {});
  }
}
