import { request } from "node:http";

export async function runE2EHydrate(opts: {
  scenario: string;
  rootControlPort?: number;
  chatControlPort?: number;
  trackerPort?: number;
}): Promise<void> {
  if (opts.scenario !== "dashboard-basic" && opts.scenario !== "dashboard-empty") {
    throw new Error(`Unknown scenario: ${opts.scenario}`);
  }

  const rootPort = opts.rootControlPort ?? 8086;
  const chatPort = opts.chatControlPort ?? 8085;
  const trackerPort = opts.trackerPort ?? 8084;

  console.log(`Hydrating scenario '${opts.scenario}'...`);

  const requestJson = async (
    method: "GET" | "POST",
    port: number,
    path: string,
    body?: unknown
  ) => {
    return new Promise<unknown>((resolve, reject) => {
      const req = request(
        {
          hostname: "127.0.0.1",
          port,
          path,
          method,
          headers: { "content-type": "application/json" },
        },
        (res) => {
          let raw = "";
          res.on("data", (c) => (raw += c));
          res.on("end", () => {
            if (res.statusCode && res.statusCode >= 400) {
              reject(new Error(`HTTP ${res.statusCode} from ${path}: ${raw}`));
              return;
            }
            try {
              resolve(JSON.parse(raw));
            } catch {
              resolve(raw);
            }
          });
        }
      );
      req.on("error", reject);
      if (body !== undefined) req.write(JSON.stringify(body));
      req.end();
    });
  };
  const post = (port: number, path: string, body: unknown) => requestJson("POST", port, path, body);
  const get = (port: number, path: string) => requestJson("GET", port, path);

  try {
    await get(rootPort, "/options");
  } catch (err) {
    throw new Error(
      "Dashboard hydration requires a ready `e2e am-up --root-driver external` instance",
      { cause: err }
    );
  }

  if (opts.scenario === "dashboard-empty") {
    console.log("Hydration complete: dashboard-empty leaves the mesh in its cold-start state.");
    return;
  }

  // Helper to encode FAKE_PROVIDER_OUTPUT inside the charter
  const fakeProviderOutput = (output: unknown) =>
    `\nFAKE_PROVIDER_OUTPUT: ${JSON.stringify(output)}`;
  const yieldCall = (status: "complete" | "blocked", note: string) => ({
    id: `yield-${status}-${note}`,
    name: "mcp_mesh_yield_run",
    arguments: { status, note },
  });
  const completedOutput = (output: string, note: string) =>
    fakeProviderOutput({ output, toolCalls: [yieldCall("complete", note)] });
  const waitForIdle = async (actorId: string) => {
    const deadline = Date.now() + 10_000;
    while (Date.now() < deadline) {
      const actor = (await get(rootPort, `/actors/${actorId}`)) as {
        running?: boolean;
        queued?: boolean;
      };
      if (!actor.running && !actor.queued) return;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    throw new Error(`Timed out waiting for actor ${actorId} to become idle`);
  };

  // 1. A completed/idle thread
  const idleActor = (await post(rootPort, "/actors", {
    charter: `Be a helpful assistant.${completedOutput("Hello there!", "Initial task complete")}`,
    provider: "fake",
    title: "Completed Task",
  })) as { id: string };
  console.log(`Spawned idle actor: ${idleActor.id}`);
  await waitForIdle(idleActor.id);
  await post(rootPort, `/actors/${idleActor.id}/messages`, {
    body: "A follow-up message with emoji: 👋",
  });
  await waitForIdle(idleActor.id);

  // 2. A blocked thread
  const blockedActor = (await post(rootPort, "/actors", {
    charter: `Waiting for PR review.${fakeProviderOutput({
      toolCalls: [
        {
          id: "call-123",
          name: "mcp_mesh_yield_run",
          arguments: { status: "blocked", note: "Waiting for reviewer" },
        },
      ],
    })}`,
    provider: "fake",
    title: "Blocked Task",
  })) as { id: string };
  console.log(`Spawned blocked actor: ${blockedActor.id}`);
  await waitForIdle(blockedActor.id);

  // 3. A retired thread
  const retiredActor = (await post(rootPort, "/actors", {
    charter: `Old task.${completedOutput("done", "Old task complete")}`,
    provider: "fake",
    title: "Retired Task",
  })) as { id: string };
  console.log(`Spawned actor to retire: ${retiredActor.id}`);
  await waitForIdle(retiredActor.id);
  await post(rootPort, `/actors/${retiredActor.id}/retire`, {});
  console.log(`Retired actor: ${retiredActor.id}`);

  // 4. An errored thread
  const erroredActor = (await post(rootPort, "/actors", {
    charter: `Will fail.${fakeProviderOutput({
      success: false,
      exitCode: 1,
      output: "Something went wrong",
    })}`,
    provider: "fake",
    title: "Failing Task",
  })) as { id: string };
  console.log(`Spawned errored actor: ${erroredActor.id}`);
  await waitForIdle(erroredActor.id);

  // 5. Huge message bodies + emojis
  const emojiActor = (await post(rootPort, "/actors", {
    charter: `Emoji task 🚀✨${completedOutput(
      `Finished! 🎉\n${"A".repeat(5000)}`,
      "Large emoji response complete"
    )}`,
    provider: "fake",
    title: "Emoji & Huge Message",
  })) as { id: string };
  console.log(`Spawned huge message actor: ${emojiActor.id}`);
  await waitForIdle(emojiActor.id);

  // 7. A long charter
  const longActor = (await post(rootPort, "/actors", {
    charter: `Very long charter:\n${"B".repeat(10000)}${completedOutput(
      "done",
      "Long charter complete"
    )}`,
    provider: "fake",
    title: "Long Charter",
  })) as { id: string };
  console.log(`Spawned long charter actor: ${longActor.id}`);
  await waitForIdle(longActor.id);

  // 9. Chat interaction via chat edge
  await post(chatPort, "/chat/send", {
    text: "Can you help me with the dashboard?",
    dm: true,
  });
  console.log("Sent DM via chat edge");

  // 10. Tracker event (to use trackerPort)
  await post(trackerPort, "/repos/rusa-e2e/scratch/issues", {
    title: "Hydration Issue",
    body: "This is a synthetic issue created during hydration.",
  });

  console.log("Hydration complete!");
}
