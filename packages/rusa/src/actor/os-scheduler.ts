import { type Logger, nullLogger } from "../observability/logger.js";
import type { AtIo } from "./at-queue.js";
import { assertCronExprCanFire } from "./cron-expression.js";
import type { CrontabMutator } from "./crontab.js";

const DEFAULT_CURL = "/usr/bin/curl";

/**
 * Every tag family this scheduler writes into the crontab or an `at` job.
 * The instance component is part of the tag's shape, never a per-family
 * option: {@link instanceTag} is the only constructor, so a family cannot be
 * written without the identity of the instance that owns it. Unscoped message
 * tags once let every co-hosted instance sweep every other instance's pending
 * messages at boot; a new family cannot repeat that by omission.
 */
type InstanceTagFamily = "wake" | "obligation-activation" | "message-delivery";
/** A multi-line cron block is bounded by a start tag and its `-end` twin. */
type InstanceTagBoundary = "start" | "end";
const INSTANCE_TAG_VERSION = "v1";

// Pre-scoping tags are legacy and foreign: `# mc-wake:<actorId>`,
// `# mc-message-delivery:<base64url id>` and the two below. The `-instance`
// suffix on the scoped prefixes is intentional: a version marker under an old
// prefix would still be ambiguous with a legal legacy id such as `v1:abc`, so
// no legacy line can ever parse as a scoped one.
const LEGACY_WAKE_TAG_PREFIX = "# mc-wake:";
const LEGACY_ACTIVATION_TAG_PREFIX = "# mc-obligation-activation:";

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

/** One parsed obligation activation entry from the OS scheduler. */
export interface ObligationActivationRecord {
  id: string;
  instanceId?: string;
}

/** The obligation-facing slice of the host scheduler. */
export interface ObligationActivationScheduler {
  /** Stable identity of the configured instance that owns this scheduler. */
  readonly instanceId: string;
  scheduleObligationActivation(
    id: string,
    time: { kind: "cron"; cronExpr: string } | { kind: "at"; date: Date }
  ): void;
  cancelObligationActivation(id: string): void;
  listObligationActivations(): ObligationActivationRecord[];
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
  /** Stable identity supplied by the composition root for activation ownership. */
  instanceId: string;
  /**
   * Receives one record per `at` write, removal and enqueue confirmation, and
   * the boot audit of legacy wake blocks. Silent when omitted.
   */
  log?: Logger;
  /** Clock for judging whether a missing `at` job could already have fired. */
  now?: () => number;
}

/** A pre-scoping `# mc-wake:` block this instance found but cannot prove it owns. */
export interface UnadoptedLegacyWakeBlock {
  actorId: string;
  /** The wake-port path the block's job line reads, when it has one. */
  portFile: string | null;
  cronExpr: string;
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

/** Encode one tag component so arbitrary legal entity IDs cannot delimit a tag. */
function encodeTagComponent(value: string): string {
  return Buffer.from(value, "utf8").toString("base64url");
}

/** Decode only the canonical base64url values emitted by this scheduler. */
function decodeTagComponent(value: string): string | null {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) return null;
  const decoded = Buffer.from(value, "base64url").toString("utf8");
  return encodeTagComponent(decoded) === value ? decoded : null;
}

function instanceTagPrefix(
  family: InstanceTagFamily,
  boundary: InstanceTagBoundary = "start"
): string {
  return `# mc-${family}-instance${boundary === "end" ? "-end" : ""}:${INSTANCE_TAG_VERSION}:`;
}

/** One parsed instance-scoped tag line, from any instance. */
interface InstanceTagRecord {
  instanceId: string;
  id: string;
}

/**
 * The single constructor for every OS job tag:
 * `# mc-<family>-instance[-end]:v1:<base64url instanceId>:<base64url id>`.
 */
function instanceTag(
  family: InstanceTagFamily,
  instanceId: string,
  id: string,
  boundary: InstanceTagBoundary = "start"
): string {
  return `${instanceTagPrefix(family, boundary)}${encodeTagComponent(instanceId)}:${encodeTagComponent(id)}`;
}

/** Parse a line in `family`'s scoped format; legacy and other families yield null. */
function parseInstanceTag(family: InstanceTagFamily, line: string): InstanceTagRecord | null {
  const prefix = instanceTagPrefix(family);
  const trimmed = line.trim();
  if (!trimmed.startsWith(prefix)) return null;
  const components = trimmed.slice(prefix.length).split(":");
  if (components.length !== 2) return null;
  const instanceId = decodeTagComponent(components[0]);
  const id = decodeTagComponent(components[1]);
  return instanceId && id ? { instanceId, id } : null;
}

function parseObligationActivationTag(line: string): ObligationActivationRecord | null {
  const scoped = parseInstanceTag("obligation-activation", line);
  if (scoped) return scoped;

  // Tags written before scoped ownership are never adopted: a legacy id may
  // contain any delimiter, so it cannot be safely distinguished from a raw
  // instance/id format. Treat it as foreign and leave it untouched.
  const trimmed = line.trim();
  if (trimmed.startsWith(LEGACY_ACTIVATION_TAG_PREFIX)) {
    const id = trimmed.slice(LEGACY_ACTIVATION_TAG_PREFIX.length).trim();
    return id ? { id } : null;
  }
  return null;
}

function activationRecordKey(record: ObligationActivationRecord): string {
  // Length/encoding-safe key: entity IDs permit every delimiter, so raw
  // concatenation could collapse two distinct records during deduplication.
  return `${record.instanceId === undefined ? "legacy" : "scoped"}:${encodeTagComponent(record.instanceId ?? "")}:${encodeTagComponent(record.id)}`;
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

/**
 * `at` schedules to the minute: a job whose time is at most this far ahead may
 * run — and leave the queue — before a re-read of `atq` can see it, so its
 * absence proves nothing. Any job further out than this must still be queued.
 */
const AT_DUE_WINDOW_MS = 60_000;

/**
 * Thrown when `at` reported a job id for a message but a re-read of the queue
 * shows no job under that id carrying the message's tag. The write is not
 * trusted on `at`'s say-so: a message id must never be handed back for a
 * delivery that is not actually queued.
 */
export class AtEnqueueUnconfirmedError extends Error {
  constructor(tag: string, atJobId: string) {
    super(
      `at job ${atJobId} for "${tag}" is not in the queue after scheduling — enqueue unconfirmed`
    );
    this.name = "AtEnqueueUnconfirmedError";
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
  readonly instanceId: string;
  private readonly log: Logger;
  private readonly now: () => number;

  constructor(
    private readonly mutator: CrontabMutator,
    private readonly atIo: AtIo,
    private readonly opts: OsSchedulerOptions
  ) {
    if (!opts.instanceId.trim()) throw new Error("instanceId is required");
    this.instanceId = opts.instanceId;
    // Every record names the instance, so a shared queue's history can be
    // split by writer after the fact.
    this.log = (opts.log ?? nullLogger).child({
      component: "os-scheduler",
      instanceId: opts.instanceId,
    });
    this.now = opts.now ?? Date.now;
  }

  /** The only way this scheduler produces a tag line: `family` + this instance + `id`. */
  private ownedTag(
    family: InstanceTagFamily,
    id: string,
    boundary: InstanceTagBoundary = "start"
  ): string {
    return instanceTag(family, this.instanceId, id, boundary);
  }

  /** The id of an owned tag line, or null for foreign instances, legacy tags and other lines. */
  private ownedId(family: InstanceTagFamily, line: string): string | null {
    const record = parseInstanceTag(family, line);
    return record?.instanceId === this.instanceId ? record.id : null;
  }

  /**
   * A pre-scoping `# mc-wake:<actorId>` block belongs to this instance only
   * when its job line reads this instance's own wake-port file — a path no
   * co-hosted instance shares — so it can be listed, replaced and cancelled
   * here without guessing. Every other legacy wake block is foreign. Legacy
   * wake blocks recur forever and have no boot sweep, so without adoption an
   * upgrade would strand each live wake as a duplicate of its replacement.
   */
  private ownsLegacyWakeBlock(tagLine: string, jobLine: string | undefined): boolean {
    return (
      tagLine.trim().startsWith(LEGACY_WAKE_TAG_PREFIX) &&
      (jobLine ?? "").includes(`$(cat ${this.opts.portFile})`)
    );
  }

  /** The actor id of this instance's wake block starting at `lines[index]`, if any. */
  private ownedWakeActorId(lines: string[], index: number): string | null {
    const tagLine = lines[index];
    const scoped = this.ownedId("wake", tagLine);
    if (scoped !== null) return scoped;
    if (this.ownsLegacyWakeBlock(tagLine, lines[index + 1])) {
      return tagLine.trim().slice(LEGACY_WAKE_TAG_PREFIX.length);
    }
    return null;
  }

  /**
   * Boot audit: name every legacy `# mc-wake:` block this instance declined to
   * adopt. Such a block keeps firing with nothing able to cancel it — it reads
   * another instance's wake-port file, or this instance's under a spelling of
   * `RUSA_HOME` the running process does not use — so it is recorded here,
   * once, where an operator can find the orphan instead of meeting it by its
   * firing. Nothing is written.
   */
  reportUnadoptedLegacyWakeBlocks(): UnadoptedLegacyWakeBlock[] {
    const current = this.mutator.read();
    if (current === "") return [];
    const lines = current.replace(/\n$/, "").split("\n");
    const unadopted: UnadoptedLegacyWakeBlock[] = [];
    for (let index = 0; index < lines.length; index++) {
      const tagLine = lines[index].trim();
      if (!tagLine.startsWith(LEGACY_WAKE_TAG_PREFIX)) continue;
      const jobLine = lines[index + 1] ?? "";
      if (this.ownsLegacyWakeBlock(tagLine, jobLine)) continue;
      const block: UnadoptedLegacyWakeBlock = {
        actorId: tagLine.slice(LEGACY_WAKE_TAG_PREFIX.length),
        portFile: jobLine.match(/\$\(cat ([^)\s]+)\)\/wake"/)?.[1] ?? null,
        cronExpr: jobLine.trim().split(/\s+/).slice(0, 5).join(" "),
      };
      this.log.warn("legacy_wake_block_not_adopted", { tag: tagLine, ...block });
      unadopted.push(block);
    }
    return unadopted;
  }

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
    const kept: string[] = [];
    for (let index = 0; index < lines.length; index++) {
      if (this.ownedWakeActorId(lines, index) === actorId) {
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
        this.ownedTag("wake", actorId),
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
      const actorId = this.ownedWakeActorId(lines, index);
      if (actorId === null) continue;
      const job = lines[index + 1] ?? "";
      const priority = parseWakePriority(job);
      entries.push({
        actorId,
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

  /** Ids of the queued `at` jobs whose script carries exactly `tag`, from a fresh read of the queue. */
  private staleAtIds(tag: string): string[] {
    return this.atJobIdsFor(this.atIo.list(), tag);
  }

  private atJobIdsFor(jobs: { id: string; script: string }[], tag: string): string[] {
    return jobs
      .filter((job) => job.script.split("\n").some((line) => line.trim() === tag))
      .map((job) => job.id);
  }

  /**
   * The one path from this class into `at`: the write is recorded with the tag
   * it carries, so a shared queue's every mutation is attributable to its
   * writer. Nothing here proves the job stayed queued — see
   * {@link confirmAtEnqueue}.
   */
  private scheduleAt(
    family: InstanceTagFamily,
    id: string,
    tag: string,
    script: string,
    date: Date
  ) {
    const atJobId = this.atIo.schedule(script, date);
    this.log.info("at_job_scheduled", { family, id, tag, atJobId, runAt: date.toISOString() });
    return atJobId;
  }

  /** The one path from this class into `atrm`, recorded per job with the tag it was matched by. */
  private removeAtIds(family: InstanceTagFamily, id: string, tag: string, ids: Iterable<string>) {
    for (const atJobId of ids) {
      this.atIo.remove(atJobId);
      this.log.info("at_job_removed", { family, id, tag, atJobId });
    }
  }

  /**
   * Re-read the queue and require the job `at` just reported to be in it with
   * `tag`. A job due within {@link AT_DUE_WINDOW_MS} may legitimately have run
   * already, so its absence is recorded and tolerated; a job further out that
   * is missing was never durably queued, and the caller must not report it as
   * scheduled.
   */
  private confirmAtEnqueue(
    family: InstanceTagFamily,
    id: string,
    tag: string,
    atJobId: string,
    date: Date
  ) {
    const queue = this.atIo.list();
    const fields = { family, id, tag, atJobId, queueSize: queue.length };
    if (this.atJobIdsFor(queue, tag).includes(atJobId)) {
      this.log.info("at_enqueue_confirmed", fields);
      return;
    }
    if (date.getTime() - this.now() <= AT_DUE_WINDOW_MS) {
      this.log.warn("at_enqueue_unconfirmed", {
        ...fields,
        reason: "job due; may already have run",
      });
      return;
    }
    this.log.error("at_enqueue_unconfirmed", { ...fields, reason: "job missing from queue" });
    throw new AtEnqueueUnconfirmedError(tag, atJobId);
  }

  /** The tag/end-tag pair bounding one obligation's managed cron block, scoped to this instance. */
  private activationTags(id: string): { tag: string; endTag: string } {
    return {
      tag: this.ownedTag("obligation-activation", id),
      endTag: this.ownedTag("obligation-activation", id, "end"),
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
      this.removeAtIds("obligation-activation", id, tag, staleAtIds);
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
      const replacementId = this.scheduleAt("obligation-activation", id, tag, script, time.date);
      this.updateCron(tag, endTag, null);
      this.removeAtIds(
        "obligation-activation",
        id,
        tag,
        staleAtIds.filter((staleId) => staleId !== replacementId)
      );
    }
  }

  cancelObligationActivation(id: string): void {
    const { tag, endTag } = this.activationTags(id);
    this.updateCron(tag, endTag, null);
    this.removeAtIds("obligation-activation", id, tag, this.staleAtIds(tag));
  }

  listObligationActivations(): ObligationActivationRecord[] {
    const entries = new Map<string, ObligationActivationRecord>();
    const add = (line: string): void => {
      const record = parseObligationActivationTag(line);
      if (record) entries.set(activationRecordKey(record), record);
    };

    const current = this.mutator.read();
    for (const line of current.split("\n")) {
      add(line);
    }
    for (const job of this.atIo.list()) {
      for (const line of job.script.split("\n")) {
        add(line);
      }
    }
    return Array.from(entries.values());
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
    const deliverAt = new Date(message.deliverAt);
    const staleAtIds = this.staleAtIds(tag);
    const replacementId = this.scheduleAt("message-delivery", message.id, tag, script, deliverAt);
    // `at` printing a job id is not proof the job is queued. The message id is
    // only returned to the sender once a re-read of the queue shows the job; a
    // stale copy stays armed until then, so an unconfirmed write leaves no gap.
    this.confirmAtEnqueue("message-delivery", message.id, tag, replacementId, deliverAt);
    this.removeAtIds(
      "message-delivery",
      message.id,
      tag,
      staleAtIds.filter((staleId) => staleId !== replacementId)
    );
  }

  cancelMessageDelivery(id: string): void {
    const tag = this.messageTag(id);
    this.removeAtIds("message-delivery", id, tag, this.staleAtIds(tag));
  }

  /**
   * Only this instance's jobs: a co-hosted instance's messages and legacy
   * unscoped `# mc-message-delivery:` jobs are foreign, never listed here, so
   * boot reconciliation cannot cancel a recipient it merely does not know.
   */
  listMessageDeliveries(): ScheduledMessage[] {
    const messages = new Map<string, ScheduledMessage>();
    for (const job of this.atIo.list()) {
      const tagLines = job.script
        .split("\n")
        .map((line) => line.trim())
        .filter((line) => line.startsWith(instanceTagPrefix("message-delivery")));
      if (!tagLines.some((line) => this.ownedId("message-delivery", line) !== null)) continue;
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
    return this.ownedTag("message-delivery", id);
  }
}
