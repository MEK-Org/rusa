import type {
  AvailabilityHold,
  AvailabilityHoldRepository,
  AvailabilityHoldScope,
} from "../db/repositories/availability-hold-repository.js";

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
  set(request: SetHoldRequest): AvailabilityHold[] {
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
    this.options.onHeld?.(stored);
    return stored;
  }

  /**
   * Clear holds on a provider: every hold on it without `models`, otherwise
   * only those model holds. Returns the cleared holds, expired ones included.
   */
  clear(scope: AvailabilityHoldScope): AvailabilityHold[] {
    return this.released(this.options.repo.clear(scope));
  }

  /** Clear every hold. Returns the cleared holds, expired ones included. */
  clearAll(): AvailabilityHold[] {
    return this.released(this.options.repo.clearAll());
  }

  /** Arm the expiry timer from the stored holds; call once at startup. */
  start(): void {
    this.schedule();
  }

  stop(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  private released(cleared: AvailabilityHold[]): AvailabilityHold[] {
    this.schedule();
    if (cleared.length > 0) this.options.onReleased?.(cleared);
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
