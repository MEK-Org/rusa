// The writer tests' worker serving production mesh write operations (#1289 C2).
import { parentPort, workerData } from "node:worker_threads";
import { BUILD_ID } from "../build-id.js";
import { MESH_WRITE_OPERATIONS } from "../mesh-write-operations.js";
import { Repositories } from "../repositories/index.js";
import { openWriteConnection, serveWrites } from "../write-worker-runtime.js";

if (!parentPort) throw new Error("test-mesh-write-worker must run as a worker thread");
const { dbPath } = workerData as { dbPath: string };
const db = openWriteConnection(dbPath);

const repos = new Repositories(db).meshWriteRepos();

serveWrites(parentPort, db, repos, MESH_WRITE_OPERATIONS, BUILD_ID);
