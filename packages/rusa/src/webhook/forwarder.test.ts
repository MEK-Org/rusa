import { createServer } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import { startWebhookForwarder } from "./forwarder.js";

interface Capture {
  body: string;
  signature: string | null;
}

async function startCaptureServer(captures: Capture[]): Promise<{
  port: number;
  close(): Promise<void>;
}> {
  const server = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    }
    captures.push({
      body: Buffer.concat(chunks).toString("utf-8"),
      signature:
        typeof req.headers["x-hub-signature-256"] === "string"
          ? req.headers["x-hub-signature-256"]
          : null,
    });
    res.writeHead(200);
    res.end("ok");
  });

  await new Promise<void>((resolve, reject) => {
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });

  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("Failed to determine capture server port");
  }

  return {
    port: address.port,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((error) => {
          if (error) reject(error);
          else resolve();
        });
      }),
  };
}

describe("webhook forwarder", () => {
  const cleanup: Array<() => Promise<void>> = [];

  afterEach(async () => {
    while (cleanup.length > 0) {
      const close = cleanup.pop();
      if (close) {
        await close();
      }
    }
  });

  it("fans out webhook payloads and headers to all targets", async () => {
    const capturesA: Capture[] = [];
    const capturesB: Capture[] = [];
    const serverA = await startCaptureServer(capturesA);
    const serverB = await startCaptureServer(capturesB);
    cleanup.push(serverA.close, serverB.close);

    const forwarder = await startWebhookForwarder({
      port: 0,
      targets: [
        `http://127.0.0.1:${serverA.port}/webhook`,
        `http://127.0.0.1:${serverB.port}/webhook`,
      ],
    });
    cleanup.push(forwarder.close);

    const response = await fetch(`http://127.0.0.1:${forwarder.port}/webhook`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-hub-signature-256": "sha256=test",
      },
      body: JSON.stringify({ hello: "world" }),
    });

    expect(response.status).toBe(202);
    expect(capturesA).toEqual([{ body: '{"hello":"world"}', signature: "sha256=test" }]);
    expect(capturesB).toEqual([{ body: '{"hello":"world"}', signature: "sha256=test" }]);
  });

  it("uses fallback target when primary is down", async () => {
    const capturesA: Capture[] = [];
    const capturesB: Capture[] = [];
    const serverA = await startCaptureServer(capturesA);
    const serverB = await startCaptureServer(capturesB);
    cleanup.push(serverA.close, serverB.close);

    // Port that nothing listens on — simulates dev instance being down
    const deadPort = serverA.port + 10000;

    const forwarder = await startWebhookForwarder({
      port: 0,
      targets: [
        // Standalone group: always receives
        `http://127.0.0.1:${serverA.port}/webhook`,
        // Fallback group: dead target falls back to serverB
        [`http://127.0.0.1:${deadPort}/webhook`, `http://127.0.0.1:${serverB.port}/webhook`],
      ],
    });
    cleanup.push(forwarder.close);

    const response = await fetch(`http://127.0.0.1:${forwarder.port}/webhook`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ test: "fallback" }),
    });

    expect(response.status).toBe(202);
    expect(capturesA).toHaveLength(1);
    expect(capturesB).toHaveLength(1);
    expect(capturesA[0].body).toBe('{"test":"fallback"}');
    expect(capturesB[0].body).toBe('{"test":"fallback"}');
  });

  it("skips fallback target when primary succeeds", async () => {
    const capturesPrimary: Capture[] = [];
    const capturesFallback: Capture[] = [];
    const serverPrimary = await startCaptureServer(capturesPrimary);
    const serverFallback = await startCaptureServer(capturesFallback);
    cleanup.push(serverPrimary.close, serverFallback.close);

    const forwarder = await startWebhookForwarder({
      port: 0,
      targets: [
        [
          `http://127.0.0.1:${serverPrimary.port}/webhook`,
          `http://127.0.0.1:${serverFallback.port}/webhook`,
        ],
      ],
    });
    cleanup.push(forwarder.close);

    const response = await fetch(`http://127.0.0.1:${forwarder.port}/webhook`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ test: "primary" }),
    });

    expect(response.status).toBe(202);
    expect(capturesPrimary).toHaveLength(1);
    expect(capturesFallback).toHaveLength(0);
  });

  it("returns 404 for non-webhook paths", async () => {
    const captures: Capture[] = [];
    const server = await startCaptureServer(captures);
    cleanup.push(server.close);

    const forwarder = await startWebhookForwarder({
      port: 0,
      targets: [`http://127.0.0.1:${server.port}/webhook`],
    });
    cleanup.push(forwarder.close);

    const response = await fetch(`http://127.0.0.1:${forwarder.port}/not-webhook`, {
      method: "POST",
      body: "ignored",
    });

    expect(response.status).toBe(404);
    expect(captures).toEqual([]);
  });

  it("closes promptly even with active keep-alive connections", async () => {
    const forwarder = await startWebhookForwarder({
      port: 0,
      targets: ["http://127.0.0.1:9999/webhook"],
    });

    const response = await fetch(`http://127.0.0.1:${forwarder.port}/webhook`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ hello: "world" }),
    });
    await response.text();

    const start = Date.now();
    await forwarder.close();
    const duration = Date.now() - start;

    expect(duration).toBeLessThan(1000);
  });
});
