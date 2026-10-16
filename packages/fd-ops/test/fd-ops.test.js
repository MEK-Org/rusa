import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  closeSync,
  constants,
  copyFileSync,
  fstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readdirSync,
  readFileSync,
  readSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
  writeSync,
} from "node:fs";
import { constants as osConstants, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, before, describe, test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

import { loadFdOps } from "../index.js";

const DIR_FLAGS = constants.O_RDONLY | constants.O_DIRECTORY;

let base;
let fd;
const open = [];

before(() => {
  fd = loadFdOps();
  base = mkdtempSync(join(tmpdir(), "fd-ops-"));
});

after(() => {
  for (const handle of open) closeSync(handle);
  rmSync(base, { recursive: true, force: true });
});

function scratch(name) {
  const dir = join(base, name);
  mkdirSync(dir);
  return dir;
}

function openDir(path) {
  const handle = openSync(path, DIR_FLAGS);
  open.push(handle);
  return handle;
}

function track(handle) {
  open.push(handle);
  return handle;
}

function readAll(handle) {
  const chunks = [];
  const chunk = Buffer.alloc(4096);
  for (;;) {
    const n = readSync(handle, chunk, 0, chunk.length, null);
    if (n === 0) return Buffer.concat(chunks).toString();
    chunks.push(Buffer.from(chunk.subarray(0, n)));
  }
}

function errorCode(fn) {
  try {
    fn();
  } catch (err) {
    return err.code;
  }
  return "no error";
}

/** Walk `names` from `rootFd` one directory at a time, the way a confined caller does. */
function walk(rootFd, names) {
  let dir = rootFd;
  for (const name of names) {
    const next = fd.openat(dir, name, DIR_FLAGS);
    if (dir !== rootFd) closeSync(dir);
    dir = next;
  }
  return track(dir);
}

describe("@rusa/fd-ops", () => {
  test("exports the four primitives and O_NOFOLLOW_ANY", () => {
    for (const name of ["openat", "fstatat", "linkat", "unlinkat"]) {
      assert.equal(typeof fd[name], "function", name);
    }
    assert.equal(typeof fd.O_NOFOLLOW_ANY, "number");
    if (process.platform !== "darwin") assert.equal(fd.O_NOFOLLOW_ANY, 0);
  });

  test("openat reads a file relative to a held directory", () => {
    const dir = scratch("read");
    writeFileSync(join(dir, "a.txt"), "hello");
    const handle = track(fd.openat(openDir(dir), "a.txt", constants.O_RDONLY));
    assert.equal(readAll(handle), "hello");
  });

  test("refuses anything but a single downward path component, before any syscall", () => {
    const dir = openDir(scratch("names"));
    for (const name of ["", ".", "..", "a/b", "/etc", "a\0b"]) {
      assert.equal(
        errorCode(() => fd.openat(dir, name, DIR_FLAGS)),
        "ERR_INVALID_COMPONENT",
        name
      );
      assert.equal(
        errorCode(() => fd.fstatat(dir, name)),
        "ERR_INVALID_COMPONENT",
        name
      );
      assert.equal(
        errorCode(() => fd.unlinkat(dir, name)),
        "ERR_INVALID_COMPONENT",
        name
      );
      assert.equal(
        errorCode(() => fd.linkat(dir, "x", dir, name)),
        "ERR_INVALID_COMPONENT",
        name
      );
      assert.equal(
        errorCode(() => fd.linkat(dir, name, dir, "x")),
        "ERR_INVALID_COMPONENT",
        name
      );
    }
  });

  test("rejects non-integer descriptors and flags", () => {
    assert.equal(
      errorCode(() => fd.openat("3", "a", DIR_FLAGS)),
      "ERR_INVALID_ARG_TYPE"
    );
    assert.equal(
      errorCode(() => fd.openat(3, "a", "0")),
      "ERR_INVALID_ARG_TYPE"
    );
    assert.equal(
      errorCode(() => fd.openat(3, 7, 0)),
      "ERR_INVALID_ARG_TYPE"
    );
  });

  test("never follows a final symlink, whether opened as a file or a directory", () => {
    const dir = scratch("final-link");
    const outside = scratch("final-link-outside");
    writeFileSync(join(outside, "secret"), "outside");
    symlinkSync(join(outside, "secret"), join(dir, "file-link"));
    symlinkSync(outside, join(dir, "dir-link"));
    const held = openDir(dir);
    assert.equal(
      errorCode(() => fd.openat(held, "file-link", constants.O_RDONLY)),
      "ELOOP"
    );
    // Linux reports ENOTDIR for O_DIRECTORY|O_NOFOLLOW on a symlink; macOS ELOOP.
    assert.match(
      errorCode(() => fd.openat(held, "dir-link", DIR_FLAGS)),
      /^(ELOOP|ENOTDIR)$/
    );
  });

  test("a per-component walk refuses a symlinked intermediate directory", () => {
    const root = scratch("walk");
    const outside = scratch("walk-outside");
    mkdirSync(join(root, "a"));
    symlinkSync(outside, join(root, "a", "b"));
    const rootFd = openDir(root);
    assert.match(
      errorCode(() => walk(rootFd, ["a", "b"])),
      /^(ELOOP|ENOTDIR)$/
    );
    assert.ok(walk(rootFd, ["a"]) > 0);
  });

  test("creation through a held directory follows the directory, not its old pathname", () => {
    const root = scratch("moved");
    mkdirSync(join(root, "parent"));
    const held = openDir(join(root, "parent"));
    renameSync(join(root, "parent"), join(root, "moved-away"));
    mkdirSync(join(root, "parent"));
    const out = track(
      fd.openat(held, "new.txt", constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o600)
    );
    writeSync(out, "data");
    assert.equal(readFileSync(join(root, "moved-away", "new.txt"), "utf8"), "data");
    assert.deepEqual(readdirSync(join(root, "parent")), []);
  });

  test("fstatat identity matches fstat of the opened descriptor and exposes a replaced directory", () => {
    const root = scratch("identity");
    mkdirSync(join(root, "parent"));
    const rootFd = openDir(root);
    const held = walk(rootFd, ["parent"]);
    const opened = fstatSync(held, { bigint: true });
    const listed = fd.fstatat(rootFd, "parent");
    assert.equal(typeof listed.dev, "bigint");
    assert.equal(listed.dev, opened.dev);
    assert.equal(listed.ino, opened.ino);
    assert.equal(listed.mode & constants.S_IFMT, constants.S_IFDIR);

    renameSync(join(root, "parent"), join(root, "old"));
    mkdirSync(join(root, "parent"));
    const replaced = fd.fstatat(rootFd, "parent");
    assert.notEqual(replaced.ino, opened.ino);
  });

  test("fstatat describes a symlink itself", () => {
    const dir = scratch("stat-link");
    symlinkSync("/", join(dir, "link"));
    const info = fd.fstatat(openDir(dir), "link");
    assert.equal(info.mode & constants.S_IFMT, constants.S_IFLNK);
  });

  test("linkat publishes a verified temp file and unlinkat removes the temp name", () => {
    const dir = scratch("publish");
    const held = openDir(dir);
    const tmp = track(
      fd.openat(held, ".tmp-1", constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o600)
    );
    writeSync(tmp, "payload");
    fd.linkat(held, ".tmp-1", held, "final.txt");
    fd.unlinkat(held, ".tmp-1");
    assert.deepEqual(readdirSync(dir), ["final.txt"]);
    const digest = createHash("sha256")
      .update(readFileSync(join(dir, "final.txt")))
      .digest("hex");
    assert.equal(digest, createHash("sha256").update("payload").digest("hex"));
  });

  test("linkat refuses to replace an existing file or a dangling symlink", () => {
    const dir = scratch("no-replace");
    const outside = scratch("no-replace-outside");
    writeFileSync(join(dir, ".tmp"), "mine");
    writeFileSync(join(dir, "taken"), "competitor");
    symlinkSync(join(outside, "nowhere"), join(dir, "dangling"));
    const held = openDir(dir);
    assert.equal(
      errorCode(() => fd.linkat(held, ".tmp", held, "taken")),
      "EEXIST"
    );
    assert.equal(
      errorCode(() => fd.linkat(held, ".tmp", held, "dangling")),
      "EEXIST"
    );
    assert.equal(readFileSync(join(dir, "taken"), "utf8"), "competitor");
    assert.deepEqual(readdirSync(outside), []);
  });

  test("unlinkat removes a symlink, never its target", () => {
    const dir = scratch("unlink-link");
    const outside = scratch("unlink-outside");
    writeFileSync(join(outside, "keep"), "kept");
    symlinkSync(join(outside, "keep"), join(dir, "link"));
    fd.unlinkat(openDir(dir), "link");
    assert.deepEqual(readdirSync(dir), []);
    assert.equal(readFileSync(join(outside, "keep"), "utf8"), "kept");
  });

  test("a FIFO opens non-blocking and reports as non-regular", () => {
    const dir = scratch("fifo");
    execFileSync("mkfifo", [join(dir, "pipe")]);
    const handle = track(
      fd.openat(openDir(dir), "pipe", constants.O_RDONLY | constants.O_NONBLOCK)
    );
    assert.equal(fstatSync(handle).isFile(), false);
  });

  test("errors carry Node-style code, errno and syscall", () => {
    const held = openDir(scratch("errors"));
    let error;
    try {
      fd.openat(held, "missing", constants.O_RDONLY);
    } catch (err) {
      error = err;
    }
    assert.ok(error instanceof Error);
    assert.equal(error.code, "ENOENT");
    assert.equal(error.syscall, "openat");
    assert.equal(error.errno, -osConstants.errno.ENOENT);
    assert.match(error.message, /^ENOENT: .*, openat$/);
  });

  test("descriptors are close-on-exec", { skip: process.platform !== "linux" }, () => {
    const dir = scratch("cloexec");
    writeFileSync(join(dir, "f"), "x");
    const handle = track(fd.openat(openDir(dir), "f", constants.O_RDONLY));
    const flags = readFileSync(`/proc/self/fdinfo/${handle}`, "utf8").match(/flags:\s+(\d+)/);
    assert.ok(flags);
    // O_CLOEXEC is 02000000 (octal) on Linux.
    assert.ok(Number.parseInt(flags[1], 8) & 0o2000000);
  });

  for (const [label, addon] of [
    ["absent", undefined],
    ["unloadable", "not a shared object"],
  ]) {
    test(`loadFdOps fails closed when the addon is ${label}`, async () => {
      const pkg = dirname(dirname(fileURLToPath(import.meta.url)));
      const copy = mkdtempSync(join(base, `${label}-addon-`));
      copyFileSync(join(pkg, "index.js"), join(copy, "index.js"));
      writeFileSync(join(copy, "package.json"), '{"type":"module"}');
      if (addon !== undefined) {
        mkdirSync(join(copy, "build", "Release"), { recursive: true });
        writeFileSync(join(copy, "build", "Release", "fd_ops.node"), addon);
      }
      const { loadFdOps: load } = await import(pathToFileURL(join(copy, "index.js")).href);
      let error;
      try {
        load();
      } catch (err) {
        error = err;
      }
      assert.equal(error?.code, "ERR_FD_OPS_UNAVAILABLE");
      assert.match(error.message, /refusing the operation/);
      assert.ok(error.cause instanceof Error);
    });
  }
});
