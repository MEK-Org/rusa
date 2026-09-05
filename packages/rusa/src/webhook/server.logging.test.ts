import { createHmac } from "node:crypto";
import { EventEmitter, once } from "node:events";
import type { IncomingMessage, ServerResponse } from "node:http";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createLogger, type Logger } from "../observability/logger.js";
import { createWebhookRequestHandler } from "./server.js";

/**
 * The webhook is the request path where the two output streams used to be
 * confused: a delivery failure printed prose to the service's stdout and was
 * unfindable afterwards. It now writes one record, keyed by GitHub's delivery
 * id, and prints nothing.
 */

// Synthetic values only; nothing here is a real credential.
const secret = "fixture-webhook-secret-1234";

class MockIncomingMessage extends EventEmitter {
  constructor(
    readonly method: string,
    readonly url: string,
    readonly headers: Record<string, string | undefined>
  ) {
    super();
  }
}

class MockServerResponse extends EventEmitter {
  statusCode = 200;
  body = "";

  writeHead(statusCode: number): this {
    this.statusCode = statusCode;
    return this;
  }

  end(body?: string): this {
    if (body) this.body += body;
    this.emit("finish");
    return this;
  }
}

function recordingLogger(): { logger: Logger; records: () => Record<string, unknown>[] } {
  const lines: string[] = [];
  const logger = createLogger({
    format: "json",
    level: "debug",
    secrets: [secret],
    destination: {
      write: (chunk: string) => {
        lines.push(chunk);
      },
    },
  });
  const records = () =>
    lines
      .join("")
      .split("\n")
      .filter((line) => line.length > 0)
      .map((line) => JSON.parse(line) as Record<string, unknown>);
  return { logger, records };
}

function sign(body: string): string {
  return `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`;
}

async function deliver(opts: {
  logger?: Logger;
  event?: string;
  deliveryId?: string;
  signature?: string;
  onEvent?: () => void | Promise<void>;
}): Promise<{ statusCode: number }> {
  const body = JSON.stringify({ action: "created", repository: { full_name: "MEK-Org/rusa" } });
  const handler = createWebhookRequestHandler({
    port: 0,
    secret,
    logger: opts.logger,
    onEvent: async () => {
      await opts.onEvent?.();
    },
  });
  const req = new MockIncomingMessage("POST", "/webhook", {
    "x-github-event": opts.event ?? "issue_comment",
    "x-github-delivery": opts.deliveryId ?? "delivery-9",
    "x-hub-signature-256": opts.signature ?? sign(body),
  });
  const res = new MockServerResponse();
  const done = once(res, "finish");
  void handler(req as unknown as IncomingMessage, res as unknown as ServerResponse);
  req.emit("data", Buffer.from(body));
  req.emit("end");
  await done;
  return { statusCode: res.statusCode };
}

function spyOnConsole() {
  return (["log", "info", "warn", "error", "debug"] as const).map((method) =>
    vi.spyOn(console, method).mockImplementation(() => {})
  );
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("webhook request diagnostics", () => {
  it("records a failed delivery against its delivery id, with the error's chain", async () => {
    const { logger, records } = recordingLogger();

    const res = await deliver({
      logger,
      onEvent: () => {
        throw new Error("dispatch failed", { cause: new Error("actor queue closed") });
      },
    });

    expect(res.statusCode).toBe(500);
    expect(records().at(-1)).toMatchObject({
      level: "error",
      component: "webhook",
      msg: "webhook_event_failed",
      deliveryId: "delivery-9",
      event: "issue_comment",
      err: { message: "dispatch failed", cause: { message: "actor queue closed" } },
    });
  });

  it("prints nothing to the console — the service's stdout carries records, not prose", async () => {
    const spies = spyOnConsole();
    const { logger } = recordingLogger();

    await deliver({ logger, event: "ping" });
    await deliver({ logger, signature: "sha256=deadbeef" });
    await deliver({
      logger,
      onEvent: () => {
        throw new Error("dispatch failed");
      },
    });

    for (const spy of spies) expect(spy).not.toHaveBeenCalled();
  });

  it("records a rejected signature without echoing the secret or the signature", async () => {
    const { logger, records } = recordingLogger();

    const res = await deliver({ logger, signature: `sha256=${"0".repeat(64)}` });

    expect(res.statusCode).toBe(401);
    expect(records().at(-1)).toMatchObject({
      level: "warn",
      msg: "webhook_signature_rejected",
      signaturePresent: true,
    });
    const written = JSON.stringify(records());
    expect(written).not.toContain(secret);
    expect(written).not.toContain("0".repeat(64));
  });

  it("scrubs the webhook secret out of an error that carried it", async () => {
    const { logger, records } = recordingLogger();

    await deliver({
      logger,
      onEvent: () => {
        throw new Error(`forward to https://example.test/hook?secret=${secret} failed`);
      },
    });

    expect(JSON.stringify(records())).not.toContain(secret);
    expect(JSON.stringify(records().at(-1))).toContain("[redacted]");
  });

  it("marks the accepted delivery at debug, so a healthy request costs nothing at info", async () => {
    const { logger, records } = recordingLogger();

    const res = await deliver({ logger });

    expect(res.statusCode).toBe(200);
    expect(records()).toEqual([
      expect.objectContaining({
        level: "debug",
        msg: "webhook_event_received",
        deliveryId: "delivery-9",
        event: "issue_comment",
      }),
    ]);
  });

  it("serves a delivery unchanged when no logger is supplied", async () => {
    const spies = spyOnConsole();

    const ok = await deliver({});
    const failed = await deliver({
      onEvent: () => {
        throw new Error("dispatch failed");
      },
    });

    expect([ok.statusCode, failed.statusCode]).toEqual([200, 500]);
    for (const spy of spies) expect(spy).not.toHaveBeenCalled();
  });
});
