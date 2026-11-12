// The writer tests' worker (#1289): the production write runtime with the test
// operations. Its port dies after an `exitAfterCommit` write has committed,
// before the outcome is posted, the one point a real worker can be lost
// between commit and reply.
import { parentPort, workerData } from "node:worker_threads";
import { BUILD_ID } from "../build-id.js";
import { ObligationRepository } from "../repositories/obligation-repository.js";
import type { WorkerRequest } from "../worker-pool.js";
import { openWriteConnection, serveWrites, type WritePort } from "../write-worker-runtime.js";
import { TEST_WRITE_OPERATIONS } from "./test-write-operations.js";

if (!parentPort) throw new Error("test-write-worker must run as a worker thread");
const parent = parentPort;
const { dbPath } = workerData as { dbPath: string };
const db = openWriteConnection(dbPath);

let current: string | null = null;
const port: WritePort = {
  on: (event, listener) =>
    parent.on(event, (request: WorkerRequest) => {
      current = request.op;
      listener(request);
    }),
  postMessage: (message) => {
    if (message.type === "result" && current === "exitAfterCommit") process.exit(9);
    parent.postMessage(message);
  },
};
serveWrites(
  port,
  db,
  { obligations: new ObligationRepository(db) },
  TEST_WRITE_OPERATIONS,
  BUILD_ID
);
