import { type DestinationStream, destination, type Logger as PinoLogger, pino } from "pino";

/**
 * Rusa's structured application logger.
 *
 * Pino supplies the parts a logger should not be reinvented for: level
 * filtering, child bindings, ISO timestamps, and one JSON object per line on a
 * synchronous destination. Two things sit on top of it here, because Pino does
 * not give them for free:
 *
 * - **Value redaction.** Pino's `redact` option masks *paths*, so it cannot
 *   remove a configured secret that has leaked into an error message or a stack
 *   frame. Every record is normalized through {@link redactValue} first, so a
 *   registered secret is scrubbed wherever in the record it appears — including
 *   down a `cause` chain.
 * - **An event-first call shape.** `log.info("run_start", { actorId })` keeps
 *   the message a stable identifier and pushes everything that varies into
 *   structured fields, which is what makes records greppable and testable.
 * - **Two presentations of one stream.** The record is the same object either
 *   way; only its rendering differs. A terminal gets a readable line, a pipe or
 *   a service manager gets JSON. See {@link resolveLogFormat}.
 *
 * See `docs/logging.md` for the conventions this module exists to support.
 */

/** The four levels Rusa code uses. See `docs/logging.md` for what each means. */
export type LogLevel = "debug" | "info" | "warn" | "error";

/** Levels plus the "log nothing" setting, which is configuration-only. */
export type LogLevelSetting = LogLevel | "silent";

const LEVEL_SETTINGS: readonly LogLevelSetting[] = ["debug", "info", "warn", "error", "silent"];

/** The level used when nothing is configured, and when a bad value is given. */
export const DEFAULT_LOG_LEVEL: LogLevelSetting = "info";

/** Environment variable that overrides the configured level. */
export const LOG_LEVEL_ENV_VAR = "RUSA_LOG_LEVEL";

/** How a record is rendered. The record itself is identical either way. */
export type LogFormat = "json" | "pretty";

/** Formats plus `auto`, which picks by whether a terminal is attached. */
export type LogFormatSetting = LogFormat | "auto";

const FORMAT_SETTINGS: readonly LogFormatSetting[] = ["json", "pretty", "auto"];

/** The format used when nothing is configured, and when a bad value is given. */
export const DEFAULT_LOG_FORMAT: LogFormatSetting = "auto";

/** Environment variable that overrides the configured format. */
export const LOG_FORMAT_ENV_VAR = "RUSA_LOG_FORMAT";

/** The replacement written wherever a secret or sensitive field is removed. */
export const REDACTED = "[redacted]";

/**
 * A secret shorter than this is not scrubbed from free text. The bound exists
 * only because a one- or two-character value occurs inside ordinary words, so
 * scrubbing it would replace most of every record — including the event names a
 * reader needs to see what happened.
 *
 * It is set as low as that hazard allows rather than at a length real
 * credentials happen to exceed: between this bound and any higher one sits a
 * short configured secret that could reach an error message or a stack frame,
 * where no field-name rule protects it. Over-redaction is a readability cost;
 * under-redaction is a leak.
 *
 * A configured credential below the bound cannot be removed from free text at
 * all. That is not left silent: `rusa start` records `secret_not_scrubbable`
 * naming the config key (never the value) — see `unscrubbableSecretSources`.
 */
export const MIN_SCRUBBABLE_SECRET_LENGTH = 3;

/** How far down a `cause` chain an error is serialized before stopping. */
const MAX_CAUSE_DEPTH = 5;

/** How deep into a field value redaction recurses before stopping. */
const MAX_FIELD_DEPTH = 8;

/**
 * Field names whose value never belongs in a log record regardless of content.
 * The value is dropped by name; {@link redactValue} still scrubs known secret
 * values out of every *other* field, so this is a second line of defence.
 */
const SENSITIVE_KEY = /(secret|token|password|passwd|credential|api[-_]?key|auth|cookie)/i;

/** Structured fields for one record. `err` is serialized, never stringified. */
export interface LogFields {
  err?: unknown;
  [field: string]: unknown;
}

/** Bindings carried by a child logger — `component` at minimum. */
export interface LogContext {
  component?: string;
  [field: string]: unknown;
}

/**
 * The logging surface Rusa code depends on. Domain code takes this interface,
 * never the Pino logger, so a test can pass a recorder and a caller that has no
 * logger can pass {@link nullLogger}.
 */
export interface Logger {
  debug(event: string, fields?: LogFields): void;
  info(event: string, fields?: LogFields): void;
  warn(event: string, fields?: LogFields): void;
  error(event: string, fields?: LogFields): void;
  /** A logger carrying `context` on every record it and its children write. */
  child(context: LogContext): Logger;
}

/** An error flattened into fields, with its whole `cause` chain preserved. */
export interface SerializedError {
  name: string;
  message: string;
  stack?: string;
  cause?: SerializedError | string;
}

export interface CreateLoggerOptions {
  /** Configured level; `RUSA_LOG_LEVEL` overrides it. Default `info`. */
  level?: string;
  /**
   * Literal secret values to scrub from every record. A function is read at
   * write time, so a caller can register secrets after the logger exists (the
   * service logger is built before its config has been parsed).
   */
  secrets?: readonly string[] | (() => readonly string[]);
  /** Where records go. Defaults to a synchronous stdout destination. */
  destination?: DestinationStream;
  /**
   * How records are rendered: `json`, `pretty`, or `auto` (the default —
   * `pretty` when stdout is a terminal). `RUSA_LOG_FORMAT` overrides it.
   */
  format?: string;
  /** Bindings for the root logger. Defaults to `{ component: "rusa" }`. */
  context?: LogContext;
}

/**
 * Resolve a level from a configured value and the environment, preferring the
 * environment so an operator can raise verbosity without editing config.
 * An unrecognized value falls back to {@link DEFAULT_LOG_LEVEL} rather than
 * refusing to start: a typo must not cost the process its logs.
 */
export function resolveLogLevel(
  configured?: string,
  env: NodeJS.ProcessEnv = process.env
): LogLevelSetting {
  for (const candidate of [env[LOG_LEVEL_ENV_VAR], configured]) {
    const normalized = candidate?.trim().toLowerCase();
    if (!normalized) continue;
    const match = LEVEL_SETTINGS.find((level) => level === normalized);
    if (match) return match;
  }
  return DEFAULT_LOG_LEVEL;
}

/**
 * Resolve the presentation from a configured value, the environment and whether
 * a terminal is attached, preferring the environment for the same reason the
 * level does.
 *
 * `auto` is what keeps #177's two requirements from fighting: interactive CLI
 * output stays human-readable, and nothing is double-logged, because this
 * chooses how the single record stream is *rendered* rather than adding a
 * second stream of prose beside it. A person watching a terminal reads lines; a
 * pipe, a file or a service manager gets JSON.
 */
export function resolveLogFormat(
  configured?: string,
  env: NodeJS.ProcessEnv = process.env,
  isTTY: boolean = process.stdout?.isTTY === true
): LogFormat {
  for (const candidate of [env[LOG_FORMAT_ENV_VAR], configured]) {
    const normalized = candidate?.trim().toLowerCase();
    if (!normalized) continue;
    const match = FORMAT_SETTINGS.find((format) => format === normalized);
    if (!match) continue;
    if (match !== "auto") return match;
    break;
  }
  return isTTY ? "pretty" : "json";
}

/** Record keys that the readable line renders in its own right. */
const PRETTY_HEADER_KEYS = new Set(["level", "time", "msg", "component", "err"]);

const LEVEL_TAG: Record<string, string> = {
  debug: "DEBUG",
  info: "INFO ",
  warn: "WARN ",
  error: "ERROR",
};

/** `2026-09-05T16:04:11.235Z` -> `16:04:11.235`; anything else passes through. */
function prettyTime(time: unknown): string {
  if (typeof time !== "string") return "";
  const match = /T(\d{2}:\d{2}:\d{2}\.\d{3})Z?$/.exec(time);
  return match ? match[1] : time;
}

/** A field value as one short token: bare when it is already word-like. */
function prettyValue(value: unknown): string {
  if (typeof value === "string") return /^[\w.:/@+-]*$/.test(value) ? value : JSON.stringify(value);
  if (value === null || value === undefined) return String(value);
  if (typeof value === "object") return JSON.stringify(value);
  return String(value);
}

/** The `err` field as indented lines: the chain a person reads top-down. */
function prettyError(err: unknown, indent = "    "): string[] {
  if (typeof err === "string") return [`${indent}${err}`];
  if (err === null || typeof err !== "object") return [];
  const { name, message, stack, cause } = err as Record<string, unknown>;
  const lines: string[] = [];
  const heading = [name, message].filter((part) => typeof part === "string" && part).join(": ");
  if (heading) lines.push(`${indent}${heading}`);
  if (typeof stack === "string") {
    for (const frame of stack.split("\n").slice(1)) lines.push(`${indent}${frame.trim()}`);
  }
  if (cause !== undefined && cause !== null) {
    lines.push(`${indent}caused by:`);
    lines.push(...prettyError(cause, `${indent}  `));
  }
  return lines;
}

/**
 * Render one JSON record as a readable line. A record that will not parse is
 * returned unchanged: a presentation choice must never cost a log line.
 */
export function formatRecordLine(line: string): string {
  let record: Record<string, unknown>;
  try {
    const parsed: unknown = JSON.parse(line);
    if (!parsed || typeof parsed !== "object") return line;
    record = parsed as Record<string, unknown>;
  } catch {
    return line;
  }
  const level = typeof record.level === "string" ? record.level : "info";
  const head = [
    prettyTime(record.time),
    LEVEL_TAG[level] ?? level.toUpperCase(),
    typeof record.component === "string" ? record.component : "",
    typeof record.msg === "string" ? record.msg : "",
  ].filter(Boolean);
  const fields = Object.entries(record)
    .filter(([key]) => !PRETTY_HEADER_KEYS.has(key))
    .map(([key, value]) => `${key}=${prettyValue(value)}`);
  return [[...head, ...fields].join(" "), ...prettyError(record.err)].join("\n");
}

/**
 * Wrap a destination so records reach it as readable lines instead of JSON.
 *
 * This reformats Pino's own output rather than using a Pino transport: a
 * transport runs on a worker thread, and `rusa start` leaves through
 * `process.exit()`, which would drop whatever the worker had not yet flushed —
 * the same reason the JSON destination is synchronous. Reformatting in-process
 * keeps every record on the write that produced it.
 */
export function prettyDestination(target: DestinationStream): DestinationStream {
  return {
    write(chunk: string): void {
      for (const line of chunk.split("\n")) {
        if (line.trim()) target.write(`${formatRecordLine(line)}\n`);
      }
    },
  };
}

/** Replace every occurrence of a known secret in `text`. */
function scrubText(text: string, secrets: readonly string[]): string {
  let scrubbed = text;
  for (const secret of secrets) {
    if (secret.length < MIN_SCRUBBABLE_SECRET_LENGTH) continue;
    if (!scrubbed.includes(secret)) continue;
    scrubbed = scrubbed.split(secret).join(REDACTED);
  }
  return scrubbed;
}

/**
 * Flatten an error into plain fields: name, message, stack, and the `cause`
 * chain, with every string scrubbed. A stack is the most common place a secret
 * ends up by accident (an interpolated URL in a thrown message), so it is
 * scrubbed exactly like any other string rather than passed through.
 */
export function serializeError(
  error: unknown,
  secrets: readonly string[] = [],
  depth = 0
): SerializedError | string {
  if (!(error instanceof Error)) {
    return scrubText(typeof error === "string" ? error : String(error), secrets);
  }
  const serialized: SerializedError = {
    name: scrubText(error.name, secrets),
    message: scrubText(error.message, secrets),
  };
  if (typeof error.stack === "string") serialized.stack = scrubText(error.stack, secrets);
  if (error.cause !== undefined && error.cause !== null && depth < MAX_CAUSE_DEPTH) {
    serialized.cause = serializeError(error.cause, secrets, depth + 1);
  }
  return serialized;
}

/**
 * Deep-copy a field value with secrets scrubbed, sensitive keys dropped, errors
 * serialized, and cycles broken. Returns data safe to hand to `JSON.stringify`.
 */
export function redactValue(
  value: unknown,
  secrets: readonly string[] = [],
  seen: Set<object> = new Set(),
  depth = 0
): unknown {
  if (value === null || value === undefined) return value;
  if (typeof value === "string") return scrubText(value, secrets);
  if (typeof value === "number" || typeof value === "boolean") return value;
  if (typeof value === "bigint" || typeof value === "symbol") return String(value);
  if (typeof value === "function") return undefined;
  if (value instanceof Error) return serializeError(value, secrets);
  if (value instanceof Date) return value.toISOString();
  if (depth >= MAX_FIELD_DEPTH) return "[depth-limited]";
  if (seen.has(value as object)) return "[circular]";
  seen.add(value as object);
  try {
    if (Array.isArray(value)) {
      return value.map((entry) => redactValue(entry, secrets, seen, depth + 1));
    }
    const out: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
      if (entry === undefined) continue;
      out[key] = SENSITIVE_KEY.test(key) ? REDACTED : redactValue(entry, secrets, seen, depth + 1);
    }
    return out;
  } finally {
    seen.delete(value as object);
  }
}

/** Normalize one call's fields into the object handed to Pino. */
function normalizeFields(fields: LogFields | undefined, secrets: readonly string[]): LogFields {
  if (!fields) return {};
  const { err, ...rest } = fields;
  const normalized = redactValue(rest, secrets) as LogFields;
  if (err !== undefined) normalized.err = serializeError(err, secrets);
  return normalized;
}

function wrap(target: PinoLogger, readSecrets: () => readonly string[]): Logger {
  const emit =
    (level: LogLevel) =>
    (event: string, fields?: LogFields): void => {
      const secrets = readSecrets();
      target[level](normalizeFields(fields, secrets), scrubText(event, secrets));
    };
  return {
    debug: emit("debug"),
    info: emit("info"),
    warn: emit("warn"),
    error: emit("error"),
    child: (context) =>
      wrap(target.child(redactValue(context, readSecrets()) as LogContext), readSecrets),
  };
}

/**
 * Build the application logger. Records are one JSON object per line carrying
 * `level` (as a label), `time` (ISO-8601), the child bindings, `msg` (the stable
 * event name), and the call's fields.
 */
export function createLogger(options: CreateLoggerOptions = {}): Logger {
  const configuredSecrets = options.secrets;
  const format = resolveLogFormat(options.format);
  const readSecrets: () => readonly string[] =
    typeof configuredSecrets === "function" ? configuredSecrets : () => configuredSecrets ?? [];
  const target = options.destination ?? destination({ dest: 1, sync: true });
  const sink = format === "pretty" ? prettyDestination(target) : target;
  const root = pino(
    {
      level: resolveLogLevel(options.level),
      // `pid`/`hostname` are journald's job, not the record's; dropping them
      // keeps each line to the fields the event actually meant to carry.
      base: options.context ?? { component: "rusa" },
      formatters: { level: (label) => ({ level: label }) },
      // `err` arrives already flattened and scrubbed by `serializeError`.
      // Pino's own error serializer would re-serialize that plain object and
      // fold the `cause` chain back into the message, losing the chain.
      serializers: { err: (value: unknown) => value },
      timestamp: pino.stdTimeFunctions.isoTime,
    },
    // Synchronous by choice: `rusa start` exits through `process.exit()` on
    // shutdown and on fatal config errors, which would drop a buffered record —
    // and the record explaining why the process died is the one that matters.
    // `pretty` reformats that same stream in place; it does not tee it.
    sink
  );
  return wrap(root, readSecrets);
}

/** A logger that discards everything, for callers with nothing to log to. */
export const nullLogger: Logger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
  child: () => nullLogger,
};
