import { execSync, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { join } from "node:path";
import { generateRepoKey, getBareClonePath, hardenBareRepoForGitBridge } from "./worktree.js";

const DEFAULT_MAX_POST_BODY_BYTES = 256 * 1024 * 1024;
const DEFAULT_REQUEST_TIMEOUT_MS = 5 * 60 * 1000;

export interface GitHttpServerOptions {
  bindHost?: string;
  maxPostBodyBytes?: number;
  requestTimeoutMs?: number;
}

/**
 * Starts a lightweight Git smart HTTP server serving bare repositories
 * from <mcHome>/workspaces/<repoKey>/repo.git using git http-backend.
 * Binds to loopback by default (127.0.0.1).
 */
export function startGitHttpServer(
  mcHome: string,
  port: number,
  opts: GitHttpServerOptions = {}
): Server {
  const execPath = execSync("git --exec-path", { encoding: "utf8" }).trim();
  const backendPath = join(execPath, "git-http-backend");
  const bindHost = opts.bindHost ?? "127.0.0.1";
  const maxPostBodyBytes = opts.maxPostBodyBytes ?? DEFAULT_MAX_POST_BODY_BYTES;
  const requestTimeoutMs = opts.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;

  const server = createServer((req, res) => {
    req.setTimeout(requestTimeoutMs, () => {
      if (!res.headersSent) {
        res.writeHead(408, { "content-type": "text/plain" });
      }
      res.end("Request Timeout");
      req.destroy();
    });

    const url = req.url ? new URL(req.url, `http://127.0.0.1:${port}`) : null;
    if (!url) {
      res.writeHead(400, { "content-type": "text/plain" });
      res.end("Bad Request");
      return;
    }

    const pathname = url.pathname;
    // Route format: /owner/repo (with optional .git suffix) and subpath
    const match = pathname.match(/^\/([^/]+)\/([^/]+?)(?:\.git)?(\/.*)?$/);
    if (!match) {
      res.writeHead(404, { "content-type": "text/plain" });
      res.end("Not Found");
      return;
    }

    const owner = match[1];
    const repo = match[2];
    const subPath = match[3] || "";
    const repoId = `${owner}/${repo}`;
    const repoKey = generateRepoKey(repoId);
    const gitDir = getBareClonePath(mcHome, repoKey);

    if (!existsSync(gitDir)) {
      res.writeHead(404, { "content-type": "text/plain" });
      res.end(`Repository not found: ${repoId}`);
      return;
    }

    try {
      hardenBareRepoForGitBridge(gitDir);
    } catch (err) {
      console.error(`Failed to harden git bridge repo ${gitDir}:`, err);
      res.writeHead(500, { "content-type": "text/plain" });
      res.end("Internal Server Error");
      return;
    }

    const projectRoot = join(mcHome, "workspaces", repoKey);
    const pathInfo = `/repo.git${subPath}`;

    const contentLengthHeader = req.headers["content-length"];
    const contentLength =
      typeof contentLengthHeader === "string"
        ? Number.parseInt(contentLengthHeader, 10)
        : undefined;
    if (
      req.method === "POST" &&
      contentLength !== undefined &&
      !Number.isNaN(contentLength) &&
      contentLength > maxPostBodyBytes
    ) {
      res.writeHead(413, { "content-type": "text/plain" });
      res.end("Payload Too Large");
      req.destroy();
      return;
    }

    let headersParsed = false;
    let buffer = Buffer.alloc(0);

    const startBackend = (requestBody?: Buffer) => {
      const contentLength =
        requestBody !== undefined
          ? String(requestBody.length)
          : req.headers["content-length"] || "";
      const child = spawn(backendPath, [], {
        env: {
          ...process.env,
          GIT_PROJECT_ROOT: projectRoot,
          GIT_HTTP_EXPORT_ALL: "1",
          PATH_INFO: pathInfo,
          QUERY_STRING: url.search ? url.search.substring(1) : "",
          REQUEST_METHOD: req.method || "GET",
          CONTENT_TYPE: req.headers["content-type"] || "",
          CONTENT_LENGTH: contentLength,
        },
      });

      if (requestBody !== undefined) {
        child.stdin.end(requestBody);
      } else {
        req.pipe(child.stdin);
      }

      child.stdout.on("data", (chunk) => {
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

        if (headerEndIndex !== -1) {
          headersParsed = true;
          const headersStr = buffer.subarray(0, headerEndIndex).toString("utf8");
          const bodyStart = buffer.subarray(headerEndIndex + delimiterLength);

          const headers: Record<string, string> = {};
          let status = 200;

          for (const line of headersStr.split(/\r?\n/)) {
            const colon = line.indexOf(":");
            if (colon !== -1) {
              const key = line.substring(0, colon).trim().toLowerCase();
              const val = line.substring(colon + 1).trim();
              if (key === "status") {
                const code = parseInt(val.split(" ")[0], 10);
                if (!Number.isNaN(code)) status = code;
              } else {
                headers[key] = val;
              }
            }
          }

          res.writeHead(status, headers);
          if (bodyStart.length > 0) {
            res.write(bodyStart);
          }
        }
      });

      child.stderr.resume();

      child.stdout.on("end", () => {
        res.end();
      });

      child.on("error", (err) => {
        console.error("git http-backend process error:", err);
        if (!res.headersSent) {
          res.writeHead(500, { "content-type": "text/plain" });
        }
        res.end("Internal Server Error");
      });
    };

    if (req.method === "POST" && req.headers["content-length"] === undefined) {
      const chunks: Buffer[] = [];
      let bufferedBytes = 0;
      let tooLarge = false;
      req.on("data", (chunk) => {
        if (tooLarge) return;
        bufferedBytes += chunk.length;
        if (bufferedBytes > maxPostBodyBytes) {
          tooLarge = true;
          res.writeHead(413, { "content-type": "text/plain" });
          res.end("Payload Too Large");
          req.destroy();
          return;
        }
        chunks.push(Buffer.from(chunk));
      });
      req.on("end", () => {
        if (tooLarge) return;
        startBackend(Buffer.concat(chunks));
      });
      req.on("error", (err) => {
        if (tooLarge) return;
        console.error("git http request stream error:", err);
        if (!res.headersSent) {
          res.writeHead(500, { "content-type": "text/plain" });
        }
        res.end("Internal Server Error");
      });
      return;
    }

    startBackend();
  });

  server.listen(port, bindHost);
  return server;
}
