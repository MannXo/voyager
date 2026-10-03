import { StorageKeys } from '@/core/types/common';
import { eventBus } from '@/pages/content/timeline/EventBus';
import { StarredMessagesService } from '@/pages/content/timeline/StarredMessagesService';
import { findMatchingStarredMessages } from '@/pages/content/timeline/starredLookup';
import { resolveStarredDisplay } from '@/pages/content/timeline/starredResolution';
import type { StarredMessage, StarredMessagesData } from '@/pages/content/timeline/starredTypes';
import {
  safeLocalStorageGet,
  safeLocalStorageSet,
} from '@/pages/content/timeline/timelineLocalStorage';

import { TimelineHierarchy } from './TimelineHierarchy';
import type { TimelineStoragePolicy } from './TimelineStoragePolicy';
import type { TimelineMarker } from './types';

/** Conversation-scoped stars and hierarchy. Rendering never writes storage. */
export class TimelineState {
  readonly conversationId: string;
  readonly hierarchy: TimelineHierarchy;
  markers: TimelineMarker[] = [];
  readonly markerMap = new Map<string, TimelineMarker>();
  private destroyed = false;
  private starred = new Set<string>();
  private starHydrated = false;
  private starRevision = 0;
  private localPrimaryPresent = false;
  private pendingStarEdits = new Map<string, boolean>();
  private starDisplayOverride = new Map<string, boolean>();
  private starStorageIdsByMarkerId = new Map<string, string[]>();
  private onStorage: ((e: StorageEvent) => void) | null = null;
  private onChromeStorageChanged:
    | ((changes: Record<string, chrome.storage.StorageChange>, areaName: string) => void)
    | null = null;
  private eventBusUnsubscribers: Array<() => void> = [];
  constructor(
    private readonly onChange: () => void,
    readonly policy: TimelineStoragePolicy,
  ) {
    this.conversationId = policy.conversationId;
    this.hierarchy = new TimelineHierarchy(policy, onChange, (id) => this.canEdit(id));
  }
  private get url(): string {
    return this.policy.url;
  }
  private get isCurrent(): boolean {
    return !this.destroyed && this.policy.isCurrent();
  }
  private canEdit(id: string): boolean {
    return this.policy.canEdit(this.markerMap.get(id), id);
  }
  private initPromise: Promise<void> | null = null;
  private starRead: Promise<void> | null = null;
  init(): Promise<void> {
    return (this.initPromise ??= this.initialize());
  }
  private async initialize(): Promise<void> {
    if (!this.isCurrent) return;
    this.listen();
    this.loadStars();
    if (this.policy.stars.source === 'local') this.refreshStars();
    this.starRead = this.syncStarredFromService();
    await this.starRead;
    if (!this.isCurrent) return;
    await this.hierarchy.init();
  }
  replaceMarkers(markers: TimelineMarker[]): void {
    this.markers = markers;
    this.markerMap.clear();
    for (const marker of markers) this.markerMap.set(marker.id, marker);
    this.recomputeStarredDisplay();
    for (const marker of markers) marker.starred = this.isMarkerStarred(marker.id);
  }
  private listen(): void {
    this.onStorage = (e: StorageEvent) => {
      if (!this.isCurrent || !e || e.storageArea !== localStorage) return;
      if (
        'localKey' in this.policy.hierarchy &&
        (e.key === null || e.key === this.policy.hierarchy.localKey)
      ) {
        this.hierarchy.loadLocalHierarchy();
        this.onChange();
      }
      const expectedKey = this.getStarsStorageKey();
      if (
        !expectedKey ||
        (e.key !== expectedKey && !(e.key === null && this.policy.stars.source === 'local'))
      )
        return;
      let nextArr: unknown = [];
      try {
        nextArr = JSON.parse(e.newValue || '[]');
      } catch {
        /* Invalid host data is an empty snapshot. */
      }
      const nextSet = new Set(Array.isArray(nextArr) ? nextArr.map(String) : []);
      this.starRevision += 1;
      this.applyStarredIdSet(nextSet, false);
    };
    window.addEventListener('storage', this.onStorage);

    if (typeof chrome !== 'undefined' && chrome.storage?.onChanged) {
      this.onChromeStorageChanged = (changes, areaName) => {
        if (areaName === 'local' && this.isCurrent) {
          const starredChange = changes[StorageKeys.TIMELINE_STARRED_MESSAGES];
          if (starredChange && this.policy.stars.libraryMirror) {
            this.applySharedStarredData(starredChange.newValue);
          }

          this.hierarchy.applyStorageChanges(changes);
        }
      };
      chrome.storage.onChanged.addListener(this.onChromeStorageChanged);
    }

    // Subscribe to EventBus for cross-component starred state synchronization
    this.eventBusUnsubscribers.push(
      eventBus.on('starred:removed', ({ conversationId, turnId }) => {
        // Only handle events for current conversation
        if (
          !this.isCurrent ||
          !this.policy.stars.libraryMirror ||
          conversationId !== this.conversationId
        )
          return;

        this.applyStarDelta(turnId, false);
      }),
    );

    this.eventBusUnsubscribers.push(
      eventBus.on('starred:added', ({ conversationId, turnId }) => {
        // Only handle events for current conversation
        if (
          !this.isCurrent ||
          !this.policy.stars.libraryMirror ||
          conversationId !== this.conversationId
        )
          return;

        this.applyStarDelta(turnId, true);
      }),
    );
  }
  private applyStarDelta(turnId: string, added: boolean): void {
    const pending = this.policy.stars.source === 'local' && !this.starHydrated;
    // A partial EventBus delta cannot seed a complete primary before the legacy/library read settles.
    if (pending) this.pendingStarEdits.set(turnId, added);
    if (this.starred.has(turnId) === added) return;
    if (!pending) this.starRevision += 1;
    if (added) this.starred.add(turnId);
    else this.starred.delete(turnId);
    if (!pending) this.saveStars();
    this.refreshStars();
  }
  destroy(): void {
    this.destroyed = true;
    this.hierarchy.destroy();
    if (this.onStorage) window.removeEventListener('storage', this.onStorage);
    if (this.onChromeStorageChanged)
      chrome.storage.onChanged.removeListener(this.onChromeStorageChanged);
    this.eventBusUnsubscribers.forEach((unsubscribe) => unsubscribe());
    this.eventBusUnsubscribers = [];
  }
  private getStarsStorageKey(): string | null {
    return this.policy.stars.key;
  }
  private areStarredSetsEqual(a: Set<string>, b: Set<string>): boolean {
    if (a.size !== b.size) return false;
    for (const value of a) {
      if (!b.has(value)) return false;
    }
    return true;
  }

  /**
   * Recompute which mounted turn each stored star belongs to. Cheap enough to
   * run on every star/marker change; never touches storage.
   */
  private recomputeStarredDisplay(): void {
    const { displayByMarkerId, storageIdsByMarkerId } = resolveStarredDisplay({
      markers: this.markers.map((marker) => ({
        id: this.policy.resolveCanonicalTurnId(marker.id) ?? marker.id,
      })),
      starredIds: this.starred,
      resolveCanonicalId: this.policy.resolveCanonicalTurnId,
    });
    this.starDisplayOverride.clear();
    this.starStorageIdsByMarkerId.clear();
    for (const marker of this.markers) {
      const canonical = this.policy.resolveCanonicalTurnId(marker.id) ?? marker.id;
      this.starDisplayOverride.set(marker.id, displayByMarkerId.get(canonical) ?? false);
      const storageIds = storageIdsByMarkerId.get(canonical);
      if (storageIds) this.starStorageIdsByMarkerId.set(marker.id, storageIds);
    }
  }

  isMarkerStarred(markerId: string): boolean {
    const override = this.starDisplayOverride.get(markerId);
    if (override !== undefined) return override;
    return this.starred.has(markerId);
  }

  private getStarStorageIds(markerId: string): string[] {
    return this.starStorageIdsByMarkerId.get(markerId) ?? [markerId];
  }

  /** Recompute star ownership and repaint every marker to match. */
  refreshStars(): void {
    this.recomputeStarredDisplay();
    for (const marker of this.markers) {
      const want = this.isMarkerStarred(marker.id);
      if (marker.starred !== want) {
        marker.starred = want;
      }
    }
    this.onChange();
  }

  private applyStarredIdSet(nextSet: Set<string>, persistLocal = true): void {
    if (this.areStarredSetsEqual(this.starred, nextSet)) {
      this.refreshStars();
      return;
    }

    this.starred = new Set(nextSet);

    if (persistLocal) this.saveStars();

    this.refreshStars();
  }

  private applySharedStarredData(value: unknown): void {
    if (!this.conversationId) return;
    // Only a removed key or a complete valid library snapshot may replace persisted stars.
    if (value != null) {
      if (typeof value !== 'object' || !('messages' in value)) return;
      const messages = value.messages;
      if (
        !messages ||
        typeof messages !== 'object' ||
        Array.isArray(messages) ||
        !Object.values(messages).every(
          (entries) =>
            Array.isArray(entries) &&
            entries.every(
              (message: unknown) =>
                typeof message === 'object' &&
                message !== null &&
                'turnId' in message &&
                typeof message.turnId === 'string',
            ),
        )
      )
        return;
    }
    const data = value as StarredMessagesData | null | undefined;

    // Use the same matching rules as syncStarredFromService (init path): stars
    // may live under a legacy/route conversation-id key, and a direct-key-only
    // lookup would wrongly clear this conversation's stars whenever a star
    // changes in another conversation.
    this.starRevision += 1;
    this.starHydrated = true;
    this.pendingStarEdits.clear();
    const normalized: StarredMessagesData = { messages: data?.messages ?? {} };
    const matched = this.matchLibrary(normalized);
    const nextSet = new Set(matched.messages.map((message) => String(message.turnId)));

    this.applyStarredIdSet(nextSet);
  }

  private matchLibrary(data: StarredMessagesData): {
    messages: StarredMessage[];
    sourceConversationIds: string[];
  } {
    return this.policy.stars.matchLegacyConversations
      ? findMatchingStarredMessages(data, this.conversationId, this.url)
      : {
          messages: data.messages[this.conversationId] ?? [],
          sourceConversationIds: [this.conversationId],
        };
  }
  private async syncStarredFromService(): Promise<void> {
    if (!this.conversationId || !this.policy.stars.libraryMirror) {
      this.starHydrated = true;
      return;
    }
    const revision = this.starRevision;
    try {
      const data = this.policy.stars.matchLegacyConversations
        ? await StarredMessagesService.getAllStarredMessages()
        : {
            messages: {
              [this.conversationId]: await StarredMessagesService.getStarredMessagesForConversation(
                this.conversationId,
              ),
            },
          };
      if (!this.isCurrent) return;
      const matched = this.matchLibrary(data);

      let messages = matched.messages;
      const needsReconcile = matched.sourceConversationIds.some(
        (sourceConversationId) => sourceConversationId !== this.conversationId,
      );

      if (needsReconcile) {
        const reconciled = await StarredMessagesService.reconcileConversationIds(
          this.conversationId,
          matched.sourceConversationIds,
          this.url,
        );
        if (!this.isCurrent) return;
        if (reconciled.length > 0) {
          messages = reconciled;
        }
      }

      this.starHydrated = true;
      if (revision !== this.starRevision) return;
      const nextSet = new Set(messages.map((message) => String(message.turnId)));
      if (this.policy.stars.source === 'local' && !this.localPrimaryPresent) {
        // The first edit must retain both historical local IDs and the Saved Library mirror.
        for (const id of this.starred) nextSet.add(id);
        for (const [id, added] of this.pendingStarEdits) {
          if (added) nextSet.add(id);
          else nextSet.delete(id);
        }
        this.applyStarredIdSet(nextSet, false);
      } else if (this.policy.stars.source === 'library' || !this.localStarsLoaded) {
        this.applyStarredIdSet(nextSet);
      }
      if (this.pendingStarEdits.size > 0) {
        this.pendingStarEdits.clear();
        this.saveStars();
      }
    } catch (error) {
      console.warn('[Timeline] Failed to sync starred messages from shared storage:', error);
    }
  }

  async toggleStar(turnId: string): Promise<void> {
    const id = String(turnId || '');
    if (!id) return;
    // A mounted `u-N` is only the current DOM-window index. Even when a cache
    // exists, it is not evidence that this node is full-conversation turn N.
    if (!this.isCurrent || !this.canEdit(id)) return;

    const marker = this.markerMap.get(id);
    // A press captures its message before an initial read can yield to a route or DOM change.
    const summary = marker?.summary;
    const conversationTitle = this.policy.getConversationTitle(this.markers);
    if (this.starRead) await this.starRead;
    if (!this.isCurrent || !this.policy.canEdit(marker, id) || !this.starHydrated) return;
    const wasStarred = this.isMarkerStarred(id);
    // A stable marker may represent both its current server-id record and an
    // older verified positional alias. Removing the star clears both records.
    const storageIds = wasStarred ? this.getStarStorageIds(id) : [id];

    if (wasStarred) {
      storageIds.forEach((storageId) => {
        this.starred.delete(storageId);
      });
    } else {
      this.starred.add(id);
    }

    this.saveStars();

    // Update global starred messages service
    if (wasStarred && this.policy.stars.libraryMirror) {
      await Promise.all(
        storageIds.map((storageId) =>
          StarredMessagesService.removeStarredMessage(this.conversationId!, storageId),
        ),
      );
    } else if (!wasStarred) {
      // Add to global storage with full message info
      if (marker && this.policy.stars.libraryMirror) {
        const now = Date.now();
        const message: StarredMessage = {
          turnId: id,
          content: summary ?? '',
          conversationId: this.conversationId!,
          conversationUrl: this.url,
          conversationTitle,
          starredAt: now,
        };
        await StarredMessagesService.addStarredMessage(message);
      }
    }

    if (this.isCurrent) this.refreshStars();
  }

  /**
   * Resolve which mounted marker currently carries a stored star. Used by
   * `#gv-turn-<id>` deep links, whose ids come from storage and may have been
   * relocated onto a different index.
   */
  resolveMarkerIdForStorageId(storageId: string): string {
    for (const [markerId, ids] of this.starStorageIdsByMarkerId) {
      if (ids.includes(storageId)) return markerId;
    }
    const canonical = this.policy.resolveCanonicalTurnId(storageId);
    if (!canonical) return storageId;
    return (
      this.markers.find((marker) => this.policy.resolveCanonicalTurnId(marker.id) === canonical)
        ?.id ?? storageId
    );
  }

  private saveStars(): void {
    const key = this.getStarsStorageKey();
    if (!key) return;
    safeLocalStorageSet(key, JSON.stringify(Array.from(this.starred)));
  }

  private localStarsLoaded = false;
  private loadStars(): void {
    this.starred.clear();
    const key = this.getStarsStorageKey();
    if (!key) return;
    let raw = safeLocalStorageGet(key);
    this.localPrimaryPresent = raw !== null;
    if (!raw) {
      for (const fallbackKey of this.policy.stars.legacyKeys) {
        raw = safeLocalStorageGet(fallbackKey);
        if (raw) {
          if (this.policy.stars.copyLegacy) safeLocalStorageSet(key, raw);
          break;
        }
      }
    }
    if (!raw) return;
    try {
      const arr: unknown = JSON.parse(raw);
      if (
        Array.isArray(arr) &&
        (this.policy.stars.source === 'library' || arr.every((id) => typeof id === 'string'))
      ) {
        this.localStarsLoaded = true;
        arr.forEach((id: unknown) => this.starred.add(String(id)));
      }
    } catch (error) {
      console.warn('[Timeline] Failed to parse starred messages:', error);
    }
  }

  getStoredTurnIdAliases(turnId: string): string[] {
    return this.policy.getStoredTurnIdAliases(turnId);
  }
}
