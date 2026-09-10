import type {
  InboxActorWork,
  InboxAppendInput,
  InboxEntry,
  InboxListOptions,
  InboxPage,
  InboxStore,
  MarkHandledResult,
} from "../actor/inbox-store.js";
import type { InboxRepository } from "../repositories/inbox-repository.js";

/**
 * Adds after-commit advisory notifications to any existing `InboxStore`,
 * including the production SQLite `InboxRepository`, without forking its
 * storage semantics.
 *
 * This is the design branch's stand-in for folding `onItemsAppended` into the
 * interface itself. At implementation time the SQLite repository emits the
 * notification directly from inside its own append transaction and this
 * decorator disappears; wrapping is used here only because this branch changes
 * no existing file.
 *
 * Notification is strictly after the delegate's write returns, so a listener
 * that immediately turns around and reads the store always observes the rows
 * it was told about. Listener failures are contained: an advisory notification
 * must never fail, or retroactively undo, a durable write.
 */
export class NotifyingInboxRepository implements InboxRepository {
  private readonly listeners = new Set<(items: readonly InboxEntry[]) => void>();

  constructor(
    private readonly delegate: InboxStore,
    private readonly onListenerError: (error: unknown) => void = () => {}
  ) {}

  append(entries: InboxAppendInput[]): InboxEntry[] {
    const inserted = this.delegate.append(entries);
    if (inserted.length > 0) this.notify(inserted);
    return inserted;
  }

  onItemsAppended(listener: (items: readonly InboxEntry[]) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  list(actorId: string, options?: InboxListOptions): InboxPage {
    return this.delegate.list(actorId, options);
  }

  read(actorId: string, entryId: string): InboxEntry | null {
    return this.delegate.read(actorId, entryId);
  }

  countUnhandled(actorId: string, options?: { responsiveOnly?: boolean }): number {
    return this.delegate.countUnhandled(actorId, options);
  }

  actorsWithUnhandled(): InboxActorWork[] {
    return this.delegate.actorsWithUnhandled();
  }

  actorsWithUnseen(): InboxActorWork[] {
    return this.delegate.actorsWithUnseen();
  }

  markSeen(actorId: string, seenAt?: Date): InboxEntry[] {
    return this.delegate.markSeen(actorId, seenAt);
  }

  markHandled(
    actorId: string,
    entryIds: string[],
    handledAt?: Date,
    handledNote?: string
  ): MarkHandledResult[] {
    return this.delegate.markHandled(actorId, entryIds, handledAt, handledNote);
  }

  private notify(items: readonly InboxEntry[]): void {
    for (const listener of this.listeners) {
      try {
        listener(items);
      } catch (error) {
        this.onListenerError(error);
      }
    }
  }
}
