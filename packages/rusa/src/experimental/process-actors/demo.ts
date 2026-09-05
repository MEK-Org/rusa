import { createHarness, waitUntil } from "./harness.js";

const harness = createHarness({
  childEntry: new URL("./child.js", import.meta.url),
  providerModule: new URL("./fixture-provider.js", import.meta.url).href,
  cwd: process.cwd(),
});
try {
  console.log(`Coordinator PID: ${process.pid}`);
  const id = harness.spawn("Own the editing session (scripted stand-in)");
  const runtime = harness.runtime(id);
  console.log(`Actor ${id} PID: ${await runtime.ready}`);
  const resultCount = () => harness.events.filter(({ event }) => event.type === "result").length;
  await waitUntil(() => resultCount() === 1 && !runtime.isRunning && !runtime.isQueued);
  harness.mesh.sendMessage(id, "Export a preview of the current edit", "root");
  await waitUntil(() => resultCount() === 2 && !runtime.isRunning && !runtime.isQueued);
  for (const message of harness.messages.filter((message) => message.toId === "root")) {
    console.log(`Reply through mesh: ${message.body}`);
  }
  if (harness.failures.length) throw harness.failures[0];
  console.log(`Coordinator's saved session: ${harness.actors.get(id)?.sessionId}`);
  harness.mesh.retire(id, { force: true });
  await runtime.exited;
  console.log(`Retired actor: ${harness.actors.get(id)?.status}; child exited.`);
} finally {
  await harness.close();
}
