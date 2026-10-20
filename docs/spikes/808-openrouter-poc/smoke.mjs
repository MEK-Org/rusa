// Opt-in paid smoke: a disposable Rusa instance, real Pi and OpenRouter,
// fake human chat and GitHub. Run from the repository root after building tsup.

import { spawn } from "node:child_process";
import { mkdir, mkdtemp, open, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { assertOwnedListeners } from "./ownership.mjs";

const require = createRequire(resolve("packages/rusa/package.json"));
const Database = require("better-sqlite3");
const [piCommand = "pi", model = "openai/gpt-4.1-mini"] = process.argv.slice(2);
for (const key of [
  "GIT_AUTHOR_NAME",
  "GIT_AUTHOR_EMAIL",
  "GIT_COMMITTER_NAME",
  "GIT_COMMITTER_EMAIL",
]) {
  if (!process.env[key])
    throw new Error(`Supply operator-approved ${key} for the disposable scratch commit`);
}
const parent = join(homedir(), ".rusa-e2e");
await mkdir(parent, { recursive: true });
const root = await mkdtemp(join(parent, "openrouter-poc-"));
const base = join(root, "base");
await mkdir(base);
await writeFile(
  join(base, "config.yaml"),
  JSON.stringify({
    github: { account: "rusa-e2e-bot" },
    providers: {
      claude: { cliCommand: "claude" },
      openrouter: {
        cliCommand: "openrouter",
        openrouterPoc: {
          piCommand,
          artifactDir: join(root, "artifacts"),
        },
      },
    },
    rootActor: { provider: "openrouter", model, context: { type: "portable", mode: "tail" } },
    sandbox: "container-boundary",
    geminiApiKey: "MISSING",
    webhook: { port: 0, secret: "" },
  }),
  { mode: 0o600 }
);
const log = await open(join(root, "instance.log"), "w", 0o600);
const child = spawn(
  process.execPath,
  [
    "packages/rusa/dist/commands/e2e.cli.js",
    "am-up",
    "--root",
    join(root, "instance"),
    "--base-config-home",
    base,
    "--port-offset",
    "240",
  ],
  {
    env: { ...process.env, RUSA_OPENROUTER_POC: "1" },
    stdio: ["ignore", log.fd, log.fd],
  }
);
const exited = new Promise((resolveExit) => child.once("exit", resolveExit));
let closed = false;
child.once("exit", () => {
  closed = true;
});
const dashboard = "http://127.0.0.1:8323";
const chat = "http://127.0.0.1:8325";
const post = async (url, data) => {
  if (closed) throw new Error("Instance exited before write");
  await assertOwnedListeners(child.pid, [8323, 8325]);
  const response = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(data),
  });
  const body = await response.json();
  if (!response.ok) throw new Error(`${url}: ${response.status} ${JSON.stringify(body)}`);
  return body;
};
try {
  let ready = false;
  for (let attempt = 0; attempt < 60; attempt++) {
    if (closed) throw new Error(`Instance exited. See ${root}/instance.log`);
    try {
      ready = (await fetch(`${chat}/chat/outbox`)).ok;
    } catch {
      /* starting */
    }
    if (ready) break;
    await delay(500);
  }
  if (!ready) throw new Error("Instance did not become ready");
  const actor = await post(`${dashboard}/api/mesh/actors`, {
    provider: "openrouter",
    model,
    contextMode: "tail",
    title: "OpenRouter ping proof",
    charter:
      "You are a local proof-of-concept root actor. On wake, list and select your inbox. Read human messages using their source tools. Reply in the same conversation using the messaging tools. For ping, reply pong with the exact nonce supplied. Mark selected inbox entries handled after replying. Keep work bounded to answering the message. Do not create obligations or spawn workers.",
  });
  const db = new Database(join(root, "instance/home/data/mesh.db"), { readonly: true });
  await post(`${chat}/chat/send`, {
    text: `Prepare this local proof of concept. Use mcp__mesh__grant_capability with actor_id "${actor.id}" and capability "chat-write:spaces/e2e-dm". You hold capability-admin. The endpoint will mount on your next run. End this turn after the grant; do not reply to this setup message.`,
    dm: true,
  });
  let granted = false;
  for (let attempt = 0; attempt < 180; attempt++) {
    const grant = db
      .prepare(
        "SELECT 1 FROM capability_grants WHERE actor_id = ? AND capability = 'chat-write:spaces/e2e-dm' AND revoked_at IS NULL"
      )
      .get(actor.id);
    const ended = db
      .prepare(
        "SELECT success FROM mesh_events WHERE actor_id = ? AND kind = 'run_end' ORDER BY rowid DESC LIMIT 1"
      )
      .get(actor.id);
    if (grant && ended?.success === 1) {
      granted = true;
      break;
    }
    await delay(500);
  }
  if (!granted) throw new Error(`Actor did not prepare its chat grant. See ${root}/instance.log`);
  const nonce = `openrouter-${Date.now()}`;
  const pingAt = new Date().toISOString();
  await post(`${chat}/chat/send`, {
    text: `ping nonce ${nonce}. Use mcp__chat_write__send_message with spaceName spaces/e2e-dm to reply pong with this exact nonce, then mark your selected inbox entries handled.`,
    dm: true,
  });
  try {
    for (let attempt = 0; attempt < 240; attempt++) {
      const outbox = await (await fetch(`${chat}/chat/outbox`)).json();
      const reply = outbox.sent.find(
        (message) =>
          message.spaceName === "spaces/e2e-dm" &&
          message.text.includes(nonce) &&
          /pong/i.test(message.text)
      );
      const settled = db
        .prepare(
          "SELECT success, payload FROM mesh_events WHERE actor_id = ? AND kind = 'run_end' AND ts >= ? ORDER BY rowid DESC LIMIT 1"
        )
        .get(actor.id, pingAt);
      if (reply && settled?.success === 1) {
        const receipt = {
          root,
          actorId: actor.id,
          requestedModel: model,
          modelProvenance: "Pi configuration echo only; upstream identity unverified",
          nonce,
          reply,
          settled,
        };
        await writeFile(join(root, "receipt.json"), JSON.stringify(receipt, null, 2), {
          mode: 0o600,
        });
        process.stdout.write(`${JSON.stringify(receipt, null, 2)}\n`);
        break;
      }
      if (attempt === 239 || closed) throw new Error(`No nonce reply. See ${root}/instance.log`);
      await delay(500);
    }
  } finally {
    db.close();
  }
} finally {
  child.kill("SIGTERM");
  const timer = setTimeout(() => child.kill("SIGKILL"), 5000);
  await exited;
  clearTimeout(timer);
  await log.close();
}
