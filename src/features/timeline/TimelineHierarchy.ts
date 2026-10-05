import { buildScopedStorageKey } from '@/core/services/AccountIsolationService';
import { filterTimelineHierarchyByRouteScope } from '@/pages/content/timeline/hierarchyStorage';
import {
  type TimelineHierarchyConversationData,
  type TimelineHierarchyData,
  normalizeTimelineHierarchyData,
} from '@/pages/content/timeline/hierarchyTypes';
import {
  safeLocalStorageGet,
  safeLocalStorageSet,
} from '@/pages/content/timeline/timelineLocalStorage';

import type { TimelineHydration } from './TimelineHydration';
import type { TimelineStoragePolicy } from './TimelineStoragePolicy';
import type { MarkerLevel } from './types';

/** The storage bucket one hydrated outline belongs to. */
interface HierarchyBucket {
  readonly key: string;
  readonly unscopedKey: string;
  /** Gemini's pre-isolation migration reads the unscoped blob behind a missing scoped one. */
  readonly adoptUnscoped: boolean;
  readonly routeUserId: string | null;
}

interface HierarchySave {
  readonly bucket: HierarchyBucket;
  readonly conversationId: string;
  readonly entry: TimelineHierarchyConversationData | null;
}

function keysToRead(bucket: HierarchyBucket): string[] {
  return bucket.key === bucket.unscopedKey || !bucket.adoptUnscoped
    ? [bucket.key]
    : [bucket.key, bucket.unscopedKey];
}

function readBucket(
  bucket: HierarchyBucket,
  values: Record<string, unknown>,
): TimelineHierarchyData {
  if (
    bucket.key === bucket.unscopedKey ||
    !bucket.adoptUnscoped ||
    Object.prototype.hasOwnProperty.call(values, bucket.key)
  )
    return normalizeTimelineHierarchyData(values[bucket.key]);
  return filterTimelineHierarchyByRouteScope(
    normalizeTimelineHierarchyData(values[bucket.unscopedKey]),
    bucket.routeUserId,
  );
}

function hasExtensionStorage(): boolean {
  return typeof chrome !== 'undefined' && !!chrome.storage?.local?.get;
}

/** Replaces one conversation's entry; every other conversation in the bucket is read fresh. */
async function writeConversationEntry({ bucket, conversationId, entry }: HierarchySave) {
  if (!hasExtensionStorage()) return;
  try {
    const values = (await chrome.storage.local.get(keysToRead(bucket))) as Record<string, unknown>;
    const conversations = { ...readBucket(bucket, values).conversations };
    if (entry) conversations[conversationId] = entry;
    else delete conversations[conversationId];
    await chrome.storage.local.set({ [bucket.key]: { conversations } });
  } catch (error) {
    console.warn('[Timeline] Failed to persist timeline hierarchy to extension storage:', error);
  }
}

function accountAttributesChanged(records: readonly MutationRecord[]): boolean {
  return records.some(
    (record) =>
      !!record.attributeName &&
      record.oldValue !== (record.target as Element).getAttribute(record.attributeName),
  );
}

/** Shared level/collapse state and persistence; geometry reads this owner without owning it. */
export class TimelineHierarchy {
  // Saves from every timeline in this page share one queue, so one conversation's
  // read-modify-write never writes back a bucket read before another's save landed.
  private static writes: Promise<void> = Promise.resolve();
  private destroyed = false;
  private markerLevels = new Map<string, MarkerLevel>();
  private collapsedMarkers = new Set<string>();
  /** The resolved account's bucket; null while the account is unresolved or unknown. */
  private bucket: HierarchyBucket | null = null;
  private accountGeneration = 0;
  /** Accepted edits whose writes have not finished; storage snapshots cannot overwrite them. */
  private pendingSaves = 0;
  private accountObserver: MutationObserver | null = null;
  constructor(
    private readonly policy: TimelineStoragePolicy,
    private readonly onChange: () => void,
    private readonly canEdit: (id: string) => boolean,
    private readonly hydration: TimelineHydration,
  ) {}
  private get conversationId(): string {
    return this.policy.conversationId;
  }
  private get url(): string {
    return this.policy.url;
  }
  private get isCurrent(): boolean {
    return !this.destroyed && this.policy.isCurrent();
  }
  private get unscopedKey(): string {
    return this.policy.hierarchy.extensionKey;
  }
  private get mirrorsLegacyKeys(): boolean {
    return this.bucket?.key === this.unscopedKey;
  }

  // ===== Account lifetime =====

  private observeAccount(): void {
    const attributes = this.policy.hierarchy.accountAttributes;
    if (this.accountObserver || this.destroyed || attributes.length === 0) return;
    this.accountObserver = new MutationObserver((records) => {
      if (accountAttributesChanged(records)) this.rebind();
    });
    this.accountObserver.observe(document.documentElement, {
      attributes: true,
      attributeFilter: [...attributes],
      attributeOldValue: true,
    });
  }
  /** Reads mutations the observer has not delivered yet, so no edit or read lands in a stale account. */
  private accountChangedSinceObserved(): boolean {
    return accountAttributesChanged(this.accountObserver?.takeRecords() ?? []);
  }
  /** The account changed: forget its outline and hydrate whichever account is current now. */
  private rebind(): void {
    if (!this.isCurrent) return;
    this.accountGeneration += 1;
    this.bucket = null;
    this.markerLevels.clear();
    this.collapsedMarkers.clear();
    this.hydration.invalidate();
    this.onChange();
    void this.init();
  }
  private async resolveBucket(): Promise<HierarchyBucket | null> {
    try {
      const scope = await this.policy.hierarchy.resolveAccountScope();
      if (scope === 'unknown') return null;
      return {
        key: scope?.accountKey
          ? buildScopedStorageKey(this.unscopedKey, scope.accountKey)
          : this.unscopedKey,
        unscopedKey: this.unscopedKey,
        adoptUnscoped: this.policy.hierarchy.adoptUnscopedHierarchy,
        routeUserId: scope?.routeUserId ?? null,
      };
    } catch (error) {
      console.warn('[Timeline] Failed to resolve timeline hierarchy storage scope:', error);
      return null;
    }
  }

  // ===== Legacy Gemini localStorage =====

  private readLegacyLevels(): Record<string, MarkerLevel> {
    const levels: Record<string, MarkerLevel> = {};
    const key = this.policy.hierarchy.legacyLevelsKey;
    const raw = key ? safeLocalStorageGet(key) : null;
    if (!raw) return levels;
    try {
      const parsed = JSON.parse(raw) as Record<string, unknown>;
      Object.entries(parsed).forEach(([turnId, level]) => {
        if (level === 1 || level === 2 || level === 3) levels[turnId] = level;
      });
    } catch (error) {
      console.warn('[Timeline] Failed to parse legacy marker levels:', error);
    }
    return levels;
  }
  private readLegacyCollapsed(): string[] {
    const key = this.policy.hierarchy.legacyCollapsedKey;
    const raw = key ? safeLocalStorageGet(key) : null;
    if (!raw) return [];
    try {
      const parsed = JSON.parse(raw);
      return Array.isArray(parsed) ? parsed.map((turnId: unknown) => String(turnId)) : [];
    } catch (error) {
      console.warn('[Timeline] Failed to parse legacy collapsed markers:', error);
      return [];
    }
  }
  private readLegacyEntry(): TimelineHierarchyConversationData | null {
    if (!this.conversationId) return null;
    const levels = this.readLegacyLevels();
    const collapsed = this.readLegacyCollapsed();
    if (Object.keys(levels).length === 0 && collapsed.length === 0) return null;
    return { conversationUrl: this.url, levels, collapsed, updatedAt: Date.now() };
  }
  private writeLegacyMirror(): void {
    const { legacyLevelsKey, legacyCollapsedKey } = this.policy.hierarchy;
    if (legacyLevelsKey)
      safeLocalStorageSet(legacyLevelsKey, JSON.stringify(Object.fromEntries(this.markerLevels)));
    if (legacyCollapsedKey)
      safeLocalStorageSet(legacyCollapsedKey, JSON.stringify(Array.from(this.collapsedMarkers)));
  }

  // ===== Persistence =====

  private buildEntry(): TimelineHierarchyConversationData | null {
    if (this.markerLevels.size === 0 && this.collapsedMarkers.size === 0) return null;
    return {
      conversationUrl: this.url,
      levels: Object.fromEntries(this.markerLevels),
      collapsed: Array.from(this.collapsedMarkers),
      updatedAt: Date.now(),
    };
  }
  private applyEntry(entry: TimelineHierarchyConversationData | null): void {
    this.markerLevels.clear();
    this.collapsedMarkers.clear();
    if (!entry) return;
    Object.entries(entry.levels).forEach(([turnId, level]) => this.markerLevels.set(turnId, level));
    entry.collapsed.forEach((turnId) => this.collapsedMarkers.add(turnId));
  }
  /** Captures destination and value now; the write completes even if this timeline is torn down. */
  private enqueueSave(): Promise<void> {
    if (!this.bucket || !this.conversationId) return Promise.resolve();
    const save: HierarchySave = {
      bucket: this.bucket,
      conversationId: this.conversationId,
      entry: this.buildEntry(),
    };
    this.pendingSaves += 1;
    const write = TimelineHierarchy.writes
      .then(() => writeConversationEntry(save))
      .finally(() => {
        this.pendingSaves -= 1;
      });
    TimelineHierarchy.writes = write;
    return write;
  }
  private async load(
    bucket: HierarchyBucket,
    accept: (apply: () => void) => boolean,
  ): Promise<boolean> {
    if (!this.conversationId || !hasExtensionStorage()) {
      return accept(() => this.applyEntry(null));
    }
    // Read after this page's queued saves so a rehydration never shows an outline older than them.
    await TimelineHierarchy.writes;
    const values = (await chrome.storage.local.get(keysToRead(bucket))) as Record<string, unknown>;
    if (!this.isCurrent) return false;
    if (this.accountChangedSinceObserved()) {
      this.rebind();
      return false;
    }
    const stored = readBucket(bucket, values).conversations[this.conversationId] ?? null;
    const legacy = stored ? null : this.readLegacyEntry();
    const accepted = accept(() => {
      this.applyEntry(stored ?? legacy);
      if (stored && this.mirrorsLegacyKeys) this.writeLegacyMirror();
    });
    if (accepted && legacy) await this.enqueueSave();
    return accepted;
  }

  // ===== Edits =====

  private edit(turnId: string, change: (aliases: string[]) => void): void | Promise<void> {
    if (!this.isCurrent || !this.canEdit(turnId)) return;
    if (this.accountChangedSinceObserved()) return this.rebind();
    return this.hydration.edit(
      () => this.init(),
      () => {
        const aliases = this.policy.getStoredTurnIdAliases(turnId);
        if (!this.isCurrent || !this.canEdit(turnId) || !this.bucket || aliases.length === 0)
          return;
        if (this.accountChangedSinceObserved()) return this.rebind();
        change(aliases);
        if (this.mirrorsLegacyKeys) this.writeLegacyMirror();
        void this.enqueueSave();
        this.onChange();
      },
    );
  }
  isMarkerCollapsed(turnId: string): boolean {
    return this.policy
      .getStoredTurnIdAliases(turnId)
      .some((alias) => this.collapsedMarkers.has(alias));
  }
  toggleCollapse(turnId: string): void | Promise<void> {
    return this.edit(turnId, (aliases) => {
      if (aliases.some((alias) => this.collapsedMarkers.has(alias))) {
        aliases.forEach((alias) => this.collapsedMarkers.delete(alias));
      } else {
        this.collapsedMarkers.add(turnId);
      }
    });
  }
  getMarkerLevel(turnId: string): MarkerLevel {
    for (const alias of this.policy.getStoredTurnIdAliases(turnId)) {
      const level = this.markerLevels.get(alias);
      if (level) return level;
    }
    return 1;
  }
  setMarkerLevel(turnId: string, level: MarkerLevel): void | Promise<void> {
    // Converge verified legacy aliases only after a complete outline is available.
    return this.edit(turnId, (aliases) => {
      aliases.forEach((alias) => this.markerLevels.delete(alias));
      if (level !== 1) this.markerLevels.set(turnId, level);
    });
  }

  // ===== Lifecycle =====

  init(): Promise<void> {
    this.observeAccount();
    return this.hydration.read(async (accept) => {
      const generation = this.accountGeneration;
      const bucket = await this.resolveBucket();
      // An account change during resolution belongs to the newer read that rebind started.
      if (generation !== this.accountGeneration || !this.isCurrent) return;
      if (this.accountChangedSinceObserved()) return this.rebind();
      this.bucket = bucket;
      if (!bucket || this.hydration.ready) return;
      try {
        if (await this.load(bucket, accept)) this.onChange();
      } catch (error) {
        console.warn('[Timeline] Failed to load timeline hierarchy from extension storage:', error);
      }
    });
  }
  /** Stops listening and editing; saves already accepted still finish. */
  destroy(): void {
    this.destroyed = true;
    this.accountObserver?.disconnect();
    this.accountObserver = null;
  }
  applyStorageChanges(changes: Record<string, chrome.storage.StorageChange>): void {
    if (!this.isCurrent || !this.bucket || !this.conversationId || this.pendingSaves > 0) return;
    const bucket = this.bucket;
    const change = changes[bucket.key];
    if (!change) return;
    const value: unknown = change.newValue;
    // Unresolved scope or partial data is not evidence that the complete outline was read.
    if (value != null && !isCompleteHierarchySnapshot(value)) return;
    this.hydration.snapshot(() => {
      this.applyEntry(
        readBucket(bucket, { [bucket.key]: value }).conversations[this.conversationId] ?? null,
      );
      if (this.mirrorsLegacyKeys) this.writeLegacyMirror();
      this.onChange();
    });
  }
}

function isCompleteOutline(value: unknown): boolean {
  if (!value || typeof value !== 'object') return false;
  const { levels, collapsed } = value as { levels?: unknown; collapsed?: unknown };
  return (
    !!levels &&
    typeof levels === 'object' &&
    !Array.isArray(levels) &&
    Object.values(levels).every((level) => level === 1 || level === 2 || level === 3) &&
    Array.isArray(collapsed) &&
    collapsed.every((id) => typeof id === 'string')
  );
}

function isCompleteHierarchySnapshot(value: unknown): boolean {
  if (!value || typeof value !== 'object' || !('conversations' in value)) return false;
  const conversations = value.conversations;
  return (
    !!conversations &&
    typeof conversations === 'object' &&
    !Array.isArray(conversations) &&
    Object.values(conversations).every(isCompleteOutline)
  );
}
