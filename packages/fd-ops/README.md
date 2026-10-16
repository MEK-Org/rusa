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
- **macOS:** the Xcode Command Line Tools (`xcode-select --install`). This has
  not yet been verified on a Mac.

The first build also downloads Node's headers for the running Node version
into node-gyp's cache. Rebuild after changing Node major versions:
`pnpm --filter @rusa/fd-ops rebuild`.

A failed build does not fail `pnpm install`. Instead `loadFdOps()` throws
`ERR_FD_OPS_UNAVAILABLE`, and callers refuse the file operation. There is no
pathname fallback. This package's own tests fail when the addon is missing, so
CI catches a broken build.
