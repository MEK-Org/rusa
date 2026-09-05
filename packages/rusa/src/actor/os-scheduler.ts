import type { AtIo } from "./at-queue.js";
import { assertCronExprCanFire } from "./cron-expression.js";
import type { CrontabMutator } from "./crontab.js";

const DEFAULT_CURL = "/usr/bin/curl";
const WAKE_TAG_PREFIX = "# mc-wake:";

/**
 * The actor-facing recurring-wake slice of the host scheduler.
 */
export interface ActorWakeScheduler {
  schedule(
    actorId: string,
    cronExpr: string,
    reason: string,
    priority?: "normal" | "responsive"
  ): Promise<void>;
  cancel(actorId: string): Promise<void>;
  list(): Promise<WakeEntry[]>;
}

/** The obligation-facing slice of the host scheduler. */
export interface ObligationActivationScheduler {
  scheduleObligationActivation(
    id: string,
    time: { kind: "cron"; cronExpr: string } | { kind: "at"; date: Date }
  ): void;
  cancelObligationActivation(id: string): void;
  listObligationActivations(): string[];
}

/** A complete one-shot message persisted inside its versioned `at` job. */
export interface ScheduledMessage {
  id: string;
  toId: string;
  fromId: string;
  body: string;
  deliverAt: string;
  sessionId?: string;
}

/** The scheduled-message-facing slice of the host scheduler. */
export interface ScheduledMessageScheduler {
  scheduleMessageDelivery(message: ScheduledMessage): void;
  cancelMessageDelivery(id: string): void;
  listMessageDeliveries(): ScheduledMessage[];
}

/**
 * The single host scheduling boundary. Cron owns recurring actor wakes and
 * cron-policy obligations; `at` owns one-shot obligation activations and the
 * complete payload of scheduled messages.
 */
export interface OsScheduler
  extends ActorWakeScheduler,
    ObligationActivationScheduler,
    ScheduledMessageScheduler {}

export interface OsSchedulerOptions {
  tokenFile: string;
  portFile: string;
  host?: string;
  curlPath?: string;
}

export interface WakeEntry {
  actorId: string;
  cronExpr: string;
  reason: string;
  priority?: "normal" | "responsive";
}

/** Actor ids and suffixed wake slots accepted in managed crontab tags. */
export function isValidActorId(actorId: string): boolean {
  return /^[A-Za-z0-9._-]+(:[A-Za-z0-9._-]+)*$/.test(actorId);
}

/** Single-quote a value for a cron command, then escape cron's `%` newline. */
function quoteForCron(value: string): string {
  const oneLine = value.replace(/[\r\n]+/g, " ");
  const singleQuoted = `'${oneLine.replace(/'/g, "'\\''")}'`;
  return singleQuoted.replace(/%/g, "\\%");
}

function parseWakeReason(job: string): string {
  const match = job.match(/-d '(?:reason=)((?:[^']|'\\'')*)'/);
  if (!match) return "";
  return match[1].replace(/'\\''/g, "'").replace(/\\%/g, "%");
}

function parseWakePriority(job: string): "responsive" | undefined {
  const match = job.match(/-d '(?:priority=)((?:[^']|'\\'')*)'/);
  if (!match) return undefined;
  const value = match[1].replace(/'\\''/g, "'");
  return value === "responsive" ? "responsive" : undefined;
}

/**
 * Thrown when an owned recurrence/message cron block is found truncated or
 * unterminated — a start tag with no matching end marker before EOF or
 * another start tag. This can only mean the block was hand-edited or
 * corrupted after this class wrote it: its exact boundary can no longer be
 * verified, so the mutation fails closed with no write rather than guessing
 * that an adjacent line belongs to (or doesn't belong to) the block.
 */
export class TruncatedCronBlockError extends Error {
  constructor(tag: string) {
    super(
      `crontab block "${tag}" has no matching end marker — truncated or hand-edited; refusing to mutate without a verified boundary`
    );
    this.name = "TruncatedCronBlockError";
  }
}

const SCHEDULED_MESSAGE_SCHEMA_VERSION = 1 as const;
const MAX_SCHEDULED_MESSAGE_BODY_BYTES = 128 * 1024;

export function encodeScheduledMessagePayload(message: ScheduledMessage): string {
  return Buffer.from(
    JSON.stringify({ schemaVersion: SCHEDULED_MESSAGE_SCHEMA_VERSION, ...message }),
    "utf8"
  ).toString("base64url");
}

export function decodeScheduledMessagePayload(payload: string): ScheduledMessage {
  try {
    const value = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as Record<
      string,
      unknown
    >;
    if (
      value.schemaVersion !== SCHEDULED_MESSAGE_SCHEMA_VERSION ||
      typeof value.id !== "string" ||
      value.id.length === 0 ||
      typeof value.toId !== "string" ||
      value.toId.length === 0 ||
      typeof value.fromId !== "string" ||
      value.fromId.length === 0 ||
      typeof value.body !== "string" ||
      Buffer.byteLength(value.body, "utf8") > MAX_SCHEDULED_MESSAGE_BODY_BYTES ||
      typeof value.deliverAt !== "string" ||
      (value.sessionId !== undefined && typeof value.sessionId !== "string") ||
      Number.isNaN(Date.parse(value.deliverAt))
    ) {
      throw new Error("invalid scheduled-message payload");
    }
    return {
      id: value.id,
      toId: value.toId,
      fromId: value.fromId,
      body: value.body,
      deliverAt: value.deliverAt,
      ...(typeof value.sessionId === "string" ? { sessionId: value.sessionId } : {}),
    };
  } catch (cause) {
    throw new Error("invalid scheduled-message payload", { cause });
  }
}

function decodeScheduledMessage(script: string): ScheduledMessage {
  const match = script.match(/-d 'payload=([A-Za-z0-9_-]+)'/);
  if (!match) throw new Error("scheduled-message job has no payload");
  return decodeScheduledMessagePayload(match[1]);
}

export class DefaultOsScheduler implements OsScheduler {
  constructor(
    private readonly mutator: CrontabMutator,
    private readonly atIo: AtIo,
    private readonly opts: OsSchedulerOptions
  ) {}

  /** Build the complete cron line for an actor wake. */
  buildWakeJobLine(
    actorId: string,
    cronExpr: string,
    reason: string,
    priority?: "normal" | "responsive" | boolean
  ): string {
    const curl = this.opts.curlPath ?? DEFAULT_CURL;
    const host = this.opts.host ?? "127.0.0.1";
    const url = `"http://${host}:$(cat ${this.opts.portFile})/wake"`;
    const auth = `"Authorization: Bearer $(cat ${this.opts.tokenFile})"`;
    const responsive = priority === "responsive" || priority === true;
    const priorityArg = responsive ? ` -d ${quoteForCron("priority=responsive")}` : "";
    return (
      `${cronExpr.trim()} ${curl} -fsS -H ${auth} ${url} ` +
      `-d ${quoteForCron(`actorId=${actorId}`)} -d ${quoteForCron(`reason=${reason}`)}${priorityArg}`
    );
  }

  /** Remove the actor's owned two-line wake block while preserving all other entries. */
  private stripWakeBlock(lines: string[], actorId: string): string[] {
    const tag = WAKE_TAG_PREFIX + actorId;
    const kept: string[] = [];
    for (let index = 0; index < lines.length; index++) {
      if (lines[index].trim() === tag) {
        const next = lines[index + 1];
        if (next !== undefined && next.trim() !== "" && !next.trimStart().startsWith("#")) {
          index++;
        }
        continue;
      }
      kept.push(lines[index]);
    }
    return kept;
  }

  async schedule(
    actorId: string,
    cronExpr: string,
    reason: string,
    priority?: "normal" | "responsive"
  ): Promise<void> {
    if (!isValidActorId(actorId)) throw new Error(`invalid actor id: ${actorId}`);
    assertCronExprCanFire(cronExpr);
    this.mutator.mutate((lines) => {
      const kept = this.stripWakeBlock(lines, actorId);
      kept.push(
        WAKE_TAG_PREFIX + actorId,
        this.buildWakeJobLine(actorId, cronExpr, reason, priority)
      );
      return { lines: kept, result: undefined };
    });
  }

  async cancel(actorId: string): Promise<void> {
    if (!isValidActorId(actorId)) throw new Error(`invalid actor id: ${actorId}`);
    this.mutator.mutate((lines) => {
      const kept = this.stripWakeBlock(lines, actorId);
      return { lines: kept.length === lines.length ? lines : kept, result: undefined };
    });
  }

  async list(): Promise<WakeEntry[]> {
    const current = this.mutator.read();
    if (current === "") return [];
    const lines = current.replace(/\n$/, "").split("\n");
    const entries: WakeEntry[] = [];
    for (let index = 0; index < lines.length; index++) {
      const trimmed = lines[index].trim();
      if (!trimmed.startsWith(WAKE_TAG_PREFIX)) continue;
      const job = lines[index + 1] ?? "";
      const priority = parseWakePriority(job);
      entries.push({
        actorId: trimmed.slice(WAKE_TAG_PREFIX.length),
        cronExpr: job.trim().split(/\s+/).slice(0, 5).join(" "),
        reason: parseWakeReason(job),
        ...(priority ? { priority } : {}),
      });
    }
    return entries;
  }

  private buildCurlLine(
    endpoint: string,
    data: Record<string, string>,
    options?: { retryWhileServiceRestarts?: boolean }
  ): string {
    const curl = this.opts.curlPath ?? DEFAULT_CURL;
    const host = this.opts.host ?? "127.0.0.1";
    const auth = `"Authorization: Bearer $(cat ${this.opts.tokenFile})"`;
    const args = Object.entries(data)
      .map(([k, v]) => `-d '${k}=${v.replace(/'/g, "'\\''")}'`)
      .join(" ");
    if (!options?.retryWhileServiceRestarts) {
      const url = `"http://${host}:$(cat ${this.opts.portFile})/${endpoint}"`;
      return `${curl} -fsS -H ${auth} ${url} ${args}`;
    }

    // The callback port is ephemeral and can change during a service restart.
    // Curl's built-in retry expands $(cat portFile) only once, before curl
    // starts, so use a bounded shell loop that re-reads both files on every
    // attempt. This also covers an overdue legacy job firing during first boot,
    // before the port file has been published.
    const url = `"http://${host}:$rusa_callback_port/${endpoint}"`;
    const call = `${curl} -fsS -H ${auth} ${url} ${args}`;
    return `rusa_attempt=0; while [ "$rusa_attempt" -lt 120 ]; do rusa_callback_port=$(cat ${this.opts.portFile} 2>/dev/null) && ${call} && exit 0; rusa_attempt=$((rusa_attempt + 1)); sleep 5; done; exit 1`;
  }

  /**
   * Drop exactly the block this class writes for `tag`: from the tag line
   * through the matching `endTag` line, inclusive — an exact, verifiable
   * boundary rather than a fixed line count or content heuristic. A prior
   * position-counting version assumed the block was always intact and
   * consumed whatever followed the tag by position, which deletes an
   * adjacent user entry the moment the block is truncated or hand-edited
   * (e.g. `# mc-obligation-activation:<id>` immediately followed by an
   * unrelated job, with no job/restore lines of its own left before it).
   * When `endTag` isn't found before either EOF or another start tag, the
   * block is malformed/partial — its boundary can no longer be verified, so
   * this throws {@link TruncatedCronBlockError} instead of guessing which
   * adjacent line belongs to it. The caller must perform no write in that
   * case (never fall back to dropping just the orphaned tag): a block that
   * looks truncated might just as easily be one where a foreign line was
   * inserted BEFORE the real end marker, and only a human can tell those
   * apart safely.
   */
  private stripCronBlock(lines: string[], tag: string, endTag: string): string[] {
    const out: string[] = [];
    let i = 0;
    while (i < lines.length) {
      if (lines[i].trim() !== tag) {
        out.push(lines[i]);
        i++;
        continue;
      }
      let j = i + 1;
      while (j < lines.length && lines[j].trim() !== endTag && lines[j].trim() !== tag) {
        j++;
      }
      if (j < lines.length && lines[j].trim() === endTag) {
        i = j + 1; // drop tag..endTag inclusive
      } else {
        throw new TruncatedCronBlockError(tag);
      }
    }
    return out;
  }

  /**
   * Routed through the shared {@link CrontabMutator}: if `stripCronBlock`
   * throws (truncated block), that throw propagates out of `mutate()` before
   * it ever calls `write`, so a truncated block leaves the crontab
   * byte-for-byte untouched.
   */
  private updateCron(tag: string, endTag: string, jobLine: string | null): void {
    this.mutator.mutate((lines) => {
      const kept = this.stripCronBlock(lines, tag, endTag);
      if (jobLine) {
        kept.push(tag, jobLine, endTag);
      }
      const changed = kept.length !== lines.length || !!jobLine;
      return { lines: changed ? kept : lines, result: undefined };
    });
  }

  /** Verify an existing managed block before touching a replacement scheduler. */
  private verifyCronBlock(tag: string, endTag: string): void {
    this.mutator.mutate((lines) => {
      this.stripCronBlock(lines, tag, endTag);
      return { lines, result: undefined };
    });
  }

  /** The last `CRON_TZ=...` assignment still in effect at the end of `lines`, if any. */
  private lastCronTzLine(lines: string[]): string | null {
    for (let i = lines.length - 1; i >= 0; i--) {
      if (lines[i].trim().startsWith("CRON_TZ=")) return lines[i];
    }
    return null;
  }

  private staleAtIds(tag: string): string[] {
    return this.atIo
      .list()
      .filter((job) => job.script.split("\n").some((line) => line.trim() === tag))
      .map((job) => job.id);
  }

  private removeAtIds(ids: Iterable<string>): void {
    for (const id of ids) this.atIo.remove(id);
  }

  /** The tag/end-tag pair bounding one obligation's managed cron block, exactly. */
  private activationTags(id: string): { tag: string; endTag: string } {
    return {
      tag: `# mc-obligation-activation:${id}`,
      endTag: `# mc-obligation-activation-end:${id}`,
    };
  }

  scheduleObligationActivation(
    id: string,
    time: { kind: "cron"; cronExpr: string } | { kind: "at"; date: Date }
  ): void {
    const { tag, endTag } = this.activationTags(id);
    const curlLine = this.buildCurlLine("wake-obligation", { id });

    if (time.kind === "cron") {
      assertCronExprCanFire(time.cronExpr);
      const staleAtIds = this.staleAtIds(tag);
      // CRON_TZ persists for every later line in the crontab, not just ours,
      // so the block must put back whatever was in effect before it rather
      // than clearing it — otherwise a job appended after this one silently
      // loses a timezone some other entry depends on.
      this.mutator.mutate((lines) => {
        const kept = this.stripCronBlock(lines, tag, endTag);
        const priorTz = this.lastCronTzLine(kept);
        // Debian vixie cron treats CRON_TZ as an environment variable, and an
        // empty assignment must use the quoted form CRON_TZ="" — a bare
        // CRON_TZ= is rejected as "bad minute" and the whole crontab install
        // fails closed. Cron doesn't interpret CRON_TZ scheduling semantics
        // here anyway since the deployment host is UTC, so the quoted empty
        // assignment is harmless.
        kept.push(
          tag,
          "CRON_TZ=UTC",
          `${time.cronExpr} ${curlLine}`,
          priorTz ?? 'CRON_TZ=""',
          endTag
        );
        return { lines: kept, result: undefined };
      });
      // The replacement cron block is now durable.  If removing an old at job
      // fails, retain it for reconciliation rather than creating a scheduling
      // gap by removing it before the replacement was installed.
      this.removeAtIds(staleAtIds);
    } else {
      const script = `${tag}\n${curlLine}\n`;
      // Validate the existing block before submitting `at`: corruption must
      // still fail closed with no new job, while a normal replacement is
      // installed before its old cron/at entries are removed.
      this.verifyCronBlock(tag, endTag);
      // Install first: a failed `at` submission leaves an existing cron block
      // and prior at jobs armed.  Once it succeeds, remove only the stale jobs
      // captured before installation (never the just-created replacement).
      const staleAtIds = this.staleAtIds(tag);
      const replacementId = this.atIo.schedule(script, time.date);
      this.updateCron(tag, endTag, null);
      this.removeAtIds(staleAtIds.filter((staleId) => staleId !== replacementId));
    }
  }

  cancelObligationActivation(id: string): void {
    const { tag, endTag } = this.activationTags(id);
    this.updateCron(tag, endTag, null);
    this.removeAtIds(this.staleAtIds(tag));
  }

  listObligationActivations(): string[] {
    const ids = new Set<string>();
    const current = this.mutator.read();
    for (const line of current.split("\n")) {
      const m = line.match(/^# mc-obligation-activation:(.+)$/);
      if (m) ids.add(m[1].trim());
    }
    for (const job of this.atIo.list()) {
      const m = job.script.match(/# mc-obligation-activation:(.+)/);
      if (m) ids.add(m[1].trim());
    }
    return Array.from(ids);
  }

  scheduleMessageDelivery(message: ScheduledMessage): void {
    if (Buffer.byteLength(message.body, "utf8") > MAX_SCHEDULED_MESSAGE_BODY_BYTES) {
      throw new Error("Scheduled message body exceeds the 128 KiB host-job limit");
    }
    // Apply the same shape validation used by the callback boundary before a
    // job reaches the host queue. This also rejects invalid deliverAt values
    // supplied by importers or callers outside ActorMesh.
    const payload = encodeScheduledMessagePayload(message);
    decodeScheduledMessagePayload(payload);
    const tag = this.messageTag(message.id);
    const curlLine = this.buildCurlLine(
      "wake-message",
      { payload },
      { retryWhileServiceRestarts: true }
    );
    const script = `${tag}\n${curlLine}\n`;
    const staleAtIds = this.staleAtIds(tag);
    const replacementId = this.atIo.schedule(script, new Date(message.deliverAt));
    this.removeAtIds(staleAtIds.filter((staleId) => staleId !== replacementId));
  }

  cancelMessageDelivery(id: string): void {
    const tag = this.messageTag(id);
    this.removeAtIds(this.staleAtIds(tag));
  }

  listMessageDeliveries(): ScheduledMessage[] {
    const messages = new Map<string, ScheduledMessage>();
    for (const job of this.atIo.list()) {
      const tagLines = job.script
        .split("\n")
        .map((line) => line.trim())
        .filter((line) => line.startsWith("# mc-message-delivery:"));
      if (tagLines.length === 0) continue;
      let message: ScheduledMessage;
      try {
        message = decodeScheduledMessage(job.script);
        if (tagLines.length !== 1 || tagLines[0] !== this.messageTag(message.id)) {
          throw new Error("scheduled-message tag does not match its payload id");
        }
      } catch (cause) {
        throw new Error(`Invalid scheduled-message host job ${job.id}`, { cause });
      }
      messages.set(message.id, message);
    }
    return [...messages.values()].sort(
      (left, right) =>
        Date.parse(left.deliverAt) - Date.parse(right.deliverAt) || left.id.localeCompare(right.id)
    );
  }

  private messageTag(id: string): string {
    return `# mc-message-delivery:${Buffer.from(id, "utf8").toString("base64url")}`;
  }
}
