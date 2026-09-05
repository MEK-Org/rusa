import { type ChildProcess, fork } from "node:child_process";
import { mkdirSync, readFileSync } from "node:fs";
import { hostname } from "node:os";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import type { FollowerCommand, FollowerEvent } from "./follower-hub.js";
import type { Bootstrap, ChildMessage, ParentMessage } from "./protocol.js";

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
const root = resolve(values.home);
mkdirSync(join(root, "workers"), { recursive: true });
const children = new Map<string, ChildProcess>();
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
    console.error(String(error));
    await stop(1);
  } finally {
    sending = false;
  }
}
function dispatch(command: FollowerCommand): void {
  if (!command || !/^[a-zA-Z0-9_-]{1,128}$/.test(command.actorId))
    throw new Error("Invalid actor ID");
  const { actorId, message } = command;
  if (message.type === "init") {
    if (children.has(actorId)) throw new Error("Actor already exists on follower");
    const cwd = join(root, "workers", actorId);
    mkdirSync(cwd, { recursive: true });
    const bootstrap: Bootstrap = {
      ...message.bootstrap,
      id: actorId,
      cwd,
      // Never resolve an executable/module/working directory supplied by the leader.
      providerModule: new URL("./process-actor-provider.js", import.meta.url).href,
      actorOptions: {
        ...message.bootstrap.actorOptions,
        addDirs: [],
        sandbox: values.sandbox === "bwrap",
      },
    };
    const child = fork(new URL("./process-actor-child.js", import.meta.url), [], {
      cwd,
      execArgv: [],
      stdio: ["ignore", "pipe", "pipe", "ipc"],
      // Config and credentials are local. Do not borrow any leader RUSA_HOME.
      env: { ...process.env, RUSA_HOME: root },
    });
    children.set(actorId, child);
    child.stdout?.on("data", (chunk: Buffer) =>
      emit(actorId, { type: "log", chunk: chunk.toString() })
    );
    child.stderr?.on("data", (chunk: Buffer) =>
      emit(actorId, { type: "log", chunk: chunk.toString() })
    );
    child.on("message", (raw) => emit(actorId, raw as ChildMessage));
    child.on("error", (error) => emit(actorId, { type: "fatal", error: error.message }));
    child.once("exit", (code, signal) => {
      children.delete(actorId);
      emit(actorId, { type: "exit", code, signal });
      console.log(`Actor ${actorId} exited; follower remains connected (${children.size} actors).`);
    });
    child.send({ type: "init", bootstrap } satisfies ParentMessage);
    console.log(`Actor ${actorId}: pid=${child.pid} cwd=${cwd}`);
    return;
  }
  const child = children.get(actorId);
  if (!child) return;
  if (message.type === "kill") child.kill("SIGKILL");
  else if (child.connected)
    child.send(message, (error) => {
      if (error) emit(actorId, { type: "fatal", error: error.message });
    });
}
async function stop(code: number): Promise<void> {
  if (stopped) return;
  stopped = true;
  clearTimeout(sendTimer);
  for (const child of children.values()) {
    if (child.connected) child.send({ type: "stop" } satisfies ParentMessage);
  }
  // A lost leader ends this follower generation. No commands are replayed automatically.
  const force = setTimeout(() => {
    for (const child of children.values()) child.kill("SIGKILL");
    process.exit(code);
  }, 1500);
  if (session) await post("/unregister", {}).catch(() => {});
  if (!children.size) {
    clearTimeout(force);
    process.exit(code);
  }
}
process.on("SIGINT", () => {
  void stop(0);
});
process.on("SIGTERM", () => {
  void stop(0);
});
try {
  ({ session } = await post<{ session: string }>("/register", {
    platform: process.platform,
    pid: process.pid,
  }));
  console.log(
    `Follower ${values.id} registered with ${leader.origin}; pid=${process.pid}; sandbox=${values.sandbox}`
  );
  while (!stopped) {
    const commands = await post<FollowerCommand[]>("/poll", {});
    for (const command of commands) dispatch(command);
  }
} catch (error) {
  console.error(String(error));
  await stop(1);
}
