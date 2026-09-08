import { execFileSync, spawn } from "node:child_process";
import { createServer, type Server } from "node:http";
import { basename, dirname, join } from "node:path";
import { createLogger } from "../observability/logger.js";

const log = createLogger({ context: { component: "e2e-git-remote" } });

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
  // This test-only server must never be reachable off-host.
  const bindHost = "127.0.0.1";
  const projectRoot = dirname(opts.repoDir);
  const repoName = basename(opts.repoDir);
  const routePrefix = `/${repoName}`;

  const server = createServer((req, res) => {
    const url = req.url ? new URL(req.url, `http://${bindHost}`) : null;
    if (!url || (url.pathname !== routePrefix && !url.pathname.startsWith(`${routePrefix}/`))) {
      res.writeHead(404, { "content-type": "text/plain" });
      res.end("Not Found");
      return;
    }

    const runBackend = (body?: Buffer) => {
      const contentLength =
        body !== undefined ? String(body.length) : req.headers["content-length"] || "";
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
          CONTENT_LENGTH: contentLength,
        },
      });

      if (body !== undefined) {
        child.stdin.end(body);
      } else {
        req.pipe(child.stdin);
      }

      let headersParsed = false;
      let buffer = Buffer.alloc(0);

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

      child.stderr.resume();
      child.stdout.on("end", () => res.end());
      child.on("error", (err) => {
        log.error("git_http_backend_process_failed", { err });
        if (!res.headersSent) res.writeHead(500, { "content-type": "text/plain" });
        res.end("Internal Server Error");
      });
    };

    if (req.method === "POST" && req.headers["content-length"] === undefined) {
      const chunks: Buffer[] = [];
      req.on("data", (chunk: Buffer) => chunks.push(chunk));
      req.on("end", () => runBackend(Buffer.concat(chunks)));
      req.on("error", (err) => {
        log.error("git_http_request_failed", { err });
        if (!res.headersSent) res.writeHead(500, { "content-type": "text/plain" });
        res.end("Internal Server Error");
      });
      return;
    }

    runBackend();
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

  return {
    url: `http://${bindHost}:${port}${routePrefix}`,
    port,
    close: () => closeServer(server),
  };
}

function closeServer(server: Server): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    server.close((err) => (err ? reject(err) : resolve()));
  });
}
