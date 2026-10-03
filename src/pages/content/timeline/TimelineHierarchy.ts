import {
  type AccountScope,
  accountIsolationService,
  detectAccountContextFromDocument,
} from '@/core/services/AccountIsolationService';
import { StorageKeys } from '@/core/types/common';
import { TimelineHierarchyGeometry } from '@/features/timeline/TimelineHierarchyGeometry';
import type { MarkerLevel, TimelineMarker } from '@/features/timeline/types';

import {
  getTimelineHierarchyStorageKey,
  getTimelineHierarchyStorageKeysToRead,
  resolveTimelineHierarchyDataForStorageScope,
} from './hierarchyStorage';
import {
  type TimelineHierarchyConversationData,
  getLegacyTimelineCollapsedStorageKey,
  getLegacyTimelineLevelsStorageKey,
} from './hierarchyTypes';
import { safeLocalStorageGet, safeLocalStorageSet } from './timelineLocalStorage';

interface TimelineHierarchyOptions {
  getMarkers: () => TimelineMarker[];
  getStoredTurnIdAliases: (turnId: string) => string[];
  onChange: () => void;
}

/** Owns account-scoped hierarchy persistence, verified-alias edits and collapse geometry. */
export class TimelineHierarchy {
  markerLevelEnabled = false;
  private destroyed = false;
  constructor(
    readonly conversationId: string,
    private readonly url: string,
    private readonly options: TimelineHierarchyOptions,
  ) {}
  private get markers(): TimelineMarker[] {
    return this.options.getMarkers();
  }
  private markerLevels = new Map<string, MarkerLevel>();
  private collapsedMarkers = new Set<string>();
  private timelineHierarchyAccountScope: AccountScope | null = null;
  private timelineHierarchyStorageKey: string = StorageKeys.TIMELINE_HIERARCHY;
  // ===== Marker Level Methods =====

  private getLevelsStorageKey(): string | null {
    return this.conversationId ? getLegacyTimelineLevelsStorageKey(this.conversationId) : null;
  }
  /* Load marker levels from legacy localStorage */
  private loadMarkerLevels(): void {
    this.markerLevels.clear();
    const key = this.getLevelsStorageKey();
    if (!key) return;

    const raw = safeLocalStorageGet(key);
    if (!raw) return;

    try {
      const obj = JSON.parse(raw) as Record<string, unknown>;
      Object.entries(obj).forEach(([turnId, level]) => {
        if (level === 1 || level === 2 || level === 3) {
          this.markerLevels.set(turnId, level);
        }
      });
    } catch (error) {
      console.warn('[Timeline] Failed to parse marker levels:', error);
    }
  }
  /* Save marker levels to legacy localStorage and mirrored extension storage */
  private saveHierarchy(): void {
    if (this.timelineHierarchyStorageKey === StorageKeys.TIMELINE_HIERARCHY) {
      this.persistTimelineHierarchyToLegacyStorage();
    }
    void this.persistTimelineHierarchyToExtensionStorage();
  }
  // ===== Collapsed Markers Methods =====

  private getCollapsedStorageKey(): string | null {
    return this.conversationId ? getLegacyTimelineCollapsedStorageKey(this.conversationId) : null;
  }
  private loadCollapsedMarkers(): void {
    this.collapsedMarkers.clear();
    const key = this.getCollapsedStorageKey();
    if (!key) return;

    const raw = safeLocalStorageGet(key);
    if (!raw) return;

    try {
      const arr = JSON.parse(raw);
      if (Array.isArray(arr)) {
        arr.forEach((id: unknown) => this.collapsedMarkers.add(String(id)));
      }
    } catch (error) {
      console.warn('[Timeline] Failed to parse collapsed markers:', error);
    }
  }
  private hasTimelineHierarchyData(): boolean {
    return this.markerLevels.size > 0 || this.collapsedMarkers.size > 0;
  }
  private buildTimelineHierarchyConversationData(): TimelineHierarchyConversationData | null {
    if (!this.conversationId || !this.hasTimelineHierarchyData()) {
      return null;
    }

    const levels: Record<string, MarkerLevel> = {};
    this.markerLevels.forEach((level, turnId) => {
      levels[turnId] = level;
    });

    return {
      conversationUrl: this.url,
      levels,
      collapsed: Array.from(this.collapsedMarkers),
      updatedAt: Date.now(),
    };
  }
  private buildLegacyTimelineHierarchyConversationData(): TimelineHierarchyConversationData | null {
    if (!this.conversationId) {
      return null;
    }

    const levels: Record<string, MarkerLevel> = {};
    const levelsKey = this.getLevelsStorageKey();
    if (levelsKey) {
      const rawLevels = safeLocalStorageGet(levelsKey);
      if (rawLevels) {
        try {
          const parsedLevels = JSON.parse(rawLevels) as Record<string, unknown>;
          Object.entries(parsedLevels).forEach(([turnId, level]) => {
            if (level === 1 || level === 2 || level === 3) {
              levels[turnId] = level;
            }
          });
        } catch (error) {
          console.warn('[Timeline] Failed to parse legacy marker levels:', error);
        }
      }
    }

    let collapsed: string[] = [];
    const collapsedKey = this.getCollapsedStorageKey();
    if (collapsedKey) {
      const rawCollapsed = safeLocalStorageGet(collapsedKey);
      if (rawCollapsed) {
        try {
          const parsedCollapsed = JSON.parse(rawCollapsed);
          if (Array.isArray(parsedCollapsed)) {
            collapsed = parsedCollapsed.map((turnId: unknown) => String(turnId));
          }
        } catch (error) {
          console.warn('[Timeline] Failed to parse legacy collapsed markers:', error);
        }
      }
    }

    if (Object.keys(levels).length === 0 && collapsed.length === 0) {
      return null;
    }

    return {
      conversationUrl: this.url,
      levels,
      collapsed,
      updatedAt: Date.now(),
    };
  }
  private applyTimelineHierarchyConversationData(
    conversationData: TimelineHierarchyConversationData | null,
  ): void {
    this.markerLevels.clear();
    this.collapsedMarkers.clear();

    if (!conversationData) {
      return;
    }

    Object.entries(conversationData.levels).forEach(([turnId, level]) => {
      this.markerLevels.set(turnId, level);
    });
    conversationData.collapsed.forEach((turnId) => this.collapsedMarkers.add(turnId));
  }
  private async loadTimelineHierarchyStorageContext(): Promise<void> {
    this.timelineHierarchyAccountScope = null;
    this.timelineHierarchyStorageKey = StorageKeys.TIMELINE_HIERARCHY;

    try {
      const context = detectAccountContextFromDocument(this.url, document);
      if (!context.routeUserId && !context.email) {
        return;
      }
      const scope = await accountIsolationService.resolveAccountScope({
        pageUrl: this.url,
        routeUserId: context.routeUserId,
        email: context.email,
      });

      this.timelineHierarchyAccountScope = scope;
      this.timelineHierarchyStorageKey = getTimelineHierarchyStorageKey(scope.accountKey);
    } catch (error) {
      console.warn('[Timeline] Failed to resolve timeline hierarchy storage scope:', error);
      this.timelineHierarchyAccountScope = null;
      this.timelineHierarchyStorageKey = StorageKeys.TIMELINE_HIERARCHY;
    }
  }
  private persistTimelineHierarchyToLegacyStorage(): void {
    const levelsKey = this.getLevelsStorageKey();
    if (levelsKey) {
      const levels: Record<string, MarkerLevel> = {};
      this.markerLevels.forEach((level, turnId) => {
        levels[turnId] = level;
      });
      safeLocalStorageSet(levelsKey, JSON.stringify(levels));
    }

    const collapsedKey = this.getCollapsedStorageKey();
    if (collapsedKey) {
      safeLocalStorageSet(collapsedKey, JSON.stringify(Array.from(this.collapsedMarkers)));
    }
  }
  private async loadTimelineHierarchyFromExtensionStorage(): Promise<void> {
    if (!this.conversationId || typeof chrome === 'undefined' || !chrome.storage?.local?.get) {
      return;
    }

    try {
      const storageValues = (await chrome.storage.local.get(
        getTimelineHierarchyStorageKeysToRead(this.timelineHierarchyAccountScope?.accountKey),
      )) as Record<string, unknown>;
      if (this.destroyed) return;
      const data = resolveTimelineHierarchyDataForStorageScope(
        storageValues,
        this.timelineHierarchyAccountScope?.accountKey,
        this.timelineHierarchyAccountScope?.routeUserId ?? null,
      );
      const conversationData = data.conversations[this.conversationId] || null;

      if (conversationData) {
        this.applyTimelineHierarchyConversationData(conversationData);
        if (this.timelineHierarchyStorageKey === StorageKeys.TIMELINE_HIERARCHY) {
          this.persistTimelineHierarchyToLegacyStorage();
        }
        return;
      }

      if (this.timelineHierarchyStorageKey !== StorageKeys.TIMELINE_HIERARCHY) {
        const legacyConversationData = this.buildLegacyTimelineHierarchyConversationData();
        if (legacyConversationData) {
          this.applyTimelineHierarchyConversationData(legacyConversationData);
          await this.persistTimelineHierarchyToExtensionStorage();
          return;
        }
      }

      if (this.hasTimelineHierarchyData()) {
        await this.persistTimelineHierarchyToExtensionStorage();
      }
    } catch (error) {
      console.warn('[Timeline] Failed to load timeline hierarchy from extension storage:', error);
    }
  }
  private async persistTimelineHierarchyToExtensionStorage(): Promise<void> {
    if (!this.conversationId || typeof chrome === 'undefined' || !chrome.storage?.local?.get) {
      return;
    }

    try {
      const storageValues = (await chrome.storage.local.get(
        getTimelineHierarchyStorageKeysToRead(this.timelineHierarchyAccountScope?.accountKey),
      )) as Record<string, unknown>;
      const existing = resolveTimelineHierarchyDataForStorageScope(
        storageValues,
        this.timelineHierarchyAccountScope?.accountKey,
        this.timelineHierarchyAccountScope?.routeUserId ?? null,
      );
      const conversations = { ...existing.conversations };
      const currentConversationData = this.buildTimelineHierarchyConversationData();

      if (currentConversationData) {
        conversations[this.conversationId] = currentConversationData;
      } else {
        delete conversations[this.conversationId];
      }

      await chrome.storage.local.set({
        [this.timelineHierarchyStorageKey]: { conversations },
      });
    } catch (error) {
      console.warn('[Timeline] Failed to persist timeline hierarchy to extension storage:', error);
    }
  }
  isMarkerCollapsed(turnId: string): boolean {
    return this.options
      .getStoredTurnIdAliases(turnId)
      .some((alias) => this.collapsedMarkers.has(alias));
  }
  toggleCollapse(turnId: string): void {
    const aliases = this.options.getStoredTurnIdAliases(turnId);
    if (aliases.length === 0) return;
    if (aliases.some((alias) => this.collapsedMarkers.has(alias))) {
      aliases.forEach((alias) => this.collapsedMarkers.delete(alias));
    } else {
      this.collapsedMarkers.add(turnId);
    }
    this.saveHierarchy();
    this.options.onChange();
  }
  private readonly geometry = new TimelineHierarchyGeometry(
    () => this.markers,
    (id) => this.getMarkerLevel(id),
    (id) => this.isMarkerCollapsed(id),
  );
  getHiddenMarkerIndices(): Set<number> {
    this.geometry.markerLevelEnabled = this.markerLevelEnabled;
    return this.geometry.getHiddenMarkerIndices();
  }
  calculateCollapsedPositions(
    hidden: Set<number>,
    pad: number,
    usable: number,
  ): {
    desiredY: number[];
    effectiveBaseNs: number[];
  } {
    return this.geometry.calculateCollapsedPositions(hidden, pad, usable);
  }
  canCollapseMarker(turnId: string): boolean {
    return this.geometry.canCollapseMarker(turnId);
  }
  getMarkerLevel(turnId: string): MarkerLevel {
    for (const alias of this.options.getStoredTurnIdAliases(turnId)) {
      const level = this.markerLevels.get(alias);
      if (level) return level;
    }
    return 1;
  }
  setMarkerLevel(turnId: string, level: MarkerLevel): void {
    // A user edit is a safe point to converge a verified legacy alias onto the
    // canonical server id. Delete every known representation first so reset to
    // level 1 cannot be shadowed by an old u-N entry.
    const aliases = this.options.getStoredTurnIdAliases(turnId);
    if (aliases.length === 0) return;
    aliases.forEach((alias) => this.markerLevels.delete(alias));
    if (level !== 1) {
      this.markerLevels.set(turnId, level);
    }
    this.saveHierarchy();
    this.options.onChange();
  }
  async init(): Promise<void> {
    await this.loadTimelineHierarchyStorageContext();
    if (this.destroyed) return;
    if (this.timelineHierarchyStorageKey === StorageKeys.TIMELINE_HIERARCHY) {
      this.loadMarkerLevels();
      this.loadCollapsedMarkers();
    }
    await this.loadTimelineHierarchyFromExtensionStorage();
  }
  destroy(): void {
    this.destroyed = true;
  }
  applyStorageChanges(changes: Record<string, chrome.storage.StorageChange>): void {
    const timelineHierarchyChange = changes[this.timelineHierarchyStorageKey];
    if (timelineHierarchyChange && this.conversationId) {
      const data = resolveTimelineHierarchyDataForStorageScope(
        {
          [this.timelineHierarchyStorageKey]: timelineHierarchyChange.newValue,
        },
        this.timelineHierarchyAccountScope?.accountKey,
        this.timelineHierarchyAccountScope?.routeUserId ?? null,
      );
      const conversationData = data.conversations[this.conversationId] || null;
      this.applyTimelineHierarchyConversationData(conversationData);
      if (this.timelineHierarchyStorageKey === StorageKeys.TIMELINE_HIERARCHY) {
        this.persistTimelineHierarchyToLegacyStorage();
      }
      this.options.onChange();
    }
  }
}
