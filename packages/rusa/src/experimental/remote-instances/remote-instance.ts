import { randomBytes } from "node:crypto";
import { EventEmitter } from "node:events";
import type { ServerResponse } from "node:http";
import type { ActorChannel } from "./actor-channel.js";
import type { FollowerCommand, FollowerEvent } from "./follower-hub.js";
import type { LeaderCommand } from "./protocol.js";

/** Leader-side representation of one registered follower generation. */
export class RemoteInstance {
  readonly session = randomBytes(32).toString("hex");
  readonly hosts = new Map<string, InstanceActorChannel>();
  readonly commands: FollowerCommand[] = [];
  seen = Date.now();
  poll?: ServerResponse;
  pollTimer?: ReturnType<typeof setTimeout>;

  constructor(
    readonly id: string,
    readonly platform: string,
    readonly pid: number
  ) {}

  createHost(actorId: string): ActorChannel {
    if (this.hosts.has(actorId)) throw new Error("Actor already assigned");
    const host = new InstanceActorChannel(this.id, this.pid, (message) => {
      this.commands.push({ actorId, message });
      this.flush();
    });
    this.hosts.set(actorId, host);
    host.once("exit", () => this.hosts.delete(actorId));
    return host;
  }

  receive(event: FollowerEvent): void {
    this.hosts.get(event.actorId)?.receive(event.message);
  }

  flush(): void {
    if (!this.poll || !this.commands.length) return;
    clearTimeout(this.pollTimer);
    this.poll.writeHead(200, { "content-type": "application/json" });
    this.poll.end(JSON.stringify(this.commands.splice(0)));
    this.poll = undefined;
  }

  close(): void {
    clearTimeout(this.pollTimer);
    if (this.poll) {
      this.poll.writeHead(410, { "content-type": "application/json" });
      this.poll.end(JSON.stringify({ error: "Follower disconnected" }));
      this.poll = undefined;
    }
    for (const host of [...this.hosts.values()])
      host.receive({ type: "exit", code: -1, signal: null });
    this.commands.length = 0;
  }
}

/** An actor-addressed channel on the instance connection, not an OS process. */
class InstanceActorChannel extends EventEmitter implements ActorChannel {
  connected = true;
  exitCode: number | null = null;
  signalCode: NodeJS.Signals | null = null;
  constructor(
    readonly nodeId: string,
    readonly pid: number,
    private readonly enqueue: (message: LeaderCommand) => void
  ) {
    super();
  }

  send(message: LeaderCommand, callback: (error: Error | null) => void): boolean {
    if (!this.connected) {
      callback(new Error("Remote instance actor disconnected"));
      return false;
    }
    this.enqueue(message);
    callback(null);
    return true;
  }

  receive(message: FollowerEvent["message"]): void {
    if (!this.connected) return;
    if (message.type === "exit") {
      this.connected = false;
      this.exitCode = message.code;
      this.signalCode = message.signal;
      this.emit("exit", message.code, message.signal);
    } else this.emit("message", message);
  }
}
