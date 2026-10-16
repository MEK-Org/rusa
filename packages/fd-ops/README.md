# @rusa/fd-ops

A small Node-API addon, written in C, that exposes `openat`, `fstatat`, `linkat`
and `unlinkat`. Node's `fs` has no descriptor-relative calls, so without it,
staying beneath a held directory needs `/proc/self/fd/<fd>/<name>`, which only
Linux has. Each call takes one directory descriptor and one path component and
never follows a symlink; see `index.d.ts`.

## Build and toolchain cost

`pnpm install` compiles the addon from source with node-gyp, which pnpm bundles.
There are no npm dependencies and no prebuilt binaries, so every host that
installs the workspace needs a C toolchain:

- **Linux:** `python3`, `make` and a C compiler (`build-essential` on Debian and
  Ubuntu). The Docker image already installs these for `better-sqlite3`.
- **macOS:** the Xcode Command Line Tools (`xcode-select --install`). A
  disposable macOS build/load has been observed, but each source revision still
  needs its own macOS runtime validation before it can ship.

The first build also downloads Node's headers for the running Node version
into node-gyp's cache. Every `pnpm install` recompiles the addon, so there is no
separate `build` script; to rebuild without a full install, run
`pnpm --filter @rusa/fd-ops rebuild`.

A failed build does not fail `pnpm install`. Instead `loadFdOps()` throws
`ERR_FD_OPS_UNAVAILABLE`, and callers refuse the file operation. There is no
pathname fallback. This package's own tests fail when the addon is missing, so
CI catches a broken build, and the Docker image build fails unless the addon
loads.

## Consumer boundary

This package has no production consumer yet. Slice 1 of #1013 will port
`packages/rusa/src/mcp/workdir-path.ts`; it must not be described as already
using this addon.

The current `workdir-path.ts` boundaries show where the later port must make
its decisions:

- `openat` replaces the `/proc/self/fd/<fd>/<name>` opens in
  `openParentInWorkdir`, `openInWorkdir`, and the exclusive destination open in
  `streamNewFileInWorkdir`. It always adds `O_NONBLOCK`, so a planted FIFO
  cannot stall the JS thread even if a caller forgets that flag.
- `fstatat` is retained by the accepted #1013 helper contract for a no-follow
  name check and name-to-held-descriptor `dev`/`ino` revalidation. Its `mode`
  may classify the named entry, but it must not replace `fstat` on the opened
  descriptor when deciding whether the bytes are a regular file.
- `unlinkat` is the descriptor-relative counterpart for the current
  `unlinkIfSame` cleanup. `linkat` has no current call site: the eventual
  Slice-1 design may use it only if it adds a verified temp-to-final,
  no-overwrite publish step. That design is not part of this helper PR.

The primitive calls are synchronous by design: each is one bounded
descriptor-relative syscall that either returns a descriptor or fails. The
later consumer keeps file reads, writes, and network transfers asynchronous;
adding a speculative Node-API async wrapper here would add callback and
descriptor-lifetime machinery without making the follow-up transfer I/O safer.
`O_NONBLOCK` makes an adversarial FIFO fail the later regular-file check rather
than stalling the JS thread during that single open.

If `loadFdOps()` fails, Slice 1 must keep refusal fail-closed and surface
`ERR_FD_OPS_UNAVAILABLE` through its operator-visible file-capability/status
path. The integration test for that signal, and the real moved-parent,
replacement, and symlink-swap containment cases, belong at the later
`workdir-path.ts` seam. The tests here establish only the native primitive
contract; they are not a substitute for that end-to-end proof.
