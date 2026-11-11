// Entry point of one read worker (#1289), built beside the CLI as
// `db-read-worker.js`; `DbReadPool` starts it with the database path.
import { parentPort, workerData } from "node:worker_threads";
import { READ_OPERATIONS } from "./read-operations.js";
import { openReadConnection, serveReads } from "./read-worker-runtime.js";

if (!parentPort) throw new Error("db-read-worker must run as a worker thread");
const { dbPath } = workerData as { dbPath: string };
serveReads(parentPort, openReadConnection(dbPath), READ_OPERATIONS);
