import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  renameSync,
  rmSync,
} from "node:fs";
import { dirname } from "node:path";
import Database from "better-sqlite3";

export const DEFAULT_OLD_QUOTA_DB_NAME = "quota.db";
export const DEFAULT_RELOCATED_QUOTA_DB_NAME = "quota-coordinator.db";

/**
 * The fence is an empty directory with this exact mode. The mode is not a
 * security boundary — instances and the service run as the same user — it is a
 * signature, so that anything inspecting the old path can tell the placeholder
 * relocation made from a directory something else put there.
 */
export const BLOCKING_DIRECTORY_MODE = 0o700;

export interface RelocateQuotaDatabaseOptions {
  /** The pre-service file the instances used to open directly. */
  oldDatabasePath: string;
  /** The service-owned file; must sit in the same directory as the old one. */
  newDatabasePath: string;
}

export interface RelocateQuotaDatabaseResult {
  /** The main file was renamed by this call. */
  renamed: boolean;
  /** The blocking directory was created by this call. */
  placeholderCreated: boolean;
}

type PathKind = "missing" | "file" | "directory";

function pathKind(path: string): PathKind {
  if (!existsSync(path)) return "missing";
  const stat = lstatSync(path);
  if (stat.isSymbolicLink()) {
    throw new Error(`Refusing symbolic-link quota database path: ${path}`);
  }
  if (stat.isFile()) return "file";
  if (stat.isDirectory()) return "directory";
  throw new Error(`Quota database path must be a regular file or directory: ${path}`);
}

/**
 * Accept only the placeholder relocation makes: empty, and carrying the
 * signature mode. Anything else at the old path is somebody else's directory.
 */
export function assertBlockingDirectory(path: string): void {
  if (pathKind(path) !== "directory") {
    throw new Error(`Expected blocking directory placeholder at ${path}`);
  }
  const mode = lstatSync(path).mode & 0o777;
  if (mode !== BLOCKING_DIRECTORY_MODE) {
    throw new Error(
      `Refusing to use ${path} as a quota placeholder: expected mode 0o700, found 0o${mode.toString(8)}`
    );
  }
  if (readdirSync(path).length > 0) {
    throw new Error(`Refusing to use non-empty directory as a quota placeholder: ${path}`);
  }
}

function createBlockingDirectory(path: string): boolean {
  if (existsSync(path)) {
    assertBlockingDirectory(path);
    return false;
  }
  mkdirSync(path, { mode: BLOCKING_DIRECTORY_MODE });
  // mkdir's mode is filtered by the process umask; apply the signature mode
  // explicitly so the placeholder is recognizable regardless of the caller's.
  chmodSync(path, BLOCKING_DIRECTORY_MODE);
  return true;
}

/**
 * Fold WAL state into the main file so the one rename below moves everything.
 *
 * Stage 3 is a scheduled quiesce, and this is where a missed quiesce shows up:
 * a checkpoint that finds another connection fails immediately (busy timeout
 * zero) with every path untouched, rather than waiting behind a live instance
 * and turning the flip into a concurrency window. There is deliberately no
 * attempt to make a three-file SQLite rename look atomic.
 */
function checkpointForRename(path: string): void {
  const db = new Database(path, { fileMustExist: true });
  try {
    db.pragma("busy_timeout = 0");
    const [status] = db.pragma("wal_checkpoint(TRUNCATE)") as Array<{
      busy?: number;
      log?: number;
      checkpointed?: number;
    }>;
    if (!status || status.busy || status.log !== status.checkpointed) {
      throw new Error(
        `Cannot relocate quota database while SQLite has active readers or writers at ${path}; stop all instances and retry the scheduled stage-3 flip`
      );
    }
  } finally {
    db.close();
  }

  const walPath = `${path}-wal`;
  if (existsSync(walPath)) {
    if (pathKind(walPath) !== "file" || lstatSync(walPath).size !== 0) {
      throw new Error(
        `Cannot relocate quota database: ${walPath} still contains SQLite state after checkpoint`
      );
    }
    rmSync(walPath, { force: true });
  }
  // The shared-memory index holds no committed pages; SQLite recreates it at
  // the destination on the first WAL connection.
  const shmPath = `${path}-shm`;
  if (existsSync(shmPath)) {
    if (pathKind(shmPath) !== "file") {
      throw new Error(
        `Cannot relocate quota database: invalid SQLite shared-memory path ${shmPath}`
      );
    }
    rmSync(shmPath, { force: true });
  }
}

/**
 * The stage-3 flip from §8.2/§8.3 of the quota coordinator design: rename the
 * pre-service database to the service-owned path, then put an empty directory
 * where the file was.
 *
 * The rename is the whole continuity story (§8.1) — same directory, one
 * `rename(2)`, every row and the controller's memory untouched. The directory
 * is the whole old-writer story: `new Database(oldPath)` against a directory
 * fails with `SQLITE_CANTOPEN`, so a build with no service awareness dies at
 * open instead of pacing from a fresh empty file. Nothing here consults or
 * stamps `user_version`; the service does that when it opens the file.
 *
 * Re-running after a completed flip is a no-op. An operator who has already
 * done the rename by hand (old absent, new present) gets the fence and nothing
 * else. Nothing at either path is an error: an explicit flip with nothing to
 * flip is a wrong path, not a fresh install to decorate.
 *
 * Rollback (§8.3) is the inverse by hand and is not automated: stop the
 * service, `rmdir` the placeholder, rename the file back. The service's
 * `user_version` stays behind in the header; §8.1 records why that is harmless.
 */
export function relocateQuotaDatabase(
  options: RelocateQuotaDatabaseOptions
): RelocateQuotaDatabaseResult {
  const oldPath = options.oldDatabasePath;
  const newPath = options.newDatabasePath;
  if (oldPath === newPath || dirname(oldPath) !== dirname(newPath)) {
    throw new Error(
      "Quota database relocation requires distinct old and new paths in the same directory"
    );
  }

  const oldKind = pathKind(oldPath);
  const newKind = pathKind(newPath);
  if (newKind === "directory") {
    throw new Error(`Relocated quota database path must be a regular file: ${newPath}`);
  }

  switch (oldKind) {
    case "file": {
      if (newKind === "file") {
        throw new Error(
          `Cannot relocate quota database: both ${oldPath} and ${newPath} exist; decide which is authoritative before the flip`
        );
      }
      checkpointForRename(oldPath);
      renameSync(oldPath, newPath);
      return { renamed: true, placeholderCreated: createBlockingDirectory(oldPath) };
    }
    case "directory": {
      assertBlockingDirectory(oldPath);
      if (newKind === "missing") {
        throw new Error(
          `Blocking directory exists at ${oldPath}, but relocated database is missing at ${newPath}`
        );
      }
      return { renamed: false, placeholderCreated: false };
    }
    case "missing": {
      if (newKind === "missing") {
        throw new Error(
          `Nothing to relocate: no quota database at ${oldPath} and none at ${newPath}`
        );
      }
      return { renamed: false, placeholderCreated: createBlockingDirectory(oldPath) };
    }
  }
}
