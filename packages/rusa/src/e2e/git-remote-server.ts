import { type ChildProcess, execFileSync, spawn } from "node:child_process";
import { accessSync, constants } from "node:fs";
import { createServer, type Server } from "node:http";
import type { Socket } from "node:net";
import { basename, dirname, join } from "node:path";
import { createLogger } from "../observability/logger.js";

const log = createLogger({ context: { component: "e2e-git-remote" } });
const MAX_STDERR_BYTES = 8 * 1024;

/**
 * Serves the e2e harness's one disposable bare remote over loopback smart
 * HTTP, via `git http-backend` run as CGI, with receive-pack enabled — so a
 * sandboxed actor's ordinary `git clone` / `git push` works over the network
 * exactly as it would against GitHub, and no host path needs to be writable
 * inside bubblewrap. Scoped to exactly one repo: `GIT_PROJECT_ROOT` is the
 * remote's own parent directory, so there is nothing else on the filesystem
 * for the backend to serve even with `GIT_HTTP_EXPORT_ALL` set.
 *
 * See devlog-adjacent discussion on issue #236 for why this replaces the
 * writable bubblewrap bind added by #222: the sandbox already shares the
 * network namespace (`--share-net`), so a loopback endpoint reaches the
 * actor without granting it any filesystem write scope outside its worktree.
 */
export interface E2EGitRemoteServerOptions {
  /** Absolute path to the bare repo to serve (e.g. `<instance root>/remote/repo.git`). */
  repoDir: string;
  /** Loopback port to bind; 0 picks an ephemeral free port. */
  port?: number;
}

export interface E2EGitRemoteServer {
  /** The loopback URL the harness's `insteadOf` rewrite should target. */
  url: string;
  port: number;
  close: () => Promise<void>;
}

export async function startE2EGitRemoteServer(
  opts: E2EGitRemoteServerOptions
): Promise<E2EGitRemoteServer> {
  execFileSync("git", ["config", "http.receivepack", "true"], { cwd: opts.repoDir });

  const execPath = execFileSync("git", ["--exec-path"], { encoding: "utf8" }).trim();
  const backendPath = join(execPath, "git-http-backend");
  try {
    accessSync(backendPath, constants.X_OK);
  } catch (err) {
    throw new Error(`git-http-backend is unavailable at ${backendPath}`, { cause: err });
  }
  // This test-only server must never be reachable off-host.
  const bindHost = "127.0.0.1";
  const projectRoot = dirname(opts.repoDir);
  const repoName = basename(opts.repoDir);
  const routePrefix = `/${repoName}`;
  const backends = new Set<ChildProcess>();
  const sockets = new Set<Socket>();
  let closing = false;

  const server = createServer((req, res) => {
    const url = req.url ? new URL(req.url, `http://${bindHost}`) : null;
    if (!url || (url.pathname !== routePrefix && !url.pathname.startsWith(`${routePrefix}/`))) {
      res.writeHead(404, { "content-type": "text/plain" });
      res.end("Not Found");
      return;
    }

    const contentLength = req.headers["content-length"];
    // Native Git sends Content-Length for receive-pack requests. Refusing a
    // chunked body keeps this tiny test-only CGI bridge streaming and bounded,
    // rather than buffering an unbounded request just to manufacture CGI's
    // CONTENT_LENGTH environment variable.
    if (req.method === "POST" && typeof contentLength !== "string") {
      res.writeHead(411, { "content-type": "text/plain" });
      res.end("Content-Length required");
      return;
    }

    const runBackend = () => {
      const child = spawn(backendPath, [], {
        cwd: projectRoot,
        env: {
          ...process.env,
          GIT_PROJECT_ROOT: projectRoot,
          GIT_HTTP_EXPORT_ALL: "1",
          PATH_INFO: url.pathname,
          QUERY_STRING: url.search ? url.search.slice(1) : "",
          REQUEST_METHOD: req.method || "GET",
          CONTENT_TYPE: req.headers["content-type"] || "",
          CONTENT_LENGTH: contentLength || "",
        },
      });
      backends.add(child);

      req.pipe(child.stdin);

      let headersParsed = false;
      let buffer = Buffer.alloc(0);
      let clientClosed = false;
      let childError: Error | undefined;
      let stderr = "";

      const stopBackend = () => {
        if (!child.killed) child.kill();
      };
      const stopForClientClose = () => {
        clientClosed = true;
        stopBackend();
      };
      req.once("aborted", stopForClientClose);
      req.once("error", stopForClientClose);
      res.once("close", () => {
        if (!res.writableEnded) stopForClientClose();
      });
      child.stdin.on("error", (err) => {
        if ((err as NodeJS.ErrnoException).code !== "EPIPE" && !clientClosed) {
          log.error("git_http_backend_stdin_failed", { err });
        }
      });

      child.stdout.on("data", (chunk: Buffer) => {
        if (headersParsed) {
          res.write(chunk);
          return;
        }

        buffer = Buffer.concat([buffer, chunk]);
        let headerEndIndex = buffer.indexOf("\r\n\r\n");
        let delimiterLength = 4;
        if (headerEndIndex === -1) {
          headerEndIndex = buffer.indexOf("\n\n");
          delimiterLength = 2;
        }
        if (headerEndIndex === -1) return;

        headersParsed = true;
        const headersStr = buffer.subarray(0, headerEndIndex).toString("utf8");
        const bodyStart = buffer.subarray(headerEndIndex + delimiterLength);

        const headers: Record<string, string> = {};
        let status = 200;
        for (const line of headersStr.split(/\r?\n/)) {
          const colon = line.indexOf(":");
          if (colon === -1) continue;
          const key = line.slice(0, colon).trim().toLowerCase();
          const val = line.slice(colon + 1).trim();
          if (key === "status") {
            const code = Number.parseInt(val.split(" ")[0], 10);
            if (!Number.isNaN(code)) status = code;
          } else {
            headers[key] = val;
          }
        }

        res.writeHead(status, headers);
        if (bodyStart.length > 0) res.write(bodyStart);
      });

      child.stderr.setEncoding("utf8");
      child.stderr.on("data", (chunk: string) => {
        if (stderr.length < MAX_STDERR_BYTES)
          stderr += chunk.slice(0, MAX_STDERR_BYTES - stderr.length);
      });
      child.on("error", (err) => {
        childError = err;
      });
      child.on("close", (code, signal) => {
        backends.delete(child);
        if (closing || clientClosed || res.destroyed) return;

        if (!headersParsed) {
          log.error("git_http_backend_failed_before_headers", {
            err: childError,
            code,
            signal,
            stderr,
          });
          res.writeHead(500, { "content-type": "text/plain" });
          res.end("Internal Server Error");
          return;
        }

        if (code !== 0 || childError) {
          log.error("git_http_backend_failed", { err: childError, code, signal, stderr });
        }
        if (!res.writableEnded) res.end();
      });
    };

    runBackend();
  });
  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
  });

  try {
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(opts.port ?? 0, bindHost, () => {
        server.removeListener("error", reject);
        resolve();
      });
    });
  } catch (err) {
    // Startup failure: nothing was ever listening, but make sure the handle
    // (and any FDs it opened) is released rather than left dangling.
    await closeServer(server).catch(() => {});
    throw err;
  }

  const address = server.address();
  const port = typeof address === "object" && address ? address.port : (opts.port ?? 0);
  let closePromise: Promise<void> | undefined;

  return {
    url: `http://${bindHost}:${port}${routePrefix}`,
    port,
    close: () => {
      closing = true;
      if (!closePromise) closePromise = closeServer(server, backends, sockets);
      return closePromise;
    },
  };
}

function closeServer(
  server: Server,
  backends: Set<ChildProcess> = new Set(),
  sockets: Set<Socket> = new Set()
): Promise<void> {
  for (const child of backends) {
    if (!child.killed) child.kill();
  }
  for (const socket of sockets) socket.destroy();
  return new Promise<void>((resolve, reject) => {
    server.close((err) => (err ? reject(err) : resolve()));
  });
}
