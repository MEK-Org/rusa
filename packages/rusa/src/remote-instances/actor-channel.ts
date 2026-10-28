import type { EventEmitter } from "node:events";
import type { LeaderCommand } from "./protocol.js";

/** Actor-addressed channel owned by a RemoteInstance; not a child process. */
export interface ActorChannel extends EventEmitter {
  nodeId?: string;
  pid?: number;
  /**
   * The instance that reports this channel's run terminals as durable receipts
   * (#1020); absent when the host did not negotiate them.
   */
  readonly durableHost?: string;
  connected: boolean;
  exitCode: number | null;
  signalCode: NodeJS.Signals | null;
  send(message: LeaderCommand, callback: (error: Error | null) => void): boolean;
}
