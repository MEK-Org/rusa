import { createRequire } from "node:module";

const require = createRequire(import.meta.url);

let addon;
let loadError;
try {
  addon = require("./build/Release/fd_ops.node");
} catch (err) {
  loadError = err;
}

/**
 * The descriptor-relative primitives, or a thrown `ERR_FD_OPS_UNAVAILABLE`
 * when the native addon did not build or load. Callers refuse the file
 * operation on that error; there is no pathname fallback.
 */
export function loadFdOps() {
  if (addon) return addon;
  throw Object.assign(
    new Error(
      `descriptor-relative file I/O is unavailable (native @rusa/fd-ops did not load: ${loadError?.message ?? "unknown error"}); refusing the operation`
    ),
    { code: "ERR_FD_OPS_UNAVAILABLE", cause: loadError }
  );
}
