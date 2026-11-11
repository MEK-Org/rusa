// Entry point of one read worker (#1289), built beside the CLI as
// `db-read-worker.js`; `DbReadPool` starts it with the database path.
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { parentPort, workerData } from "node:worker_threads";
import { readBuildSentinel } from "../update/build-sentinel.js";
import { READ_OPERATIONS } from "./read-operations.js";
import { openReadConnection, serveReads } from "./read-worker-runtime.js";

if (!parentPort) throw new Error("db-read-worker must run as a worker thread");
const { dbPath } = workerData as { dbPath: string };
// Read only now, after every module above has loaded: if `dist` is swapped in
// between, the sentinel is newer than the code, so the pool refuses a worker it
// could have kept rather than keep one it should refuse.
const build = readBuildSentinel(dirname(fileURLToPath(import.meta.url)));
serveReads(parentPort, openReadConnection(dbPath), READ_OPERATIONS, build);
