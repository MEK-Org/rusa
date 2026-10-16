import { createHash } from "node:crypto";
import { existsSync, readFileSync, renameSync, statSync } from "node:fs";
import type {
  AvailabilityHold,
  AvailabilityHoldOrigin,
  AvailabilityHoldRepository,
  AvailabilityHoldScope,
} from "../db/repositories/availability-hold-repository.js";
import { type HaltState, HaltSwitch } from "./halt-switch.js";
import type { MeshEventInput } from "./mesh-events.js";

/** The longest delay `setTimeout` honors; longer delays fire immediately. */
const MAX_TIMER_DELAY_MS = 2_147_483_647;

export interface SetHoldRequest extends AvailabilityHoldScope {
  origin: AvailabilityHoldOrigin;
  expiry?: string;
  reason?: string;
  createdBy: string;
}

export interface AvailabilityHoldsOptions {
  repo: AvailabilityHoldRepository;
  now?: () => number;
  /** A hold was set: cancel queued starts whose reserved lane it now covers. */
  onHeld?: (holds: AvailabilityHold[]) => void;
  /** An active hold was cleared or expired: replay starts a hold cancelled. */
  onReleased?: (holds: AvailabilityHold[]) => void;
}

/** What one `clear` removed: holds still in force, and records already expired. */
export interface ClearedHolds {
  released: AvailabilityHold[];
  expired: AvailabilityHold[];
}

/**
 * `silent` skips `onHeld`/`onReleased` for a caller that cancels or replays
 * queued runs itself because it reports how many it touched. `origin`
 * narrows a `clear` to rows that origin instituted; chat `/resume` uses it so
 * mesh-instituted holds survive, while the authorized MCP/UI clear omits it
 * and releases every origin on the scope.
 */
export interface HoldChangeOptions {
  silent?: boolean;
  origin?: AvailabilityHoldOrigin;
}

/**
 * Durable provider/model availability holds (#539).
 *
 * Holds take a provider lane, or some of its models, out of model selection
 * without editing any configured pool. Selection asks {@link isHeld} before
 * pacing, so a held entry is never quoted and clearing or expiring the hold
 * restores it from the unchanged pool. Expiry is evaluated on every read; the
 * timer only wakes queued work at the earliest expiry so it does not wait for
 * an unrelated event.
 */
export class AvailabilityHolds {
  private readonly now: () => number;
  private timer: ReturnType<typeof setTimeout> | null = null;

  constructor(private readonly options: AvailabilityHoldsOptions) {
    this.now = options.now ?? Date.now;
  }

  /** True iff an active hold covers `provider`, or `model` on it. */
  isHeld(provider: string, model?: string): boolean {
    return this.options.repo.isHeld(provider, model, this.now());
  }

  /** Holds active right now, ordered by provider with provider-wide holds first. */
  list(): AvailabilityHold[] {
    return this.options.repo.list({ now: this.now() });
  }

  /**
   * Hold a provider, or the listed models on it, replacing any hold with the
   * same scope. An expiry must be in the future.
   */
  set(request: SetHoldRequest, options: HoldChangeOptions = {}): AvailabilityHold[] {
    const now = this.now();
    if (request.expiry !== undefined) {
      const expiry = Date.parse(request.expiry);
      if (!Number.isFinite(expiry)) {
        throw new Error(`invalid availability hold expiry "${request.expiry}"`);
      }
      if (expiry <= now) throw new Error("availability hold expiry must be in the future");
    }
    const stored = this.options.repo.set({
      ...request,
      createdAt: new Date(now).toISOString(),
    });
    this.schedule();
    if (!options.silent) this.options.onHeld?.(stored);
    return stored;
  }

  /**
   * Clear holds on a provider: every hold on it without `models`, otherwise
   * only those model holds. Holds that were still in force are `released`;
   * matching records that had already expired are removed and returned apart,
   * and alone they release nothing, so `onReleased` does not fire for them.
   * `options.origin` narrows the clear to rows that origin instituted.
   */
  clear(scope: AvailabilityHoldScope, options: HoldChangeOptions = {}): ClearedHolds {
    const { origin, ...callbacks } = options;
    const cleared = this.options.repo.clear(scope, origin === undefined ? {} : { origin });
    const now = this.now();
    const released = cleared.filter((hold) => isActiveAt(hold, now));
    const expired = cleared.filter((hold) => !isActiveAt(hold, now));
    this.schedule();
    if (released.length > 0 && !callbacks.silent) this.options.onReleased?.(released);
    return { released, expired };
  }

  /**
   * Clear every hold one origin instituted, whatever its scope — a bare chat
   * `/resume` releases chat holds across all scopes without naming each.
   * Mesh-instituted holds stay in force.
   */
  clearAll(origin: AvailabilityHoldOrigin, options: HoldChangeOptions = {}): ClearedHolds {
    const cleared = this.options.repo.clearAll(origin);
    const now = this.now();
    const released = cleared.filter((hold) => isActiveAt(hold, now));
    const expired = cleared.filter((hold) => !isActiveAt(hold, now));
    this.schedule();
    if (released.length > 0 && !options.silent) this.options.onReleased?.(released);
    return { released, expired };
  }

  /** Arm the expiry timer from the stored holds; call once at startup. */
  start(): void {
    this.schedule();
  }

  stop(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  /** Wake at the earliest future expiry among stored holds. */
  private schedule(): void {
    this.stop();
    const now = this.now();
    const next = this.options.repo
      .list({ now })
      .flatMap((hold) => (hold.expiry === undefined ? [] : [Date.parse(hold.expiry)]))
      .reduce((earliest, expiry) => Math.min(earliest, expiry), Number.POSITIVE_INFINITY);
    if (next === Number.POSITIVE_INFINITY) return;
    const due = next;
    this.timer = setTimeout(
      () => {
        this.timer = null;
        // Every hold that expired since this wake was armed. A late timer also
        // takes holds whose expiry fell between `due` and now, which the
        // re-arm below no longer sees as future.
        const fired = this.now();
        const expired = this.options.repo.list().filter((hold) => {
          if (hold.expiry === undefined) return false;
          const expiry = Date.parse(hold.expiry);
          return expiry >= due && expiry <= fired;
        });
        this.schedule();
        if (fired >= due && expired.length > 0) this.options.onReleased?.(expired);
      },
      Math.min(Math.max(next - now, 0), MAX_TIMER_DELAY_MS)
    );
    this.timer.unref?.();
  }
}

function isActiveAt(hold: AvailabilityHold, now: number): boolean {
  return hold.expiry === undefined || Date.parse(hold.expiry) > now;
}

/**
 * The dashboard header's halt indicator (#908) over the brake and the holds
 * together. `isHalted` lights for either. `haltSnapshot` reports a scope only
 * when one `HaltState` describes exactly what is held: the brake file alone,
 * the global brake (which covers every hold), or, with no brake, holds that
 * form one providers × models product with one expiry. Anything else reports
 * null rather than a scope that is not held. `activeHolds` returns the holds
 * in force now.
 */
export function haltIndicator(
  haltSwitch: Pick<HaltSwitch, "state">,
  activeHolds: () => AvailabilityHold[]
): { isHalted: () => boolean; haltSnapshot: () => HaltState | null } {
  return {
    isHalted: () => haltSwitch.state() !== null || activeHolds().length > 0,
    haltSnapshot: () => {
      const brake = haltSwitch.state();
      const holds = activeHolds();
      if (holds.length === 0) return brake;
      if (brake) return brake.providers?.length || brake.models?.length ? null : brake;
      return holdsAsHaltState(holds);
    },
  };
}

function holdsAsHaltState(holds: AvailabilityHold[]): HaltState | null {
  // Chat and the mesh may hold one scope in two rows; the lane is a single
  // entry, bound by the latest expiry any origin set on it.
  const lanes = new Map<string, AvailabilityHold>();
  for (const hold of holds) {
    const key = `${hold.provider}${hold.model ?? ""}`;
    const existing = lanes.get(key);
    if (!existing || expiryRank(hold.expiry) > expiryRank(existing.expiry)) lanes.set(key, hold);
  }
  const distinct = [...lanes.values()];
  const [first] = distinct;
  if (!first || distinct.some((hold) => hold.expiry !== first.expiry)) return null;
  const providers = [...new Set(distinct.map((hold) => hold.provider))];
  const models = [...new Set(distinct.flatMap((hold) => (hold.model ? [hold.model] : [])))];
  // The lanes are unique, so the holds are the whole product exactly when
  // every one is provider-wide or every one is model-scoped and they number
  // providers × models.
  const product =
    models.length === 0
      ? distinct.length === providers.length
      : distinct.every((hold) => hold.model) &&
        distinct.length === providers.length * models.length;
  if (!product) return null;
  const reason = distinct.every((hold) => hold.reason === first.reason) ? first.reason : "";
  return {
    ...(reason ? { reason } : {}),
    providers,
    ...(models.length ? { models } : {}),
    ...(first.expiry ? { until: first.expiry } : {}),
  };
}

/** Indefinite holds outrank any timestamp: the lane is bound by the last expiry. */
function expiryRank(expiry: string | undefined): number {
  return expiry === undefined ? Number.POSITIVE_INFINITY : Date.parse(expiry);
}

/**
 * One operator-facing line naming everything that identifies a hold: provider,
 * model scope, expiry and reason. `/resume` lists released holds with it, so an
 * indefinite hold never disappears behind a release without being named.
 */
export function describeHold(hold: AvailabilityHold): string {
  const scope = hold.model
    ? `${hold.provider} model ${hold.model}`
    : `${hold.provider} (all models)`;
  const expiry = hold.expiry ? `until ${hold.expiry}` : "until cleared";
  return `${scope}, ${expiry}${hold.reason ? ` — ${hold.reason}` : ""}`;
}

/** The `createdBy` stamped on holds imported from a HALT file. */
export const HALT_FILE_IMPORT_CREATOR = "system:halt-file-import";

export interface ImportScopedHaltFileOptions {
  file: string;
  repo: Pick<AvailabilityHoldRepository, "set">;
  recordEvent: (event: MeshEventInput) => void;
  now?: () => number;
}

/**
 * Move a provider-scoped HALT sentinel into durable holds, then archive it as
 * `HALT.imported-<digest>`, so the holds govern that scope (#539). The digest
 * names each archive by content and mtime, so a later hand-written sentinel
 * never overwrites an earlier archive and a replayed import reuses its name. Left in place, the
 * file would keep holding after a scoped `/resume` cleared the hold, and the
 * next restart would import it again. Returns the stored holds; empty when
 * there was nothing to import.
 *
 * Only an active sentinel that names providers is imported. A bare or
 * plain-text sentinel is the global brake and stays a file; an expired one
 * holds nothing; a models-only one (only writable by hand) has no provider to
 * key a hold on and keeps working as the file brake.
 *
 * A crash between storing the holds and archiving the file is safe to replay.
 * The holds' `createdAt` is the file's mtime, so setting the same scopes again
 * rewrites identical rows, and the event id is derived from the file's bytes
 * and mtime, so the second `record` is ignored.
 */
export function importScopedHaltFile(options: ImportScopedHaltFileOptions): AvailabilityHold[] {
  const { file } = options;
  if (!existsSync(file)) return [];
  const state = new HaltSwitch(file, options.now).state();
  if (!state?.providers?.length) return [];
  const raw = readFileSync(file);
  const mtimeMs = statSync(file).mtimeMs;
  const createdAt = new Date(mtimeMs).toISOString();
  // The imported file is what a scoped chat /halt used to leave behind, and
  // staging's bare /resume deleted it; importing it as chat-origin preserves
  // that release path (#918).
  const holds = state.providers.flatMap((provider) =>
    options.repo.set({
      provider,
      origin: "chat",
      ...(state.models?.length ? { models: state.models } : {}),
      ...(state.until ? { expiry: state.until } : {}),
      reason: state.reason ?? "",
      createdBy: HALT_FILE_IMPORT_CREATOR,
      createdAt,
    })
  );
  const digest = createHash("sha256").update(raw).update(`\0${mtimeMs}`).digest("hex");
  const scope = holds.map((hold) =>
    hold.model ? `${hold.provider}/${hold.model}` : hold.provider
  );
  options.recordEvent({
    id: `availability-hold-import:${digest.slice(0, 32)}`,
    kind: "availability_hold_imported",
    detail: `HALT file imported as hold on ${scope.join(", ")}${state.until ? ` until ${state.until}` : ""}`,
    payload: JSON.stringify({
      reason: state.reason ?? "",
      until: state.until ?? null,
      holds: holds.map((hold) => ({
        provider: hold.provider,
        model: hold.model ?? null,
        expiry: hold.expiry ?? null,
      })),
    }),
  });
  renameSync(file, `${file}.imported-${digest.slice(0, 12)}`);
  return holds;
}
