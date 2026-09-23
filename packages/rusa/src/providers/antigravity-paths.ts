import { homedir } from "node:os";
import { join } from "node:path";

/** Host-wide root for CLI-created Antigravity workspaces. */
export function antigravityScratchDir(): string {
  return join(homedir(), ".gemini", "antigravity-cli", "scratch");
}

/** A sandboxed actor's private, non-durable provider-scratch view. */
export function antigravityActorScratchDir(actorDir: string): string {
  return join(actorDir, ".antigravity-scratch");
}
