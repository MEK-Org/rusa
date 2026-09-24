import { copyFileSync, cpSync, existsSync, lstatSync, mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

/** Host-wide Antigravity CLI state directory (auth, config, and CLI records). */
export function antigravityStateDir(): string {
  return join(homedir(), ".gemini", "antigravity-cli");
}

/**
 * agy state that carries conversation content, relative to the state dir.
 * Observed from agy's print-mode write set: per-conversation directories
 * (`brain/<id>` holds full transcripts and tool outputs) plus host-wide
 * summaries of every conversation (titles and prompt previews). A sandboxed
 * worker sees actor-private copies of all of these; auth and config stay shared.
 */
export const ANTIGRAVITY_PRIVATE_STATE_DIRS = [
  "scratch",
  "conversations",
  "brain",
  "annotations",
  "implicit",
  "presence",
  "log",
  "crashes",
] as const;

/** Host-wide agy record files, with the empty content agy accepts for a fresh one. */
export const ANTIGRAVITY_PRIVATE_STATE_FILES = [
  { path: "conversation_summaries.db", seed: "" },
  { path: "jetbox_summaries_proto.pb", seed: "" },
  { path: "history.jsonl", seed: "" },
  { path: join("cache", "last_conversations.json"), seed: "{}" },
] as const;

/** Host-wide root for CLI-created Antigravity workspaces. */
export function antigravityScratchDir(): string {
  return join(antigravityStateDir(), "scratch");
}

/** Host-wide location the CLI uses for its conversation database files. */
export function antigravityConversationsDir(): string {
  return join(antigravityStateDir(), "conversations");
}

/**
 * A sandboxed actor's private mirror of {@link ANTIGRAVITY_PRIVATE_STATE_DIRS}
 * and {@link ANTIGRAVITY_PRIVATE_STATE_FILES}. It is provider state, not durable
 * work, and the enclosing actor workdir removes it at retirement.
 */
export function antigravityActorStateDir(actorDir: string): string {
  return join(actorDir, ".antigravity-state");
}

/** A sandboxed actor's private provider-scratch view. */
export function antigravityActorScratchDir(actorDir: string): string {
  return join(antigravityActorStateDir(actorDir), "scratch");
}

/** A sandboxed actor's private conversation store. */
export function antigravityActorConversationsDir(actorDir: string): string {
  return join(antigravityActorStateDir(actorDir), "conversations");
}

/**
 * Create the host and actor-private sides of every private-state bind, since
 * `--bind` needs both to exist. Host files are only created when absent, with
 * content agy accepts; existing host records are never modified.
 */
export function ensureAntigravityPrivateState(actorDir: string): void {
  const hostDir = antigravityStateDir();
  const actorStateDir = antigravityActorStateDir(actorDir);
  for (const dir of ANTIGRAVITY_PRIVATE_STATE_DIRS) {
    mkdirSync(join(hostDir, dir), { recursive: true, mode: 0o700 });
    mkdirSync(join(actorStateDir, dir), { recursive: true, mode: 0o700 });
  }
  for (const { path, seed } of ANTIGRAVITY_PRIVATE_STATE_FILES) {
    for (const root of [hostDir, actorStateDir]) {
      const target = join(root, path);
      mkdirSync(dirname(target), { recursive: true, mode: 0o700 });
      if (!existsSync(target)) writeFileSync(target, seed, { flag: "wx", mode: 0o600 });
    }
  }
}

const CONVERSATION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function isRegularFile(path: string): boolean {
  try {
    return lstatSync(path).isFile();
  } catch {
    return false;
  }
}

function isRealDir(path: string): boolean {
  try {
    return lstatSync(path).isDirectory();
  } catch {
    return false;
  }
}

/**
 * Carry an actor's own persisted conversation from the host-wide store into its
 * private store, once. Sandboxes that predate private state resumed from the
 * shared store; without this, agy would find no such conversation, start a new
 * one, and silently drop the actor's context. `conversationId` is the actor's
 * own session record, so this copies exactly that conversation and nothing
 * else, and it leaves the host records unchanged.
 */
export function carryForwardAntigravityConversation(
  actorDir: string,
  conversationId: string
): boolean {
  if (!CONVERSATION_ID.test(conversationId)) return false;
  const hostDir = antigravityStateDir();
  const actorStateDir = antigravityActorStateDir(actorDir);
  const db = join("conversations", `${conversationId}.db`);
  if (existsSync(join(actorStateDir, db)) || !isRegularFile(join(hostDir, db))) return false;

  for (const suffix of ["", "-wal", "-shm"]) {
    const source = join(hostDir, `${db}${suffix}`);
    if (isRegularFile(source)) copyFileSync(source, join(actorStateDir, `${db}${suffix}`));
  }
  const annotation = join("annotations", `${conversationId}.pbtxt`);
  if (isRegularFile(join(hostDir, annotation))) {
    copyFileSync(join(hostDir, annotation), join(actorStateDir, annotation));
  }
  const brain = join("brain", conversationId);
  if (isRealDir(join(hostDir, brain))) {
    cpSync(join(hostDir, brain), join(actorStateDir, brain), {
      recursive: true,
      verbatimSymlinks: true,
    });
  }
  return true;
}
