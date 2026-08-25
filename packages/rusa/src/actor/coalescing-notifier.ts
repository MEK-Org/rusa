export interface CoalescingNotifierOptions {
  /** The underlying delivery (e.g. post to the error chat). */
  send: (text: string) => void;
  /** First coalescing window after an eager alert (default 30s). */
  baseMs?: number;
  /** Upper bound the window backs off to while failures persist (default 30m). */
  maxMs?: number;
}

const DEFAULT_BASE_MS = 30 * 1000;
const DEFAULT_MAX_MS = 30 * 60 * 1000;

/**
 * Eager-first, then coalescing-with-exponential-backoff notifier. Built for the
 * failure-alert path that once DM'd a human ~14 times in a minute during a
 * rate-limit storm.
 *
 * The contract:
 *  - The first alert (when idle) goes out **immediately** — you learn something
 *    is wrong without delay.
 *  - Further alerts arriving within the current window are **suppressed and
 *    counted**, not sent. At window end, if any were suppressed, one **coalesced
 *    summary** goes out ("…(+N more in the last Ms)") and the window **doubles**
 *    (up to `maxMs`) — so a sustained failure storm costs you at most one message
 *    per ever-growing window instead of one per failure.
 *  - A window that ends with nothing suppressed **resets** the backoff: the mesh
 *    is quiet again, so the next alert is once more eager + at the base window.
 */
export class CoalescingNotifier {
  private readonly send: (text: string) => void;
  private readonly baseMs: number;
  private readonly maxMs: number;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private windowMs: number;
  private suppressed = 0;
  private latest = "";

  constructor(opts: CoalescingNotifierOptions) {
    this.send = opts.send;
    this.baseMs = opts.baseMs ?? DEFAULT_BASE_MS;
    this.maxMs = opts.maxMs ?? DEFAULT_MAX_MS;
    this.windowMs = this.baseMs;
  }

  /** Report an event. Eager when idle; coalesced + counted while in a window. */
  notify(text: string): void {
    if (this.timer === null) {
      this.send(text);
      this.openWindow();
      return;
    }
    this.suppressed += 1;
    this.latest = text;
  }

  /** Cancel any pending flush (shutdown / tests). Does not flush. */
  close(): void {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }

  private openWindow(): void {
    this.timer = setTimeout(() => this.flush(), this.windowMs);
    this.timer.unref?.();
  }

  private flush(): void {
    this.timer = null;
    if (this.suppressed === 0) {
      // Quiet window — reset the backoff and go idle (next notify is eager).
      this.windowMs = this.baseMs;
      return;
    }
    const secs = Math.round(this.windowMs / 1000);
    this.send(`${this.latest}\n\n(+${this.suppressed} more in the last ${secs}s)`);
    this.suppressed = 0;
    this.latest = "";
    this.windowMs = Math.min(this.windowMs * 2, this.maxMs);
    this.openWindow();
  }
}
