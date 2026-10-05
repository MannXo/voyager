import { type AccountScope, buildScopedStorageKey } from '@/core/services/AccountIsolationService';
import { filterTimelineHierarchyByRouteScope } from '@/pages/content/timeline/hierarchyStorage';
import {
  type TimelineHierarchyConversationData,
  normalizeTimelineHierarchyData,
} from '@/pages/content/timeline/hierarchyTypes';
import {
  safeLocalStorageGet,
  safeLocalStorageSet,
} from '@/pages/content/timeline/timelineLocalStorage';

import type { TimelineHydration } from './TimelineHydration';
import type { TimelineStoragePolicy } from './TimelineStoragePolicy';
import type { MarkerLevel } from './types';

/** Shared level/collapse state and persistence; geometry reads this owner without owning it. */
export class TimelineHierarchy {
  private destroyed = false;
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
  private markerLevels = new Map<string, MarkerLevel>();
  private collapsedMarkers = new Set<string>();
  private timelineHierarchyAccountScope: Pick<AccountScope, 'routeUserId'> | null = null;
  private timelineHierarchyStorageKey = '';
  private get unscopedKey(): string {
    return this.policy.hierarchy.extensionKey;
  }
  private get extensionKeysToRead(): string[] {
    return this.timelineHierarchyStorageKey === this.unscopedKey
      ? [this.unscopedKey]
      : [this.timelineHierarchyStorageKey, this.unscopedKey];
  }
  private resolveStoredHierarchy(values: Record<string, unknown>) {
    if (
      this.timelineHierarchyStorageKey === this.unscopedKey ||
      Object.prototype.hasOwnProperty.call(values, this.timelineHierarchyStorageKey)
    )
      return normalizeTimelineHierarchyData(values[this.timelineHierarchyStorageKey]);
    return filterTimelineHierarchyByRouteScope(
      normalizeTimelineHierarchyData(values[this.unscopedKey]),
      this.timelineHierarchyAccountScope?.routeUserId,
    );
  }
  // ===== Marker Level Methods =====

  private getLevelsStorageKey(): string | null {
    return this.policy.hierarchy.legacyLevelsKey;
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
    if (!this.hydration.ready) return;
    if (this.timelineHierarchyStorageKey === this.unscopedKey) {
      this.persistTimelineHierarchyToLegacyStorage();
    }
    void this.persistTimelineHierarchyToExtensionStorage();
  }
  // ===== Collapsed Markers Methods =====

  private getCollapsedStorageKey(): string | null {
    return this.policy.hierarchy.legacyCollapsedKey;
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
  private async loadTimelineHierarchyStorageContext(): Promise<boolean> {
    if (this.timelineHierarchyStorageKey) return true;
    try {
      const scope = await this.policy.hierarchy.resolveAccountScope();
      if (!this.isCurrent) return false;
      this.timelineHierarchyAccountScope = scope;
      this.timelineHierarchyStorageKey = scope?.accountKey
        ? buildScopedStorageKey(this.unscopedKey, scope.accountKey)
        : this.unscopedKey;
      return true;
    } catch (error) {
      console.warn('[Timeline] Failed to resolve timeline hierarchy storage scope:', error);
      return false;
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
  private async loadTimelineHierarchyFromExtensionStorage(
    accept: (apply: () => void) => boolean,
  ): Promise<void> {
    if (!this.conversationId || typeof chrome === 'undefined' || !chrome.storage?.local?.get) {
      accept(() => {});
      return;
    }

    try {
      const storageValues = (await chrome.storage.local.get(this.extensionKeysToRead)) as Record<
        string,
        unknown
      >;
      if (!this.isCurrent) return;
      const data = this.resolveStoredHierarchy(storageValues);
      const conversationData = data.conversations[this.conversationId] || null;

      if (conversationData) {
        accept(() => {
          this.applyTimelineHierarchyConversationData(conversationData);
          if (this.timelineHierarchyStorageKey === this.unscopedKey) {
            this.persistTimelineHierarchyToLegacyStorage();
          }
        });
        return;
      }

      if (this.timelineHierarchyStorageKey !== this.unscopedKey) {
        const legacyConversationData = this.buildLegacyTimelineHierarchyConversationData();
        if (legacyConversationData) {
          if (accept(() => this.applyTimelineHierarchyConversationData(legacyConversationData))) {
            await this.persistTimelineHierarchyToExtensionStorage();
          }
          return;
        }
      }

      if (accept(() => {}) && this.hasTimelineHierarchyData()) {
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
      const storageValues = (await chrome.storage.local.get(this.extensionKeysToRead)) as Record<
        string,
        unknown
      >;
      if (!this.hydration.ready || !this.isCurrent) return;
      const existing = this.resolveStoredHierarchy(storageValues);
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
    return this.policy
      .getStoredTurnIdAliases(turnId)
      .some((alias) => this.collapsedMarkers.has(alias));
  }
  toggleCollapse(turnId: string): void | Promise<void> {
    if (!this.isCurrent || !this.canEdit(turnId)) return;
    return this.hydration.edit(
      () => this.init(),
      () => {
        const aliases = this.policy.getStoredTurnIdAliases(turnId);
        if (!this.isCurrent || !this.canEdit(turnId) || aliases.length === 0) return;
        if (aliases.some((alias) => this.collapsedMarkers.has(alias))) {
          aliases.forEach((alias) => this.collapsedMarkers.delete(alias));
        } else {
          this.collapsedMarkers.add(turnId);
        }
        this.saveHierarchy();
        this.onChange();
      },
    );
  }
  getMarkerLevel(turnId: string): MarkerLevel {
    for (const alias of this.policy.getStoredTurnIdAliases(turnId)) {
      const level = this.markerLevels.get(alias);
      if (level) return level;
    }
    return 1;
  }
  setMarkerLevel(turnId: string, level: MarkerLevel): void | Promise<void> {
    if (!this.isCurrent || !this.canEdit(turnId)) return;
    return this.hydration.edit(
      () => this.init(),
      () => {
        // Converge verified legacy aliases only after a complete outline is available.
        const aliases = this.policy.getStoredTurnIdAliases(turnId);
        if (!this.isCurrent || !this.canEdit(turnId) || aliases.length === 0) return;
        aliases.forEach((alias) => this.markerLevels.delete(alias));
        if (level !== 1) this.markerLevels.set(turnId, level);
        this.saveHierarchy();
        this.onChange();
      },
    );
  }
  init(): Promise<void> {
    return this.hydration.read(async (accept) => {
      if (!(await this.loadTimelineHierarchyStorageContext())) return;
      if (!this.isCurrent || this.hydration.ready) return;
      if (this.timelineHierarchyStorageKey === this.unscopedKey) {
        this.loadMarkerLevels();
        this.loadCollapsedMarkers();
      }
      await this.loadTimelineHierarchyFromExtensionStorage(accept);
      if (this.hydration.ready) this.onChange();
    });
  }
  destroy(): void {
    this.destroyed = true;
  }
  applyStorageChanges(changes: Record<string, chrome.storage.StorageChange>): void {
    if (!this.isCurrent || !this.timelineHierarchyStorageKey) return;
    const timelineHierarchyChange = changes[this.timelineHierarchyStorageKey];
    if (timelineHierarchyChange && this.conversationId) {
      const value: unknown = timelineHierarchyChange.newValue;
      // Unresolved scope or partial data is not evidence that the complete outline was read.
      if (value != null && !isCompleteHierarchySnapshot(value)) return;
      this.hydration.snapshot(() => {
        const data = this.resolveStoredHierarchy({
          [this.timelineHierarchyStorageKey]: timelineHierarchyChange.newValue,
        });
        const conversationData = data.conversations[this.conversationId] || null;
        this.applyTimelineHierarchyConversationData(conversationData);
        if (this.timelineHierarchyStorageKey === this.unscopedKey) {
          this.persistTimelineHierarchyToLegacyStorage();
        }
        this.onChange();
      });
    }
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
