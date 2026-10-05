import { createHash } from "node:crypto";
import { existsSync, readFileSync, rmSync, statSync } from "node:fs";
import type {
  AvailabilityHold,
  AvailabilityHoldRepository,
  AvailabilityHoldScope,
} from "../db/repositories/availability-hold-repository.js";
import { HaltSwitch } from "./halt-switch.js";
import type { MeshEventInput } from "./mesh-events.js";

/** The longest delay `setTimeout` honors; longer delays fire immediately. */
const MAX_TIMER_DELAY_MS = 2_147_483_647;

export interface SetHoldRequest extends AvailabilityHoldScope {
  expiry?: string;
  reason?: string;
  createdBy: string;
}

export interface AvailabilityHoldsOptions {
  repo: AvailabilityHoldRepository;
  now?: () => number;
  /** A hold was set: cancel queued starts whose reserved lane it now covers. */
  onHeld?: (holds: AvailabilityHold[]) => void;
  /** A hold was cleared or expired: replay starts a hold cancelled. */
  onReleased?: (holds: AvailabilityHold[]) => void;
}

/**
 * `silent` skips `onHeld`/`onReleased` for a caller that cancels or replays
 * queued runs itself because it reports how many it touched.
 */
export interface HoldChangeOptions {
  silent?: boolean;
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
   * only those model holds. Returns the cleared holds, expired ones included.
   */
  clear(scope: AvailabilityHoldScope, options: HoldChangeOptions = {}): AvailabilityHold[] {
    return this.released(this.options.repo.clear(scope), options);
  }

  /** Clear every hold. Returns the cleared holds, expired ones included. */
  clearAll(options: HoldChangeOptions = {}): AvailabilityHold[] {
    return this.released(this.options.repo.clearAll(), options);
  }

  /** True iff `hold` is still in force (it has no expiry, or it is in the future). */
  isActive(hold: AvailabilityHold): boolean {
    return hold.expiry === undefined || Date.parse(hold.expiry) > this.now();
  }

  /** Arm the expiry timer from the stored holds; call once at startup. */
  start(): void {
    this.schedule();
  }

  stop(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  private released(cleared: AvailabilityHold[], options: HoldChangeOptions): AvailabilityHold[] {
    this.schedule();
    if (cleared.length > 0 && !options.silent) this.options.onReleased?.(cleared);
    return cleared;
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
        const expired = this.options.repo
          .list()
          .filter((hold) => hold.expiry !== undefined && Date.parse(hold.expiry) === due);
        this.schedule();
        if (this.now() >= due && expired.length > 0) this.options.onReleased?.(expired);
      },
      Math.min(Math.max(next - now, 0), MAX_TIMER_DELAY_MS)
    );
    this.timer.unref?.();
  }
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
 * Move a provider-scoped HALT sentinel into durable holds, then remove it, so
 * holds have one source of truth (#539). Returns the stored holds; empty when
 * there was nothing to import.
 *
 * Only an active sentinel that names providers is imported. A bare or
 * plain-text sentinel is the global brake and stays a file; an expired one
 * holds nothing; a models-only one (only writable by hand) has no provider to
 * key a hold on and keeps working as the file brake.
 *
 * A crash between storing the holds and removing the file is safe to replay.
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
  const holds = state.providers.flatMap((provider) =>
    options.repo.set({
      provider,
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
  rmSync(file, { force: true });
  return holds;
}
