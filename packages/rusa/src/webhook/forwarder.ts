import { createServer, type IncomingMessage, type ServerResponse } from "node:http";

/**
 * A target group is either a single URL (always attempted) or an array of URLs
 * tried in order where the first successful delivery short-circuits the rest.
 * This lets you express "try dev, fall back to staging" as `["devUrl", "stagingUrl"]`
 * while a standalone `"prodUrl"` always receives the event.
 *
 * Groups are resolved in parallel; entries within a fallback group are sequential.
 */
export type TargetGroup = string | string[];

export interface WebhookForwarderOptions {
  port: number;
  host?: string;
  targets: TargetGroup[];
}

export interface WebhookForwarderHandle {
  port: number;
  close(): Promise<void>;
}

async function readRawBody(req: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}

function copyForwardHeaders(req: IncomingMessage): Headers {
  const headers = new Headers();
  for (const [key, value] of Object.entries(req.headers)) {
    if (value === undefined) continue;
    if (key === "host" || key === "connection" || key === "content-length") continue;
    if (Array.isArray(value)) {
      for (const item of value) headers.append(key, item);
    } else {
      headers.set(key, value);
    }
  }
  return headers;
}

function writeJson(
  res: ServerResponse,
  statusCode: number,
  payload: Record<string, unknown>
): void {
  const body = JSON.stringify(payload);
  res.writeHead(statusCode, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(body),
  });
  res.end(body);
}

export async function startWebhookForwarder(
  options: WebhookForwarderOptions
): Promise<WebhookForwarderHandle> {
  const { port, host = "0.0.0.0", targets } = options;
  if (targets.length === 0) {
    throw new Error("Webhook forwarder requires at least one downstream target.");
  }

  const server = createServer(async (req, res) => {
    if (req.method !== "POST" || req.url !== "/webhook") {
      writeJson(res, 404, { error: "Not found" });
      return;
    }

    try {
      const body = await readRawBody(req);
      const requestBody = new Uint8Array(body);
      const headers = copyForwardHeaders(req);

      const results = await Promise.allSettled(
        targets.map(async (group) => {
          const chain = Array.isArray(group) ? group : [group];
          for (const target of chain) {
            try {
              const response = await fetch(target, {
                method: "POST",
                headers,
                body: requestBody,
              });
              if (!response.ok) {
                throw new Error(`Forward target ${target} responded ${response.status}`);
              }
              return target;
            } catch (err) {
              if (target === chain[chain.length - 1]) throw err;
              // Try next target in fallback chain
            }
          }
          throw new Error("No targets in group");
        })
      );

      const forwarded = results.filter((result) => result.status === "fulfilled").length;
      const failed = results.length - forwarded;

      if (forwarded === 0) {
        writeJson(res, 502, {
          ok: false,
          forwarded,
          failed,
          total: results.length,
        });
        return;
      }

      writeJson(res, 202, {
        ok: true,
        forwarded,
        failed,
        total: results.length,
      });
    } catch (error) {
      writeJson(res, 500, {
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  });

  await new Promise<void>((resolve, reject) => {
    server.on("error", reject);
    server.listen(port, host, () => {
      resolve();
    });
  });

  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("Failed to determine webhook forwarder port.");
  }
  const targetDisplay = targets.map((g) => (Array.isArray(g) ? g.join(" → ") : g)).join(", ");
  console.log(
    `[webhook-forwarder] Listening on ${host}:${address.port} and forwarding to ${targetDisplay}`
  );

  return {
    port: address.port,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.closeAllConnections();
        server.close((error) => {
          if (error) reject(error);
          else resolve();
        });
      }),
  };
}
