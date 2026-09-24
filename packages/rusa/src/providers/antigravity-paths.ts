import {
  copyFileSync,
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
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
 *
 * Staged atomically: files stage in an actor-private temporary directory before
 * being moved to their final locations, and the primary DB is published last.
 * If copying or publishing is interrupted, no private DB exists at the
 * destination, allowing retries to cleanly start over rather than resuming
 * incomplete context.
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

  const stagingDir = join(actorStateDir, ".staging", conversationId);
  rmSync(stagingDir, { recursive: true, force: true });
  mkdirSync(join(stagingDir, "conversations"), { recursive: true, mode: 0o700 });

  const suffixes = ["", "-wal", "-shm"] as const;
  for (const suffix of suffixes) {
    const source = join(hostDir, `${db}${suffix}`);
    if (isRegularFile(source)) {
      copyFileSync(source, join(stagingDir, `${db}${suffix}`));
    }
  }

  const annotationRel = join("annotations", `${conversationId}.pbtxt`);
  const annotationSource = join(hostDir, annotationRel);
  if (isRegularFile(annotationSource)) {
    mkdirSync(join(stagingDir, "annotations"), { recursive: true, mode: 0o700 });
    copyFileSync(annotationSource, join(stagingDir, annotationRel));
  }

  const brainRel = join("brain", conversationId);
  const brainSource = join(hostDir, brainRel);
  if (isRealDir(brainSource)) {
    mkdirSync(join(stagingDir, "brain"), { recursive: true, mode: 0o700 });
    cpSync(brainSource, join(stagingDir, brainRel), {
      recursive: true,
      verbatimSymlinks: true,
    });
  }

  // Publish from staging to destination. Auxiliary files (brain, annotations,
  // WAL/SHM) are published first; the primary DB is published last so an
  // interrupted sequence never leaves an orphan DB that tricks future retries.
  if (existsSync(join(stagingDir, brainRel))) {
    rmSync(join(actorStateDir, brainRel), { recursive: true, force: true });
    renameSync(join(stagingDir, brainRel), join(actorStateDir, brainRel));
  }
  if (existsSync(join(stagingDir, annotationRel))) {
    rmSync(join(actorStateDir, annotationRel), { force: true });
    renameSync(join(stagingDir, annotationRel), join(actorStateDir, annotationRel));
  }
  for (const suffix of ["-wal", "-shm"] as const) {
    const staged = join(stagingDir, `${db}${suffix}`);
    if (existsSync(staged)) {
      rmSync(join(actorStateDir, `${db}${suffix}`), { force: true });
      renameSync(staged, join(actorStateDir, `${db}${suffix}`));
    }
  }
  renameSync(join(stagingDir, db), join(actorStateDir, db));

  rmSync(stagingDir, { recursive: true, force: true });
  return true;
}
