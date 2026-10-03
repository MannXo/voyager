import { StorageKeys } from '@/core/types/common';
import {
  buildConversationIdFromUrl,
  buildLegacyConversationIdFromUrl,
  buildRouteConversationIdFromUrl,
  extractConversationIdFromUrl,
} from '@/core/utils/conversationIdentity';
import type { TimelineMarker } from '@/features/timeline/types';

import { getLegacyTurnIndex } from '../fork/turnId';
import {
  type HistoryTimestampStore,
  historyTimestampStore as sharedHistoryTimestampStore,
} from '../timestamp/historyTimestamps';
import { eventBus } from './EventBus';
import { StarredMessagesService } from './StarredMessagesService';
import { TimelineHierarchy } from './TimelineHierarchy';
import { findMatchingStarredMessages } from './starredLookup';
import { resolveStarredDisplay } from './starredResolution';
import type { StarredMessage, StarredMessagesData } from './starredTypes';
import { safeLocalStorageGet, safeLocalStorageSet } from './timelineLocalStorage';

/** Conversation-scoped stars and hierarchy. Rendering never writes storage. */
export class TimelineState {
  readonly conversationId: string;
  readonly hierarchy: TimelineHierarchy;
  markers: TimelineMarker[] = [];
  readonly markerMap = new Map<string, TimelineMarker>();
  private destroyed = false;
  private starred = new Set<string>();
  private starDisplayOverride = new Map<string, boolean>();
  private starStorageIdsByMarkerId = new Map<string, string[]>();
  private onStorage: ((e: StorageEvent) => void) | null = null;
  private onChromeStorageChanged:
    | ((changes: Record<string, chrome.storage.StorageChange>, areaName: string) => void)
    | null = null;
  private eventBusUnsubscribers: Array<() => void> = [];
  constructor(
    private readonly onChange: () => void,
    private readonly url = window.location.href,
    private readonly historyTimestampStore: Pick<
      HistoryTimestampStore,
      'getTurnIdAliases' | 'resolveCanonicalTurnId'
    > = sharedHistoryTimestampStore,
  ) {
    this.conversationId = buildConversationIdFromUrl(url);
    this.hierarchy = new TimelineHierarchy(this.conversationId, url, {
      getMarkers: () => this.markers,
      getStoredTurnIdAliases: (id) => this.getStoredTurnIdAliases(id),
      onChange,
    });
  }
  async init(): Promise<void> {
    if (this.destroyed) return;
    this.listen();
    this.loadStars();
    await this.syncStarredFromService();
    if (this.destroyed) return;
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
      if (!e || e.storageArea !== localStorage) return;
      const expectedKey = this.getStarsStorageKey();
      if (!expectedKey || e.key !== expectedKey) return;
      let nextArr: string[] = [];
      try {
        nextArr = JSON.parse(e.newValue || '[]') || [];
      } catch {
        nextArr = [];
      }
      const nextSet = new Set(nextArr.map(String));
      this.applyStarredIdSet(nextSet, false);
    };
    window.addEventListener('storage', this.onStorage);

    if (typeof chrome !== 'undefined' && chrome.storage?.onChanged) {
      this.onChromeStorageChanged = (changes, areaName) => {
        if (areaName === 'local') {
          const starredChange = changes[StorageKeys.TIMELINE_STARRED_MESSAGES];
          if (starredChange) {
            this.applySharedStarredData(starredChange.newValue as StarredMessagesData | null);
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
        if (conversationId !== this.conversationId) return;

        // Update local starred set
        if (this.starred.has(turnId)) {
          this.starred.delete(turnId);
          this.saveStars();
          this.refreshStars();
        }
      }),
    );

    this.eventBusUnsubscribers.push(
      eventBus.on('starred:added', ({ conversationId, turnId }) => {
        // Only handle events for current conversation
        if (conversationId !== this.conversationId) return;

        // Update local starred set
        if (!this.starred.has(turnId)) {
          this.starred.add(turnId);
          this.saveStars();
          this.refreshStars();
        }
      }),
    );
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
    return this.conversationId ? `geminiTimelineStars:${this.conversationId}` : null;
  }

  private getLegacyStarsStorageKey(): string | null {
    const legacyConversationId = buildLegacyConversationIdFromUrl(this.url);
    return legacyConversationId ? `geminiTimelineStars:${legacyConversationId}` : null;
  }

  private getRouteStarsStorageKey(): string | null {
    const routeConversationId = buildRouteConversationIdFromUrl(this.url);
    return routeConversationId ? `geminiTimelineStars:${routeConversationId}` : null;
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
      markers: this.markers,
      starredIds: this.starred,
      resolveCanonicalId: (storedId) => this.resolveCanonicalTurnId(storedId),
    });
    this.starDisplayOverride = displayByMarkerId;
    this.starStorageIdsByMarkerId = storageIdsByMarkerId;
  }

  isMarkerStarred(markerId: string): boolean {
    const override = this.starDisplayOverride.get(markerId);
    if (override !== undefined) return override;
    return this.starred.has(markerId);
  }

  private getStarStorageIds(markerId: string): string[] {
    return this.starStorageIdsByMarkerId.get(markerId) ?? [markerId];
  }

  private resolveCanonicalTurnId(turnId: string): string | null {
    const nativeConversationId = extractConversationIdFromUrl(this.url);
    if (nativeConversationId) {
      return this.historyTimestampStore.resolveCanonicalTurnId(nativeConversationId, turnId);
    }
    return getLegacyTurnIndex(turnId) === null ? turnId : null;
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

  private applySharedStarredData(data?: StarredMessagesData | null): void {
    if (!this.conversationId) return;

    // Use the same matching rules as syncStarredFromService (init path): stars
    // may live under a legacy/route conversation-id key, and a direct-key-only
    // lookup would wrongly clear this conversation's stars whenever a star
    // changes in another conversation.
    const normalized: StarredMessagesData = { messages: data?.messages ?? {} };
    const matched = findMatchingStarredMessages(normalized, this.conversationId, this.url);
    const nextSet = new Set(matched.messages.map((message) => String(message.turnId)));

    this.applyStarredIdSet(nextSet);
  }

  private async syncStarredFromService(): Promise<void> {
    if (!this.conversationId) return;
    try {
      const data = await StarredMessagesService.getAllStarredMessages();
      if (this.destroyed) return;
      const matched = findMatchingStarredMessages(data, this.conversationId, this.url);

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
        if (this.destroyed) return;
        if (reconciled.length > 0) {
          messages = reconciled;
        }
      }

      const nextSet = new Set(messages.map((message) => String(message.turnId)));

      this.applyStarredIdSet(nextSet);
    } catch (error) {
      console.warn('[Timeline] Failed to sync starred messages from shared storage:', error);
    }
  }

  private getConversationTitle(): string {
    const selected = document
      .querySelector('.gv-folder-conversation-selected .gv-conversation-title')
      ?.textContent?.trim();
    if (selected) return selected;
    const title = document.querySelector('title')?.textContent?.trim();
    if (
      title &&
      !['Gemini', 'Google Gemini', 'Google AI Studio'].includes(title) &&
      !title.startsWith('Gemini -') &&
      !title.startsWith('Google AI Studio -')
    )
      return title;
    for (const selector of [
      'mat-list-item.mdc-list-item--activated [mat-line]',
      'mat-list-item[aria-current="page"] [mat-line]',
      '.conversation-list-item.active .conversation-title',
      '.active-conversation .title',
    ]) {
      const text = document.querySelector(selector)?.textContent?.trim();
      if (text && text !== 'New chat') return text;
    }
    const summary = this.markers[0]?.summary;
    if (summary) return summary.length > 50 ? `${summary.slice(0, 50)}...` : summary;
    const id = new URL(this.url).pathname.match(/\/app\/([a-zA-Z0-9_-]+)/)?.[1];
    return id ? `Conversation ${id.slice(0, 8)}...` : 'Untitled Conversation';
  }

  async toggleStar(turnId: string): Promise<void> {
    const id = String(turnId || '');
    if (!id) return;
    // A mounted `u-N` is only the current DOM-window index. Even when a cache
    // exists, it is not evidence that this node is full-conversation turn N.
    if (getLegacyTurnIndex(id) !== null) return;

    const wasStarred = this.isMarkerStarred(id);
    const marker = this.markerMap.get(id);
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
    if (wasStarred) {
      await Promise.all(
        storageIds.map((storageId) =>
          StarredMessagesService.removeStarredMessage(this.conversationId!, storageId),
        ),
      );
    } else {
      // Add to global storage with full message info
      if (marker) {
        const conversationTitle = this.getConversationTitle();
        const now = Date.now();
        const message: StarredMessage = {
          turnId: id,
          content: marker.summary,
          conversationId: this.conversationId!,
          conversationUrl: this.url,
          conversationTitle,
          starredAt: now,
        };
        await StarredMessagesService.addStarredMessage(message);
      }
    }

    this.refreshStars();
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
    return storageId;
  }

  private saveStars(): void {
    const key = this.getStarsStorageKey();
    if (!key) return;
    safeLocalStorageSet(key, JSON.stringify(Array.from(this.starred)));
  }

  private loadStars(): void {
    this.starred.clear();
    const key = this.getStarsStorageKey();
    if (!key) return;

    const fallbackKeys = [this.getRouteStarsStorageKey(), this.getLegacyStarsStorageKey()].filter(
      (candidate): candidate is string => Boolean(candidate && candidate !== key),
    );

    let raw = safeLocalStorageGet(key);
    if (!raw) {
      for (const fallbackKey of fallbackKeys) {
        raw = safeLocalStorageGet(fallbackKey);
        if (raw) {
          safeLocalStorageSet(key, raw);
          break;
        }
      }
    }
    if (!raw) return;

    try {
      const arr = JSON.parse(raw);
      if (Array.isArray(arr)) {
        arr.forEach((id: unknown) => this.starred.add(String(id)));
      }
    } catch (error) {
      console.warn('[Timeline] Failed to parse starred messages:', error);
    }
  }

  /** Current id plus a legacy alias proved by the complete hNvQHb list. */
  getStoredTurnIdAliases(turnId: string): string[] {
    // This method receives a mounted marker id. Never reinterpret its fallback
    // DOM-window position as a stored full-conversation position.
    if (getLegacyTurnIndex(turnId) !== null) return [];
    const nativeConversationId = extractConversationIdFromUrl(this.url);
    if (!nativeConversationId) return [turnId];
    const aliases = this.historyTimestampStore.getTurnIdAliases(nativeConversationId, turnId);
    if (aliases.length > 0) return aliases;
    return [turnId];
  }
}
