import type { EventEmitter } from "node:events";
import type { ParentMessage } from "./protocol.js";

/** A local child or an actor hosted by an already-connected follower instance. */
export interface ActorHost extends EventEmitter {
  nodeId?: string;
  pid?: number;
  connected: boolean;
  exitCode: number | null;
  signalCode: NodeJS.Signals | null;
  send(message: ParentMessage, callback: (error: Error | null) => void): boolean;
  kill(signal?: NodeJS.Signals): boolean;
}
