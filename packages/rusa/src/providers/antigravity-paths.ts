import { homedir } from "node:os";
import { join } from "node:path";

/** Host-wide root for CLI-created Antigravity workspaces. */
export function antigravityScratchDir(): string {
  return join(homedir(), ".gemini", "antigravity-cli", "scratch");
}

/** Host-wide location the CLI uses for its conversation database files. */
export function antigravityConversationsDir(): string {
  return join(homedir(), ".gemini", "antigravity-cli", "conversations");
}

/** A sandboxed actor's private provider-scratch view. Removed with its workdir on retirement. */
export function antigravityActorScratchDir(actorDir: string): string {
  return join(actorDir, ".antigravity-scratch");
}

/**
 * A sandboxed actor's persistent conversation store. It is private to the
 * actor while active, but the enclosing actor workdir removes it at retirement.
 */
export function antigravityActorConversationsDir(actorDir: string): string {
  return join(actorDir, ".antigravity-conversations");
}
