export interface FdStat {
  dev: bigint;
  ino: bigint;
  mode: number;
  nlink: number;
  size: number;
}

/**
 * Each call takes one directory descriptor and one path component: non-empty,
 * without `/` or NUL, and not `.` or `..`. Nothing follows a symlink. Errors
 * carry Node-style `code`, `errno` and `syscall` properties.
 */
export interface FdOps {
  /** `openat` with `O_NOFOLLOW`, `O_CLOEXEC` and, on macOS, `O_NOFOLLOW_ANY` added. */
  openat(dirfd: number, name: string, flags: number, mode?: number): number;
  /** `fstatat` with `AT_SYMLINK_NOFOLLOW`. */
  fstatat(dirfd: number, name: string): FdStat;
  /** `linkat` without following `oldname`; `EEXIST` rather than replacing `newname`. */
  linkat(olddirfd: number, oldname: string, newdirfd: number, newname: string): void;
  /** `unlinkat` of a non-directory entry; a symlink is removed itself. */
  unlinkat(dirfd: number, name: string): void;
  /** The platform's `O_NOFOLLOW_ANY`, or 0 where it has none. */
  readonly O_NOFOLLOW_ANY: number;
}

export function loadFdOps(): FdOps;
