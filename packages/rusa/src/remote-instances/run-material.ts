import { createHash, randomUUID } from "node:crypto";
import * as fs from "node:fs";
import { dirname, join } from "node:path";
import { FAILURE_DIAGNOSTIC_BUDGET, failureDiagnostic } from "../actor/failure-sink.js";
import { ACTOR_RUN_OUTPUT_MAX_CHARS } from "../db/repositories/actor-run-repository.js";
import type { RunOutputBound, RunResult } from "../providers/types.js";
import { BOUNDED_EXECUTION_CAPABILITY, type BoundedExecutionCapability } from "./protocol.js";

/**
 * Host-local run material (#1020): the exact prompts and output of runs this
 * host executed, kept as write-once files so a follower's routine events can
 * carry references instead of the full text.
 *
 * Layout, version 1, under `<home>/run-material/v1`:
 *
 *     <actorId>/<runId>/prompt-<attempt>.<sha256>   one per prompt attempt, never replaced
 *     <actorId>/<runId>/output.<sha256>             the run's whole output
 *     <actorId>/<runId>/attempt                     decimal last-allocated prompt attempt
 *
 * Each material file holds the original UTF-8 bytes; its name carries the
 * SHA-256 hex of those bytes, so a reader verifies what it returns. A file is
 * written to a temporary name, fsynced, hard-linked to its final name and the
 * directory fsynced before anyone is told it exists. A run's directory expires
 * {@link RUN_MATERIAL_RETENTION_MS} after its last write, never while the run
 * is still open in this process.
 */
export const RUN_MATERIAL_ROOT = join("run-material", "v1");
export const RUN_MATERIAL_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;
/** Largest original a read returns; a larger one stays retained and is refused with its size. */
export const RUN_MATERIAL_READ_MAX_BYTES = 47 * 1024 * 1024;
/** Largest serialized follower event a bounded completion may produce. */
export const BOUNDED_COMPLETE_MAX_BYTES = 256 * 1024;
/** How often a host expires run material past retention. */
export const RUN_MATERIAL_SWEEP_INTERVAL_MS = 60 * 60 * 1000;
/** How long the leader waits for a follower's material read. */
export const MATERIAL_READ_TIMEOUT_MS = 30_000;
/** Material reads the leader keeps in flight per follower; more are refused as busy. */
export const MATERIAL_READS_PER_HOST = 4;

const ID = /^[a-zA-Z0-9_-]{1,128}$/;
const SHA256 = /^[0-9a-f]{64}$/;
const PROMPT_FILE = /^prompt-([1-9][0-9]{0,8})\.([0-9a-f]{64})$/;
const OUTPUT_FILE = /^output\.([0-9a-f]{64})$/;
const ATTEMPT_FILE = "attempt";
const TRASH_DIR = ".trash";

export type RunMaterialKind = "prompt" | "output";

export type RunMaterialIo = Pick<
  typeof fs,
  | "closeSync"
  | "fsyncSync"
  | "linkSync"
  | "mkdirSync"
  | "openSync"
  | "readdirSync"
  | "readFileSync"
  | "renameSync"
  | "rmSync"
  | "statSync"
  | "unlinkSync"
  | "writeSync"
>;

export interface RunMaterialRef {
  bytes: number;
  sha256: string;
}

export type RunMaterialRead =
  | { status: "ok"; attempt?: number; bytes: number; sha256: string; content: Buffer }
  /**
   * A latest prompt read includes the newest allocated attempt when that
   * original is unavailable. The leader must not substitute an older file.
   */
  | { status: "missing"; attempt?: number }
  | { status: "tooLarge"; attempt?: number; bytes: number; sha256: string }
  | { status: "integrity" };

/** A retained file's bytes do not match its name, or a name is ambiguous. */
export class RunMaterialIntegrityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RunMaterialIntegrityError";
  }
}

const sha256 = (content: Buffer): string => createHash("sha256").update(content).digest("hex");

function errorCode(err: unknown): string | undefined {
  return (err as NodeJS.ErrnoException | undefined)?.code;
}

export class RunMaterialStore {
  /** Last allocated prompt attempt per open run, ahead of the counter file when it cannot be written. */
  private readonly attempts = new Map<string, number>();
  private readonly open = new Set<string>();

  constructor(
    readonly root: string,
    private readonly io: RunMaterialIo = fs
  ) {}

  /** Mark a run active, so a sweep never expires it mid-run. */
  openRun(actorId: string, runId: string): void {
    this.open.add(this.key(actorId, runId));
  }

  closeRun(actorId: string, runId: string): void {
    const key = this.key(actorId, runId);
    this.open.delete(key);
    this.attempts.delete(key);
  }

  /**
   * Allocate the run's next prompt attempt. The key only advances: a write that
   * later fails still spends its number, and the counter file carries it across
   * a restart. The counter is persisted best-effort; memory alone still keeps
   * this process monotonic when the directory cannot be written.
   */
  nextPromptAttempt(actorId: string, runId: string): number {
    const key = this.key(actorId, runId);
    const dir = this.runDir(actorId, runId);
    let last = Math.max(this.attempts.get(key) ?? 0, this.readCounter(dir));
    try {
      for (const name of this.list(dir) ?? []) {
        const match = PROMPT_FILE.exec(name);
        if (match) last = Math.max(last, Number(match[1]));
      }
    } catch {
      // An unreadable directory cannot make the fallback lose its identity.
      // Memory remains monotonic for this process and the counter write below
      // is still attempted for the next process.
    }
    const next = last + 1;
    this.attempts.set(key, next);
    try {
      this.writeCounter(dir, next);
    } catch {
      // The in-memory key above is authoritative for this process.
    }
    return next;
  }

  putPrompt(actorId: string, runId: string, attempt: number, prompt: string): RunMaterialRef {
    if (!Number.isSafeInteger(attempt) || attempt < 1) {
      throw new Error(`Invalid prompt attempt: ${attempt}`);
    }
    const content = Buffer.from(prompt, "utf8");
    const hash = sha256(content);
    this.writeOnce(this.runDir(actorId, runId), `prompt-${attempt}.${hash}`, content, hash);
    return { bytes: content.length, sha256: hash };
  }

  putOutput(actorId: string, runId: string, output: string): RunMaterialRef {
    const content = Buffer.from(output, "utf8");
    const hash = sha256(content);
    this.writeOnce(this.runDir(actorId, runId), `output.${hash}`, content, hash);
    return { bytes: content.length, sha256: hash };
  }

  /** The newest allocated prompt attempt for the run, if it can be discovered. */
  latestPromptAttempt(actorId: string, runId: string): number | undefined {
    const dir = this.runDir(actorId, runId);
    let latest = this.readCounter(dir);
    for (const name of this.list(dir) ?? []) {
      const match = PROMPT_FILE.exec(name);
      if (match) latest = Math.max(latest, Number(match[1]));
    }
    return latest || undefined;
  }

  /** Read one retained original; without `attempt`, a prompt read returns the latest attempt. */
  read(actorId: string, runId: string, kind: RunMaterialKind, attempt?: number): RunMaterialRead {
    const dir = this.runDir(actorId, runId);
    const names = this.list(dir);
    if (!names) return { status: "missing" };
    const candidates: Array<{ name: string; hash: string; attempt?: number }> = [];
    for (const name of names) {
      if (kind === "output") {
        const match = OUTPUT_FILE.exec(name);
        if (match) candidates.push({ name, hash: match[1] });
        continue;
      }
      const match = PROMPT_FILE.exec(name);
      if (match) candidates.push({ name, hash: match[2], attempt: Number(match[1]) });
    }
    let wanted = candidates;
    let latest: number | undefined;
    if (kind === "prompt") {
      latest = this.readCounter(dir);
      for (const candidate of candidates) latest = Math.max(latest, candidate.attempt ?? 0);
      const target = attempt ?? latest;
      wanted = candidates.filter((c) => c.attempt === target);
    }
    if (wanted.length === 0) {
      return {
        status: "missing",
        ...(kind === "prompt" && attempt === undefined && latest ? { attempt: latest } : {}),
      };
    }
    // Two originals under one key means something other than this store wrote here.
    if (wanted.length > 1) return { status: "integrity" };
    const [file] = wanted;
    const path = join(dir, file.name);
    let size: number;
    try {
      size = this.io.statSync(path).size;
    } catch (err) {
      if (errorCode(err) === "ENOENT") return { status: "missing" };
      throw err;
    }
    if (size > RUN_MATERIAL_READ_MAX_BYTES) {
      return {
        status: "tooLarge",
        ...(file.attempt === undefined ? {} : { attempt: file.attempt }),
        bytes: size,
        sha256: file.hash,
      };
    }
    const content = this.io.readFileSync(path);
    if (sha256(content) !== file.hash) return { status: "integrity" };
    return {
      status: "ok",
      ...(file.attempt === undefined ? {} : { attempt: file.attempt }),
      bytes: content.length,
      sha256: file.hash,
      content,
    };
  }

  /** Expire runs idle past retention, skipping runs open here. Returns how many expired. */
  sweep(now = Date.now()): number {
    const cutoff = now - RUN_MATERIAL_RETENTION_MS;
    const trash = join(this.root, TRASH_DIR);
    this.io.rmSync(trash, { recursive: true, force: true });
    let expired = 0;
    for (const actorId of this.list(this.root) ?? []) {
      if (!ID.test(actorId)) continue;
      const actorDir = join(this.root, actorId);
      const runs = this.list(actorDir) ?? [];
      for (const runId of runs) {
        if (!ID.test(runId) || this.open.has(this.key(actorId, runId))) continue;
        const dir = join(actorDir, runId);
        if (this.newestWrite(dir) >= cutoff) continue;
        // Renaming first takes the whole run out of view at once; a removal
        // interrupted after it leaves only trash for the next sweep.
        this.io.mkdirSync(trash, { recursive: true, mode: 0o700 });
        const doomed = join(trash, randomUUID());
        this.io.renameSync(dir, doomed);
        this.io.rmSync(doomed, { recursive: true, force: true });
        this.attempts.delete(this.key(actorId, runId));
        expired++;
      }
      if ((this.list(actorDir) ?? [undefined]).length === 0) {
        this.io.rmSync(actorDir, { recursive: true, force: true });
      }
    }
    return expired;
  }

  private key(actorId: string, runId: string): string {
    return `${actorId}/${runId}`;
  }

  private runDir(actorId: string, runId: string): string {
    if (!ID.test(actorId)) throw new Error(`Invalid run material actor id: ${actorId}`);
    if (!ID.test(runId)) throw new Error(`Invalid run material run id: ${runId}`);
    return join(this.root, actorId, runId);
  }

  private list(dir: string): string[] | undefined {
    try {
      return this.io.readdirSync(dir);
    } catch (err) {
      if (errorCode(err) === "ENOENT" || errorCode(err) === "ENOTDIR") return undefined;
      throw err;
    }
  }

  private newestWrite(dir: string): number {
    let newest = this.io.statSync(dir).mtimeMs;
    for (const name of this.list(dir) ?? []) {
      try {
        newest = Math.max(newest, this.io.statSync(join(dir, name)).mtimeMs);
      } catch {
        // Gone between list and stat; its directory's mtime already moved.
      }
    }
    return newest;
  }

  private readCounter(dir: string): number {
    try {
      const value = Number(this.io.readFileSync(join(dir, ATTEMPT_FILE), "utf8").trim());
      return Number.isSafeInteger(value) && value > 0 ? value : 0;
    } catch {
      return 0;
    }
  }

  private writeCounter(dir: string, attempt: number): void {
    this.ensureDir(dir);
    const tmp = join(dir, `.tmp-${randomUUID()}`);
    try {
      this.writeFile(tmp, Buffer.from(`${attempt}\n`, "utf8"));
      this.io.renameSync(tmp, join(dir, ATTEMPT_FILE));
    } finally {
      this.removeQuietly(tmp);
    }
    this.syncDir(dir);
  }

  /**
   * Publish `content` as `dir/name` exactly once: temporary file, fsync, hard
   * link, directory fsync. An existing file of that name is accepted only if
   * its bytes still hash to `hash`.
   */
  private writeOnce(dir: string, name: string, content: Buffer, hash: string): void {
    this.ensureDir(dir);
    const final = join(dir, name);
    const tmp = join(dir, `.tmp-${randomUUID()}`);
    try {
      this.writeFile(tmp, content);
      try {
        this.io.linkSync(tmp, final);
      } catch (err) {
        if (errorCode(err) !== "EEXIST") throw err;
        if (sha256(this.io.readFileSync(final)) !== hash) {
          throw new RunMaterialIntegrityError(`retained ${name} does not match its digest`);
        }
      }
    } finally {
      this.removeQuietly(tmp);
    }
    this.syncDir(dir);
    this.syncDir(dirname(dir));
    this.syncDir(this.root);
  }

  private ensureDir(dir: string): void {
    // mkdir({recursive:true}) does not say which parent entries reached
    // stable storage. Create one component at a time, syncing both the new
    // directory and its parent before a child can publish a material ref.
    const missing: string[] = [];
    let cursor = dir;
    for (;;) {
      try {
        this.io.statSync(cursor);
        break;
      } catch (err) {
        if (errorCode(err) !== "ENOENT") throw err;
        const parent = dirname(cursor);
        if (parent === cursor) throw err;
        missing.push(cursor);
        cursor = parent;
      }
    }
    for (const created of missing.reverse()) {
      try {
        this.io.mkdirSync(created, { mode: 0o700 });
      } catch (err) {
        if (errorCode(err) !== "EEXIST") throw err;
      }
      this.syncDir(created);
      this.syncDir(dirname(created));
    }
  }

  private writeFile(path: string, content: Buffer): void {
    const fd = this.io.openSync(path, "wx", 0o600);
    try {
      let offset = 0;
      while (offset < content.length) {
        offset += this.io.writeSync(fd, content, offset, content.length - offset);
      }
      this.io.fsyncSync(fd);
    } finally {
      this.io.closeSync(fd);
    }
  }

  private removeQuietly(path: string): void {
    try {
      this.io.unlinkSync(path);
    } catch {
      // Already linked and removed, or never created.
    }
  }

  private syncDir(dir: string): void {
    let fd: number;
    try {
      fd = this.io.openSync(dir, "r");
    } catch (err) {
      // Windows cannot open a directory for fsync; NTFS journals the link.
      if (process.platform === "win32") return;
      throw err;
    }
    try {
      this.io.fsyncSync(fd);
    } catch (err) {
      if (process.platform !== "win32") throw err;
    } finally {
      this.io.closeSync(fd);
    }
  }
}

/**
 * A follower's side of bounded execution: its store, the offer it makes on
 * `/register`, and whether the current leader accepted it. Each registration
 * replaces the answer, so a leader that stops echoing the capability gets full
 * text from then on.
 */
export class FollowerRunMaterial {
  readonly store: RunMaterialStore;
  private negotiated = false;

  constructor(home: string) {
    this.store = new RunMaterialStore(join(home, RUN_MATERIAL_ROOT));
  }

  readonly offer: BoundedExecutionCapability = BOUNDED_EXECUTION_CAPABILITY;

  get options(): { store: RunMaterialStore; enabled: () => boolean } {
    return { store: this.store, enabled: () => this.negotiated };
  }

  /** Record the leader's registration reply field. */
  accept(reply: unknown): boolean {
    this.negotiated = (reply as { version?: unknown } | null | undefined)?.version === 1;
    return this.negotiated;
  }

  /** Expire material past retention now and every {@link RUN_MATERIAL_SWEEP_INTERVAL_MS}; returns a stop function. */
  startSweeping(onError: (err: unknown) => void): () => void {
    const sweep = () => {
      try {
        this.store.sweep();
      } catch (err) {
        onError(err);
      }
    };
    sweep();
    const timer = setInterval(sweep, RUN_MATERIAL_SWEEP_INTERVAL_MS);
    timer.unref?.();
    return () => clearInterval(timer);
  }
}

/**
 * The result a follower sends instead of a full one once the output is
 * retained (#1020): the output's last {@link ACTOR_RUN_OUTPUT_MAX_CHARS} code
 * units, which is all any leader store keeps, plus the original's counts,
 * digest and, for a failed run, the diagnostic only the full output can give.
 * Every other field is unchanged.
 */
export function boundRunResult(result: RunResult, ref: RunMaterialRef): RunResult {
  const outputBound: RunOutputBound = {
    version: 1,
    totalChars: result.output.length,
    bytes: ref.bytes,
    sha256: ref.sha256,
    ...(result.success ? {} : { failureDiagnostic: failureDiagnostic(result) }),
  };
  return { ...result, output: result.output.slice(-ACTOR_RUN_OUTPUT_MAX_CHARS), outputBound };
}

/** Whether a bounded completion's whole follower event stays within {@link BOUNDED_COMPLETE_MAX_BYTES}. */
export function boundedCompleteFits(result: RunResult): boolean {
  // The widest envelope the event can travel in: a UUID event id, the longest
  // actor id and the largest request id.
  const event = {
    eventId: randomUUID(),
    actorId: "a".repeat(128),
    message: {
      type: "request",
      requestId: Number.MAX_SAFE_INTEGER,
      request: { op: "complete", result },
    },
  };
  return Buffer.byteLength(JSON.stringify(event), "utf8") <= BOUNDED_COMPLETE_MAX_BYTES;
}

/**
 * Validate a received result's bound before trusting its counts: version 1,
 * a tail exactly as long as the original allows, a digest, and a diagnostic
 * within the notice budget. Returns undefined when absent or malformed.
 */
export function parseOutputBound(result: RunResult): RunOutputBound | undefined {
  const bound: unknown = result.outputBound;
  if (!bound || typeof bound !== "object") return undefined;
  const {
    version,
    totalChars,
    bytes,
    sha256: hash,
    failureDiagnostic: diagnostic,
  } = bound as Record<string, unknown>;
  if (version !== 1) return undefined;
  if (typeof totalChars !== "number" || !Number.isSafeInteger(totalChars) || totalChars < 0) {
    return undefined;
  }
  if (typeof bytes !== "number" || !Number.isSafeInteger(bytes) || bytes < 0) return undefined;
  if (typeof hash !== "string" || !SHA256.test(hash)) return undefined;
  if (typeof result.output !== "string") return undefined;
  if (result.output.length !== Math.min(totalChars, ACTOR_RUN_OUTPUT_MAX_CHARS)) return undefined;
  if (
    diagnostic !== undefined &&
    (typeof diagnostic !== "string" || Array.from(diagnostic).length > FAILURE_DIAGNOSTIC_BUDGET)
  ) {
    return undefined;
  }
  return {
    version: 1,
    totalChars,
    bytes,
    sha256: hash,
    ...(diagnostic === undefined ? {} : { failureDiagnostic: diagnostic }),
  };
}

/** UTF-16 code units of output a bounded result left on its execution host. */
export function outputOmittedChars(result: RunResult): number {
  return result.outputBound ? Math.max(0, result.outputBound.totalChars - result.output.length) : 0;
}
