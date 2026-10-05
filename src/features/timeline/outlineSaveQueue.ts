import type { TimelineHierarchyConversationData } from '@/pages/content/timeline/hierarchyTypes';

type OutlineEntry = TimelineHierarchyConversationData | null;

/** One accepted per-turn edit, applied to whatever entry storage holds when it is written. */
export type OutlineChange = (entry: OutlineEntry) => OutlineEntry;

interface QueuedChange {
  readonly apply: OutlineChange;
  /** queued → submitted (its storage write has started) → written. */
  stage: 'queued' | 'submitted' | 'written';
}

/**
 * Page-wide owner of accepted outline edits, keyed by storage bucket and conversation, so a
 * remounted timeline sees edits an earlier session accepted but has not yet written.
 */
class OutlineSaveQueue {
  private tail: Promise<void> = Promise.resolve();
  private readonly changes = new Map<string, QueuedChange[]>();
  private readonly listeners = new Map<string, Set<() => void>>();

  /** The stored entry as this page will leave it once its accepted changes are written. */
  overlay(key: string, entry: OutlineEntry): OutlineEntry {
    return (this.changes.get(key) ?? []).reduce((current, change) => change.apply(current), entry);
  }

  subscribe(key: string, listener: () => void): () => void {
    const listeners = this.listeners.get(key) ?? new Set();
    listeners.add(listener);
    this.listeners.set(key, listeners);
    return () => {
      listeners.delete(listener);
      if (listeners.size === 0) this.listeners.delete(key);
    };
  }

  /**
   * A storage event follows the write that caused it, so submitted changes are in that snapshot
   * or about to be echoed by their own event; queued changes stay overlaid.
   */
  retireOnStorageEvent(key: string): void {
    this.remove(key, (change) => change.stage !== 'queued');
  }

  /** Call before a storage read: the returned function retires changes written before it began. */
  beginRead(key: string): () => void {
    const written = new Set(
      (this.changes.get(key) ?? []).filter((change) => change.stage === 'written'),
    );
    return () => this.remove(key, (change) => written.has(change));
  }

  /** Serializes every outline write in the page; each re-reads storage before applying its change. */
  enqueue(
    key: string,
    apply: OutlineChange,
    write: (apply: OutlineChange, submit: () => void) => Promise<boolean>,
  ): Promise<void> {
    const change: QueuedChange = { apply, stage: 'queued' };
    this.changes.set(key, [...(this.changes.get(key) ?? []), change]);
    this.notify(key);
    const run = this.tail.then(async () => {
      const written = await write(apply, () => {
        change.stage = 'submitted';
      });
      if (written) {
        change.stage = 'written';
        return;
      }
      // A failed write is not in storage, so the outline must stop showing it.
      this.remove(key, (queued) => queued === change);
      this.notify(key);
    });
    this.tail = run;
    return run;
  }

  private remove(key: string, retire: (change: QueuedChange) => boolean): void {
    const remaining = (this.changes.get(key) ?? []).filter((change) => !retire(change));
    if (remaining.length > 0) this.changes.set(key, remaining);
    else this.changes.delete(key);
  }

  private notify(key: string): void {
    this.listeners.get(key)?.forEach((listener) => listener());
  }
}

export const outlineSaveQueue = new OutlineSaveQueue();
