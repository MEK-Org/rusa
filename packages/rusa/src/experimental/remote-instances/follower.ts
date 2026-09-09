import { randomUUID } from "node:crypto";
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
  emit(event.actorId, event.message, event.eventId)
);
let session = "";
let leaderToken: string | undefined;
let stopped = false;
const events: FollowerEvent[] = [];
let pendingBatch: { batchId: string; events: FollowerEvent[] } | undefined;
let sending = false;
let sendTimer: ReturnType<typeof setTimeout> | undefined;

class FollowerHttpError extends Error {
  constructor(
    message: string,
    readonly status: number
  ) {
    super(message);
    this.name = "FollowerHttpError";
  }
}

async function post<T>(path: string, body: object): Promise<T> {
  const response = await fetch(new URL(path, leader), {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify({ id: values.id, session, ...body }),
    signal: AbortSignal.timeout(25_000),
  });
  if (!response.ok)
    throw new FollowerHttpError(`Leader ${path}: HTTP ${response.status}`, response.status);
  return (await response.json()) as T;
}
function emit(actorId: string, message: FollowerEvent["message"], eventId?: string): void {
  if (stopped) return;
  events.push({ eventId: eventId ?? randomUUID(), actorId, message });
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
    while ((pendingBatch || events.length) && !stopped) {
      if (!pendingBatch) {
        if (!events.length) break;
        const count = Math.min(events.length, 100);
        pendingBatch = {
          batchId: randomUUID(),
          events: events.slice(0, count),
        };
      }
      await post("/events", {
        batchId: pendingBatch.batchId,
        events: pendingBatch.events,
      });
      events.splice(0, pendingBatch.events.length);
      pendingBatch = undefined;
    }
  } catch (error) {
    log.warn("follower_event_flush_failed", { err: error });
    if (error instanceof FollowerHttpError && error.status === 410) {
      session = "";
    }
    if (!stopped && (pendingBatch || events.length) && !sendTimer) {
      sendTimer = setTimeout(() => {
        sendTimer = undefined;
        void flush();
      }, 500);
    }
  } finally {
    sending = false;
  }
}
async function stop(code: number): Promise<void> {
  if (stopped) return;
  stopped = true;
  clearTimeout(sendTimer);
  instance.close();
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

async function run(): Promise<void> {
  let backoffMs = 500;
  const maxBackoffMs = 10_000;

  while (!stopped) {
    if (!session) {
      try {
        const registration = await post<{
          session: string;
          protocolVersion: number;
          leaderToken?: string;
        }>("/register", {
          platform: process.platform,
          pid: process.pid,
          protocolVersion: INSTANCE_PROTOCOL_VERSION,
        });
        if (registration.protocolVersion !== INSTANCE_PROTOCOL_VERSION)
          throw new Error("Incompatible instance protocol; rebuild leader and follower");

        if (leaderToken && registration.leaderToken && registration.leaderToken !== leaderToken) {
          log.info("follower_leader_restarted_fencing_pending_events", {
            oldLeaderToken: leaderToken,
            newLeaderToken: registration.leaderToken,
          });
          pendingBatch = undefined;
          events.length = 0;
        }
        leaderToken = registration.leaderToken;
        session = registration.session;
        backoffMs = 500;
        log.info("follower_registered", {
          leader: leader.origin,
          pid: process.pid,
          sandbox: values.sandbox,
        });
        void flush();
      } catch (error) {
        if (stopped) break;
        if (error instanceof Error && error.message.includes("Incompatible instance protocol")) {
          throw error;
        }
        log.warn("follower_registration_failed", { err: error, retryInMs: backoffMs });
        await new Promise((r) => setTimeout(r, backoffMs));
        backoffMs = Math.min(backoffMs * 2, maxBackoffMs);
        continue;
      }
    }

    try {
      if ((events.length || pendingBatch) && !sending) void flush();
      const commands = await post<FollowerCommand[]>("/poll", {});
      for (const command of commands) instance.dispatch(command);
      backoffMs = 500;
    } catch (error) {
      if (stopped) break;
      log.warn("follower_poll_failed", { err: error, retryInMs: backoffMs });
      session = "";
      await new Promise((r) => setTimeout(r, backoffMs));
      backoffMs = Math.min(backoffMs * 2, maxBackoffMs);
    }
  }
}

try {
  await run();
} catch (error) {
  log.error("follower_stopped", { err: error });
  await stop(1);
}
