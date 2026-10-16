export interface FdStat {
  dev: bigint;
  ino: bigint;
  mode: number;
}

/**
 * Each call takes one directory descriptor and one path component: non-empty,
 * without `/` or NUL, and not `.` or `..`. Nothing follows a symlink. A
 * descriptor must be a non-negative integer (so never `AT_FDCWD`), and flags and
 * mode must be integers that fit in 32 bits; anything else throws
 * `ERR_INVALID_ARG_TYPE` or `ERR_OUT_OF_RANGE` before any syscall. Errors from
 * the syscall carry Node-style `code`, `errno` and `syscall` properties.
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
}

export function loadFdOps(): FdOps;
