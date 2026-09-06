import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  type CreateLoggerOptions,
  createLogger,
  DEFAULT_LOG_LEVEL,
  formatRecordLine,
  LOG_FORMAT_ENV_VAR,
  LOG_LEVEL_ENV_VAR,
  MIN_SCRUBBABLE_SECRET_LENGTH,
  nullLogger,
  REDACTED,
  redactValue,
  resolveLogFormat,
  resolveLogLevel,
  type SerializedError,
  serializeError,
} from "./logger.js";

/**
 * These assert the shape of the record, never rendered prose: an event name, the
 * fields that ride with it, and the level that carries it. A test that matched
 * the formatted line would break on a cosmetic change and would pass on a record
 * that lost a field.
 */

/** A logger writing to memory, plus the parsed records it produced. */
function recordingLogger(options: Omit<CreateLoggerOptions, "destination"> = {}) {
  const lines: string[] = [];
  const logger = createLogger({
    // Pinned: `auto` would render pretty lines under a TTY, and these tests are
    // about the record, not its presentation.
    format: "json",
    ...options,
    destination: {
      write: (chunk: string) => {
        lines.push(chunk);
      },
    },
  });
  const records = (): Record<string, unknown>[] =>
    lines
      .join("")
      .split("\n")
      .filter((line) => line.length > 0)
      .map((line) => JSON.parse(line) as Record<string, unknown>);
  return { logger, lines, records };
}

/** A logger rendering readable lines to memory, plus the raw lines produced. */
function prettyLogger(options: Omit<CreateLoggerOptions, "destination" | "format"> = {}) {
  const written: string[] = [];
  const logger = createLogger({
    ...options,
    format: "pretty",
    destination: {
      write: (chunk: string) => {
        written.push(chunk);
      },
    },
  });
  const lines = (): string[] =>
    written
      .join("")
      .split("\n")
      .filter((line) => line.length > 0);
  return { logger, lines };
}

const originalLevelEnv = process.env[LOG_LEVEL_ENV_VAR];
const originalFormatEnv = process.env[LOG_FORMAT_ENV_VAR];

beforeEach(() => {
  delete process.env[LOG_LEVEL_ENV_VAR];
  delete process.env[LOG_FORMAT_ENV_VAR];
});

afterEach(() => {
  if (originalLevelEnv === undefined) delete process.env[LOG_LEVEL_ENV_VAR];
  else process.env[LOG_LEVEL_ENV_VAR] = originalLevelEnv;
  if (originalFormatEnv === undefined) delete process.env[LOG_FORMAT_ENV_VAR];
  else process.env[LOG_FORMAT_ENV_VAR] = originalFormatEnv;
  vi.restoreAllMocks();
});

describe("service-mode records", () => {
  it("writes one JSON object per line carrying level, time, component and event", () => {
    const { logger, lines, records } = recordingLogger({ context: { component: "start" } });

    logger.info("service_starting", { home: "/srv/rusa" });
    logger.warn("cron_preflight_failed", { issues: ["crontab missing"] });

    expect(lines).toHaveLength(2);
    for (const line of lines) expect(line.endsWith("\n")).toBe(true);
    expect(records()).toEqual([
      {
        level: "info",
        time: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T/),
        component: "start",
        msg: "service_starting",
        home: "/srv/rusa",
      },
      {
        level: "warn",
        time: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T/),
        component: "start",
        msg: "cron_preflight_failed",
        issues: ["crontab missing"],
      },
    ]);
  });

  it("carries no ambient process fields, so a record holds only what it meant to", () => {
    const { logger, records } = recordingLogger();

    logger.info("database_ready");

    expect(records()[0]).not.toHaveProperty("pid");
    expect(records()[0]).not.toHaveProperty("hostname");
  });

  it("writes nothing to the console — service diagnostics and CLI output stay apart", () => {
    const spies = (["log", "info", "warn", "error", "debug"] as const).map((method) =>
      vi.spyOn(console, method).mockImplementation(() => {})
    );
    const { logger } = recordingLogger({ level: "debug" });

    logger.debug("d");
    logger.info("i");
    logger.warn("w");
    logger.error("e");

    for (const spy of spies) expect(spy).not.toHaveBeenCalled();
  });
});

describe("child context", () => {
  it("propagates actor and run context onto every record the run writes", () => {
    const { logger, records } = recordingLogger({ context: { component: "start" } });
    const runLog = logger
      .child({ component: "actor-run" })
      .child({ actorId: "worker-7", runId: "run-42" });

    runLog.info("run_start", { provider: "claude" });
    runLog.error("run_end", { success: false, exitCode: 1 });

    expect(records()).toMatchObject([
      {
        component: "actor-run",
        actorId: "worker-7",
        runId: "run-42",
        msg: "run_start",
        provider: "claude",
      },
      {
        component: "actor-run",
        actorId: "worker-7",
        runId: "run-42",
        msg: "run_end",
        success: false,
        exitCode: 1,
      },
    ]);
  });

  it("propagates request context without the caller repeating it", () => {
    const { logger, records } = recordingLogger();
    const deliveryLog = logger.child({ component: "webhook", deliveryId: "delivery-9" });

    deliveryLog.error("webhook_event_failed", { event: "issue_comment" });

    expect(records()[0]).toMatchObject({
      component: "webhook",
      deliveryId: "delivery-9",
      msg: "webhook_event_failed",
      event: "issue_comment",
    });
  });

  it("leaves the parent's bindings alone", () => {
    const { logger, records } = recordingLogger({ context: { component: "start" } });

    logger.child({ actorId: "worker-1" }).info("run_start");
    logger.info("service_stopped");

    expect(records()[1]).not.toHaveProperty("actorId");
  });
});

describe("level selection and filtering", () => {
  it("drops records below the configured level", () => {
    const { logger, records } = recordingLogger({ level: "warn" });

    logger.debug("noisy_detail");
    logger.info("lifecycle");
    logger.warn("degraded");
    logger.error("failed");

    expect(records().map((record) => record.msg)).toEqual(["degraded", "failed"]);
  });

  it("records debug detail when the level asks for it", () => {
    const { logger, records } = recordingLogger({ level: "debug" });

    logger.debug("actor_output_sink_failed", { sink: "dashboard-live-output" });

    expect(records()).toHaveLength(1);
  });

  it("records nothing at all when silenced", () => {
    const { logger, lines } = recordingLogger({ level: "silent" });

    logger.error("failed");

    expect(lines).toEqual([]);
  });

  it("prefers the environment over the configured level", () => {
    process.env[LOG_LEVEL_ENV_VAR] = "debug";

    expect(resolveLogLevel("error")).toBe("debug");
  });

  it("falls back to the default rather than refusing to log on a bad value", () => {
    expect(resolveLogLevel("verbose")).toBe(DEFAULT_LOG_LEVEL);
    expect(resolveLogLevel(undefined)).toBe(DEFAULT_LOG_LEVEL);
    expect(resolveLogLevel("  WARN ")).toBe("warn");
  });
});

describe("error serialization", () => {
  it("preserves name, message, stack and the whole cause chain", () => {
    const root = new TypeError("socket hang up");
    const middle = new Error("provider call failed", { cause: root });
    const top = new Error("run failed", { cause: middle });
    const { logger, records } = recordingLogger();

    logger.error("run_end", { err: top });

    const err = records()[0].err as SerializedError;
    expect(err.name).toBe("Error");
    expect(err.message).toBe("run failed");
    expect(err.stack).toContain("run failed");
    const cause = err.cause as SerializedError;
    expect(cause.message).toBe("provider call failed");
    expect((cause.cause as SerializedError).name).toBe("TypeError");
    expect((cause.cause as SerializedError).message).toBe("socket hang up");
    expect((cause.cause as SerializedError).stack).toContain("socket hang up");
  });

  it("stops descending a cause chain that never ends", () => {
    let error = new Error("depth-0");
    for (let depth = 1; depth <= 12; depth++) {
      error = new Error(`depth-${depth}`, { cause: error });
    }

    let node = serializeError(error) as SerializedError;
    let depth = 0;
    while (node.cause !== undefined) {
      node = node.cause as SerializedError;
      depth++;
    }

    expect(depth).toBeLessThanOrEqual(5);
  });

  it("keeps a non-Error throw readable instead of dropping it", () => {
    const { logger, records } = recordingLogger();

    logger.error("run_end", { err: "provider exited 137" });

    expect(records()[0].err).toBe("provider exited 137");
  });
});

describe("redaction", () => {
  // Synthetic values only; nothing here is a real credential.
  const apiKey = "AIzaSyFAKE-fixture-key-0000";
  const webhookSecret = "fixture-webhook-secret-1234";

  it("scrubs a configured secret out of an error message and stack", () => {
    const failure = new Error(`GET https://example.test/models?key=${apiKey} failed`);
    failure.stack = `Error: request failed\n    at probe (https://example.test/models?key=${apiKey})`;
    const { logger, lines, records } = recordingLogger({ secrets: [apiKey] });

    logger.error("model_probe_failed", { err: failure });

    const err = records()[0].err as SerializedError;
    expect(err.message).toContain(REDACTED);
    expect(err.stack).toContain(REDACTED);
    expect(lines.join("")).not.toContain(apiKey);
  });

  it("scrubs a configured secret out of a cause's stack, not just the top error", () => {
    const cause = new Error("transport failed");
    cause.stack = `Error: transport failed\n    at send (/srv/rusa/agent.js) header=Bearer ${webhookSecret}`;
    const top = new Error("webhook dispatch failed", { cause });
    const { logger, lines, records } = recordingLogger({ secrets: [apiKey, webhookSecret] });

    logger.error("webhook_event_failed", { deliveryId: "d-1", err: top });

    const serializedCause = (records()[0].err as SerializedError).cause as SerializedError;
    expect(serializedCause.stack).toContain(REDACTED);
    expect(serializedCause.stack).not.toContain(webhookSecret);
    expect(lines.join("")).not.toContain(webhookSecret);
  });

  it("scrubs secrets from ordinary fields, nested values and the event name", () => {
    const { logger, lines } = recordingLogger({ secrets: [apiKey] });

    logger.info("provider_configured", {
      url: `https://example.test?key=${apiKey}`,
      nested: { list: [`prefix ${apiKey} suffix`] },
    });

    expect(lines.join("")).not.toContain(apiKey);
    expect(lines.join("")).toContain(REDACTED);
  });

  it("reads secrets at write time, so a late registration still applies", () => {
    const registered: string[] = [];
    const { logger, lines } = recordingLogger({ secrets: () => registered });

    registered.push(apiKey);
    logger.info("config_loaded", { key: apiKey });

    expect(lines.join("")).not.toContain(apiKey);
  });

  it("drops credential-bearing field names outright", () => {
    const { logger, records } = recordingLogger();

    logger.info("request_prepared", {
      authorization: "Bearer whatever",
      apiKey: "whatever",
      githubToken: "whatever",
      password: "whatever",
      repo: "MEK-Org/rusa",
    });

    expect(records()[0]).toMatchObject({
      authorization: REDACTED,
      apiKey: REDACTED,
      githubToken: REDACTED,
      password: REDACTED,
      repo: "MEK-Org/rusa",
    });
  });

  it("leaves a value too short to distinguish from ordinary text alone", () => {
    // The bound exists only for values that would swallow the record; a
    // three-character secret is scrubbed, and `start` reports anything shorter.
    expect(redactValue("the cat sat on the mat", ["at"])).toBe("the cat sat on the mat");
    expect(redactValue("the cat sat on the mat", ["cat"])).toBe(`the ${REDACTED} sat on the mat`);
  });

  it("survives a cycle and stops at a depth limit instead of recursing forever", () => {
    const cyclic: Record<string, unknown> = { name: "loop" };
    cyclic.self = cyclic;

    expect(redactValue(cyclic)).toEqual({ name: "loop", self: "[circular]" });

    let deep: Record<string, unknown> = { leaf: true };
    for (let i = 0; i < 20; i++) deep = { next: deep };
    expect(JSON.stringify(redactValue(deep))).toContain("[depth-limited]");
  });
});

describe("nullLogger", () => {
  it("accepts every call and its children without writing anything", () => {
    expect(() => {
      nullLogger.child({ component: "test" }).error("boom", { err: new Error("x") });
    }).not.toThrow();
  });
});

/**
 * #177 asks for two things that only look opposed: interactive CLI output stays
 * human-readable, and no event is written twice. Both hold because the format
 * selects how the *one* record stream is rendered — a terminal gets lines, a
 * pipe or a service manager gets JSON, and neither gets the other's copy.
 */
describe("interactive presentation", () => {
  const noEnv = {} as NodeJS.ProcessEnv;

  it("renders readable lines for a terminal and JSON for a pipe", () => {
    expect(resolveLogFormat(undefined, noEnv, true)).toBe("pretty");
    expect(resolveLogFormat(undefined, noEnv, false)).toBe("json");
    expect(resolveLogFormat("auto", noEnv, true)).toBe("pretty");
  });

  it("honors an explicit configured format over the attached terminal", () => {
    expect(resolveLogFormat("json", noEnv, true)).toBe("json");
    expect(resolveLogFormat("pretty", noEnv, false)).toBe("pretty");
  });

  it("lets the environment override the configured format", () => {
    const env = { [LOG_FORMAT_ENV_VAR]: "pretty" } as NodeJS.ProcessEnv;
    expect(resolveLogFormat("json", env, false)).toBe("pretty");
  });

  it("falls back to the terminal check when a format value is unrecognized", () => {
    const env = { [LOG_FORMAT_ENV_VAR]: "yaml" } as NodeJS.ProcessEnv;
    expect(resolveLogFormat(undefined, env, true)).toBe("pretty");
    expect(resolveLogFormat("technicolor", noEnv, false)).toBe("json");
  });

  it("writes a line a person can read, carrying level, component, event and fields", () => {
    const { logger, lines } = prettyLogger({ context: { component: "start" } });

    logger.info("service_starting", { home: "/srv/rusa", port: 8080 });

    expect(lines()).toHaveLength(1);
    const line = lines()[0];
    expect(() => JSON.parse(line)).toThrow();
    expect(line).toContain("INFO");
    expect(line).toContain("start");
    expect(line).toContain("service_starting");
    expect(line).toContain("home=/srv/rusa");
    expect(line).toContain("port=8080");
  });

  it("writes one line per record, never the record and its prose", () => {
    const { logger, lines } = prettyLogger({ context: { component: "start" } });

    logger.info("service_starting", { home: "/srv/rusa" });
    logger.warn("cron_preflight_failed", { issues: ["crontab missing"] });

    expect(lines()).toHaveLength(2);
    expect(lines().filter((line) => line.includes("service_starting"))).toHaveLength(1);
  });

  it("shows the error and its cause chain under the event", () => {
    const { logger, lines } = prettyLogger({ context: { component: "webhook" } });
    const cause = new Error("ECONNREFUSED 127.0.0.1:443");
    const err = new Error("delivery failed", { cause });

    logger.error("delivery_failed", { err, deliveryId: "d-1" });

    const rendered = lines().join("\n");
    expect(rendered).toContain("delivery_failed");
    expect(rendered).toContain("deliveryId=d-1");
    expect(rendered).toContain("Error: delivery failed");
    expect(rendered).toContain("caused by:");
    expect(rendered).toContain("ECONNREFUSED 127.0.0.1:443");
  });

  it("still filters by level, so a readable run is not a louder one", () => {
    const { logger, lines } = prettyLogger({ level: "warn" });

    logger.debug("cache_hit", {});
    logger.info("service_starting", {});
    logger.warn("cron_preflight_failed", {});

    expect(lines()).toHaveLength(1);
    expect(lines()[0]).toContain("cron_preflight_failed");
  });

  it("still scrubs secrets once rendered", () => {
    const secret = "AIzaSyFAKE-fixture-key-0000";
    const { logger, lines } = prettyLogger({ secrets: [secret] });

    logger.error("provider_call_failed", { err: new Error(`GET /v1?key=${secret} failed`) });

    const rendered = lines().join("\n");
    expect(rendered).not.toContain(secret);
    expect(rendered).toContain(REDACTED);
  });

  it("passes a line it cannot parse through rather than dropping it", () => {
    expect(formatRecordLine("not json at all")).toBe("not json at all");
    expect(formatRecordLine("12")).toBe("12");
  });
});

/**
 * The scrub bound is the one gap in value redaction, so its edges are pinned
 * here: a short configured credential reaching an error message or a stack
 * frame — where no field-name rule applies — is still removed.
 */
describe("short configured secrets", () => {
  it("scrubs a secret at the bound out of a message, a stack and a nested field", () => {
    const secret = "s3c";
    expect(secret).toHaveLength(MIN_SCRUBBABLE_SECRET_LENGTH);
    const { logger, records } = recordingLogger({ secrets: [secret] });

    logger.error("webhook_delivery_failed", {
      err: new Error(`signature check used ${secret}`),
      request: { query: `token=${secret}` },
    });

    const record = records()[0];
    const err = record.err as SerializedError;
    expect(err.message).toBe(`signature check used ${REDACTED}`);
    expect(err.stack).toContain(REDACTED);
    expect(err.stack).not.toContain(secret);
    expect(record.request).toEqual({ query: `token=${REDACTED}` });
  });

  it("scrubs a five-character secret, which no field name would have caught", () => {
    const secret = "hunt2";
    const { logger, records } = recordingLogger({ secrets: [secret] });

    logger.error("config_load_failed", { reason: `bad value ${secret} in profile` });

    expect(records()[0].reason).toBe(`bad value ${REDACTED} in profile`);
  });

  it("scrubs a short secret out of a cause deeper in the chain", () => {
    const secret = "tok1";
    const { logger, records } = recordingLogger({ secrets: [secret] });

    logger.error("run_failed", {
      err: new Error("run failed", { cause: new Error(`auth ${secret} rejected`) }),
    });

    const cause = (records()[0].err as SerializedError).cause as SerializedError;
    expect(cause.message).toBe(`auth ${REDACTED} rejected`);
  });

  it("leaves a value below the bound alone, which is what start.ts reports", () => {
    const { logger, records } = recordingLogger({ secrets: ["ab"] });

    logger.info("service_starting", { home: "/srv/absolute" });

    expect(records()[0].home).toBe("/srv/absolute");
  });
});
