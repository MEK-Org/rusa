import { mkdirSync, readFileSync } from "node:fs";
import { hostname } from "node:os";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { createLogger } from "../../observability/logger.js";
import type { FollowerCommand, FollowerEvent } from "./follower-hub.js";
import { FollowerInstance } from "./follower-instance.js";
import { INSTANCE_PROTOCOL_VERSION } from "./protocol.js";

const { values } = parseArgs({
  options: {
    leader: { type: "string" },
    id: { type: "string", default: hostname().replace(/[^a-zA-Z0-9_-]/g, "-") },
    home: { type: "string" },
    "token-file": { type: "string" },
    sandbox: { type: "string" },
  },
});
if (
  !values.leader ||
  !values.home ||
  !values["token-file"] ||
  !["bwrap", "none"].includes(values.sandbox ?? "")
) {
  throw new Error(
    "Required: --leader URL --id NAME --home PATH --token-file PATH --sandbox bwrap|none"
  );
}
const leader = new URL(values.leader);
if (leader.protocol !== "http:" && leader.protocol !== "https:")
  throw new Error("Invalid leader URL");
const token = readFileSync(values["token-file"], "utf8").trim();
// Everything this process has to say about itself is a diagnostic, so it goes
// to the application logger like the leader's. The enrollment secret is
// registered so it is scrubbed if it ever reaches an error message.
const log = createLogger({ secrets: [token], context: { component: "follower", id: values.id } });
const root = resolve(values.home);
mkdirSync(join(root, "workers"), { recursive: true });
// Instance-wide configuration is local; never mutate cwd/env for individual actors.
process.env.RUSA_HOME = root;
const instance = new FollowerInstance(root, values.sandbox === "bwrap", (event) =>
  emit(event.actorId, event.message)
);
let session = "";
let stopped = false;
const events: FollowerEvent[] = [];
let sending = false;
let sendTimer: ReturnType<typeof setTimeout> | undefined;

async function post<T>(path: string, body: object): Promise<T> {
  const response = await fetch(new URL(path, leader), {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify({ id: values.id, session, ...body }),
    signal: AbortSignal.timeout(25_000),
  });
  if (!response.ok) throw new Error(`Leader ${path}: HTTP ${response.status}`);
  return (await response.json()) as T;
}
function emit(actorId: string, message: FollowerEvent["message"]): void {
  if (stopped) return;
  events.push({ actorId, message });
  if (!sending && !sendTimer)
    sendTimer = setTimeout(() => {
      sendTimer = undefined;
      void flush();
    }, 5);
}
async function flush(): Promise<void> {
  if (sending || stopped) return;
  sending = true;
  try {
    while (events.length && !stopped) {
      await post("/events", { events: events.splice(0, 100) });
    }
  } catch (error) {
    log.error("follower_event_flush_failed", { err: error });
    await stop(1);
  } finally {
    sending = false;
  }
}
async function stop(code: number): Promise<void> {
  if (stopped) return;
  stopped = true;
  clearTimeout(sendTimer);
  instance.close();
  // A lost leader ends this follower generation. No commands are replayed automatically.
  const force = setTimeout(() => {
    process.exit(code);
  }, 1500);
  if (session) await post("/unregister", {}).catch(() => {});
  // Give interrupted provider invocations time to unwind, as part of instance shutdown.
  while (instance.actorIds.length) await new Promise((resolve) => setTimeout(resolve, 20));
  clearTimeout(force);
  process.exit(code);
}
process.on("SIGINT", () => {
  void stop(0);
});
process.on("SIGTERM", () => {
  void stop(0);
});
try {
  const registration = await post<{ session: string; protocolVersion: number }>("/register", {
    platform: process.platform,
    pid: process.pid,
    protocolVersion: INSTANCE_PROTOCOL_VERSION,
  });
  session = registration.session;
  if (registration.protocolVersion !== INSTANCE_PROTOCOL_VERSION)
    throw new Error("Incompatible instance protocol; rebuild leader and follower");
  log.info("follower_registered", {
    leader: leader.origin,
    pid: process.pid,
    sandbox: values.sandbox,
  });
  while (!stopped) {
    const commands = await post<FollowerCommand[]>("/poll", {});
    for (const command of commands) instance.dispatch(command);
  }
} catch (error) {
  log.error("follower_stopped", { err: error });
  await stop(1);
}
