import { request } from "node:http";

export async function runE2EHydrate(opts: {
  scenario: string;
  rootControlPort?: number;
  chatControlPort?: number;
  trackerPort?: number;
}): Promise<void> {
  if (
    opts.scenario !== "dashboard-basic" &&
    opts.scenario !== "dashboard-empty" &&
    opts.scenario !== "dashboard-references"
  ) {
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
  // The disposable instance's fake provider requires an explicit model since
  // #169; its external root runs model "fake-model" (#456).
  const fakeModel = "fake-model";
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

  if (opts.scenario === "dashboard-references") {
    await hydrateReferences({
      post,
      get,
      rootPort,
      trackerPort,
      fakeModel,
      completedOutput,
      fakeProviderOutput,
      waitForIdle,
    });
    return;
  }

  // 1. A completed/idle thread
  const idleActor = (await post(rootPort, "/actors", {
    charter: `Be a helpful assistant.${completedOutput("Hello there!", "Initial task complete")}`,
    provider: "fake",
    model: fakeModel,
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
    model: fakeModel,
    title: "Blocked Task",
  })) as { id: string };
  console.log(`Spawned blocked actor: ${blockedActor.id}`);
  await waitForIdle(blockedActor.id);

  // 3. A retired thread
  const retiredActor = (await post(rootPort, "/actors", {
    charter: `Old task.${completedOutput("done", "Old task complete")}`,
    provider: "fake",
    model: fakeModel,
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
    model: fakeModel,
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
    model: fakeModel,
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
    model: fakeModel,
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

/**
 * `dashboard-references`: every kind of inbox focus the dashboard renders as a
 * reference card, on both idle and queued actors.
 *
 * One idle "historian" accumulates a whole PR's lifecycle plus a mesh message
 * and a ready obligation, so its Inbox tab shows each card. Four actors are
 * then held running (the fake provider's `delayMs`) to fill the mesh's default
 * concurrency cap of 4, after which each remaining actor receives one event and
 * queues with it as its inbox focus. The held runs last until the actor's
 * 60-minute run ceiling (the fake provider's heartbeat keeps the stall watchdog
 * off them), then the queue drains; interrupt one from the dashboard to drain
 * it sooner, or re-seed a fresh instance to see it again.
 */
async function hydrateReferences(h: {
  post: (port: number, path: string, body: unknown) => Promise<unknown>;
  get: (port: number, path: string) => Promise<unknown>;
  rootPort: number;
  trackerPort: number;
  fakeModel: string;
  completedOutput: (output: string, note: string) => string;
  fakeProviderOutput: (output: unknown) => string;
  waitForIdle: (actorId: string) => Promise<void>;
}): Promise<void> {
  const repo = "rusa-e2e/scratch";
  const tracker = (path: string, body: unknown = {}) =>
    h.post(h.trackerPort, `/repos/${repo}${path}`, body) as Promise<{ number: number }>;
  const spawn = async (title: string, charter: string) =>
    (await h.post(h.rootPort, "/actors", {
      charter,
      provider: "fake",
      model: h.fakeModel,
      title,
    })) as { id: string };
  const spawnIdle = async (title: string) => {
    const actor = await spawn(title, `${title}.${h.completedOutput("On it.", `${title} ready`)}`);
    await h.waitForIdle(actor.id);
    return actor;
  };
  const subscribe = (actorId: string, source: string) =>
    h.post(h.rootPort, `/actors/${actorId}/subscriptions`, { source });
  const waitUntil = async (actorId: string, state: "running" | "queued", timeoutMs = 15_000) => {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const actor = (await h.get(h.rootPort, `/actors/${actorId}`)) as Record<string, unknown>;
      if (actor[state]) return;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    throw new Error(`Timed out waiting for actor ${actorId} to be ${state}`);
  };
  const settle = async (actorId: string) => {
    // Each event wakes the actor; let the burst of instant runs drain.
    await new Promise((resolve) => setTimeout(resolve, 500));
    await h.waitForIdle(actorId);
  };

  // 1. The actors that will queue. A spawn starts no run, so they stay idle
  // until their event arrives.
  const historian = await spawnIdle("PR historian");
  const cases = {
    prComment: await spawnIdle("Answer PR discussion"),
    reviewComment: await spawnIdle("Fix review nit"),
    review: await spawnIdle("Address requested changes"),
    merged: await spawnIdle("Follow up merged PR"),
    push: await spawnIdle("Re-check after push"),
    issueComment: await spawnIdle("Triage bug report"),
    issueClosed: await spawnIdle("Confirm issue closure"),
    obligation: await spawnIdle("Pick up ready obligation"),
  };
  console.log(`Spawned historian ${historian.id} and ${Object.keys(cases).length} queue cases`);

  // 2. The historian's inbox: a whole PR lifecycle, a mesh message, an obligation.
  const tracked = await tracker("/pulls", {
    title: "Retry flaky auth token fetch",
    body: "Wraps the token fetch in a bounded retry with jitter.",
    author: "alice",
  });
  const trackedPath = `/pulls/${tracked.number}`;
  await subscribe(historian.id, `github:${repo}/pulls/${tracked.number}`);
  await tracker(`${trackedPath}/edit`, {
    body: "Wraps the token fetch in a bounded retry (3 attempts, jittered backoff).",
  });
  await tracker(`${trackedPath}/comments`, {
    body: "Should the retry budget be configurable, or is 3 fine for now?",
    author: "bob",
  });
  await tracker(`${trackedPath}/review-comments`, {
    body: "This sleeps on the event loop — use the scheduler's delay helper instead.",
    path: "src/auth/token.ts",
    line: 42,
    author: "dana",
  });
  await tracker(`${trackedPath}/reviews`, {
    state: "changes_requested",
    body: "Close — two small things inline before this can merge.",
    author: "dana",
  });
  await tracker(`${trackedPath}/push`);
  await tracker(`${trackedPath}/reviews`, { state: "approved", body: "", author: "dana" });
  await tracker(`${trackedPath}/close`, { merged: true });
  await h.post(h.rootPort, `/actors/${historian.id}/messages`, {
    body: `Once #${tracked.number} lands, can you post a short summary for the release notes?`,
  });
  await h.post(h.rootPort, "/obligations", {
    ownerId: historian.id,
    title: "Write the release note for the auth retry",
    intent:
      "Write the release note for the auth retry\nOne paragraph: what changed and why it matters.",
  });
  await settle(historian.id);
  console.log(`Historian's inbox seeded from PR #${tracked.number}`);

  // 3. The sources each queue case will hear from, subscribed while nothing is held.
  const pr = async (title: string, body: string) =>
    tracker("/pulls", { title, body, author: "alice" });
  const issue = async (title: string, body: string) =>
    tracker("/issues", { title, body, author: "carol", assign: false });
  const sources = {
    prComment: await pr("Cache resolved references per request", "Avoids refetching the same PR."),
    reviewComment: await pr("Tighten inbox payload validation", "Rejects unknown event shapes."),
    review: await pr("Split the dashboard store", "Moves run selections into their own stream."),
    merged: await pr("Bump the quota coordinator client", "Picks up the socket reconnect fix."),
    push: await pr("Queue card layout", "Puts the inbox item beside the actor."),
    issueComment: await issue("Dashboard shows a raw UUID", "Seen on an obligation citation."),
    issueClosed: await issue("Flaky e2e: tracker port race", "Two runs grabbed the same port."),
  };
  for (const key of Object.keys(sources) as Array<keyof typeof sources>) {
    const n = sources[key].number;
    const kind = key.startsWith("issue") ? "issues" : "pulls";
    await subscribe(cases[key].id, `github:${repo}/${kind}/${n}`);
  }

  // 4. Hold four runs open to fill the default concurrency cap of 4. A spawn
  // alone starts no run, and responsive work bypasses the cap, so each is
  // started by a ready obligation — ordinary work that takes a slot, and
  // becomes the running card's focus.
  const held = [];
  for (const title of ["Long build", "Nightly eval", "Dependency audit", "Doc sweep"]) {
    const actor = await spawn(
      title,
      `${title}.${h.fakeProviderOutput({ delayMs: 6 * 60 * 60 * 1000, output: "Still working." })}`
    );
    await h.post(h.rootPort, "/obligations", {
      ownerId: actor.id,
      title: `${title} for this week's release`,
      intent: `${title} for this week's release\nKeep going until it is green.`,
    });
    await waitUntil(actor.id, "running");
    held.push(actor);
  }
  console.log(`Holding ${held.length} runs open: ${held.map((a) => a.id).join(", ")}`);

  // 5. One event per queue case; each actor queues with it as its inbox focus.
  await tracker(`/pulls/${sources.prComment.number}/comments`, {
    body: "Would a per-request memo be enough here, or do we need the shared cache?",
    author: "bob",
  });
  await tracker(`/pulls/${sources.reviewComment.number}/review-comments`, {
    body: "Nit: this branch can never be reached after the early return above.",
    path: "src/dashboard/api.ts",
    line: 118,
    author: "dana",
  });
  await tracker(`/pulls/${sources.review.number}/reviews`, {
    state: "changes_requested",
    body: "The stream split looks right, but the dispose order now leaks a subscription.",
    author: "dana",
  });
  await tracker(`/pulls/${sources.merged.number}/close`, { merged: true });
  await tracker(`/pulls/${sources.push.number}/push`);
  await tracker(`/issues/${sources.issueComment.number}/comments`, {
    body: "Repro: open the Work tab on any obligation citing a retired actor.",
    author: "erin",
  });
  await tracker(`/issues/${sources.issueClosed.number}/close`);
  await h.post(h.rootPort, "/obligations", {
    ownerId: cases.obligation.id,
    title: "Draft the Q4 dashboard polish plan",
    intent: "Draft the Q4 dashboard polish plan\nList the rough edges from this week's review.",
  });
  for (const actor of Object.values(cases)) {
    await waitUntil(actor.id, "queued");
  }
  console.log(`Queued ${Object.keys(cases).length} actors, one per inbox focus kind.`);
  console.log("Hydration complete: dashboard-references.");
}
