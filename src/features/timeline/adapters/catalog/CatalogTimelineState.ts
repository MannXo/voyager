import { StorageKeys } from '@/core/types/common';

import type { TimelineStateOwner } from '../../TimelineAdapter';
import { TimelineHierarchyGeometry } from '../../TimelineHierarchyGeometry';
import type { MarkerLevel, TimelineMarker } from '../../types';
import {
  catalogHierarchyStorageKey,
  catalogStarsStorageKey,
  type CatalogTimelineConfig,
} from './config';
import { buildConversationId, starConversationId } from './conversationId';
import { NavigatorStars } from './navigatorStars';
import { extractTurnHash } from './starSnapshot';

/** Captured conversation persistence; ownership evidence survives in the primitive scope. */
export class CatalogTimelineState implements TimelineStateOwner {
  markers: TimelineMarker[] = [];
  readonly markerMap = new Map<string, TimelineMarker>();
  readonly hierarchy: CatalogTimelineHierarchy;
  private destroyed = false;
  private readonly routeId: string;
  private readonly url: string;

  constructor(
    private readonly config: CatalogTimelineConfig,
    private readonly stars: NavigatorStars,
    private readonly onChange: () => void,
  ) {
    this.url = location.href.split('#')[0];
    this.routeId = buildConversationId(config, this.url);
    this.hierarchy = new CatalogTimelineHierarchy(
      config.siteId,
      starConversationId(config, this.url),
      () => this.markers,
      () => this.isCurrent(),
      (id) => {
        const marker = this.markerMap.get(id);
        return !!marker && this.stars.canStar(marker.element);
      },
      onChange,
    );
  }

  private isCurrent(): boolean {
    return (
      !this.destroyed &&
      buildConversationId(this.config) === this.routeId &&
      location.href.split('#')[0] === this.url
    );
  }

  async init(): Promise<void> {
    this.hierarchy.load();
    await this.stars.load();
    if (!this.isCurrent()) return;
    chrome.storage?.onChanged?.addListener(this.handleStorageChange);
    window.addEventListener('storage', this.handleLocalStorageChange);
  }

  private handleStorageChange = (
    changes: Record<string, chrome.storage.StorageChange>,
    area: string,
  ): void => {
    if (area !== 'local' || !changes[StorageKeys.TIMELINE_STARRED_MESSAGES] || !this.isCurrent())
      return;
    void this.stars.load(true, true).then(() => {
      if (!this.isCurrent()) return;
      this.applyStars();
      this.onChange();
    });
  };

  private handleLocalStorageChange = (event: StorageEvent): void => {
    if (!this.isCurrent()) return;
    const conversationId = starConversationId(this.config, this.url);
    if (!conversationId) return;
    if (
      event.key !== null &&
      event.key !== catalogHierarchyStorageKey(this.config.siteId, conversationId) &&
      event.key !== catalogStarsStorageKey(this.config.siteId, conversationId)
    )
      return;
    this.hierarchy.load();
    void this.stars.load(true).then(() => {
      if (!this.isCurrent()) return;
      this.applyStars();
      this.onChange();
    });
  };

  replaceMarkers(markers: TimelineMarker[]): void {
    this.markers = markers;
    this.markerMap.clear();
    for (const marker of markers) this.markerMap.set(marker.id, marker);
    this.applyStars();
  }

  private applyStars(): void {
    for (const marker of this.markers) marker.starred = this.isMarkerStarred(marker.id);
  }

  isMarkerStarred(id: string): boolean {
    return !!this.stars.get(extractTurnHash(id));
  }

  resolveMarkerIdForStorageId(id: string): string {
    if (this.markerMap.has(id)) return id;
    return (
      this.markers.find((marker) => extractTurnHash(marker.id) === extractTurnHash(id))?.id ?? id
    );
  }

  async toggleStar(id: string): Promise<void> {
    const marker = this.markerMap.get(id);
    if (!marker || !this.isCurrent()) return;
    const title = document.title
      .replace(
        new RegExp(
          `\\s*[|-]\\s*${this.config.siteLabel.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}.*$`,
          'i',
        ),
        '',
      )
      .trim();
    if (
      await this.stars.toggle({ ...marker, hash: extractTurnHash(id) }, () => ({
        url: this.url,
        title:
          title || this.markers[0]?.summary.slice(0, 50) || `${this.config.siteLabel} conversation`,
      }))
    ) {
      if (!this.isCurrent()) return;
      this.applyStars();
      this.onChange();
    }
  }

  destroy(): void {
    this.destroyed = true;
    chrome.storage?.onChanged?.removeListener(this.handleStorageChange);
    window.removeEventListener('storage', this.handleLocalStorageChange);
  }
}

class CatalogTimelineHierarchy extends TimelineHierarchyGeometry {
  private levels: Record<string, MarkerLevel> = {};
  private collapsed = new Set<string>();
  private readonly storageKey: string | null;

  constructor(
    siteId: string,
    conversationId: string | null,
    getMarkers: () => TimelineMarker[],
    private readonly alive: () => boolean,
    private readonly canEdit: (id: string) => boolean,
    private readonly onChange: () => void,
  ) {
    super(
      getMarkers,
      (id) => this.levels[id] ?? 1,
      (id) => this.collapsed.has(id),
    );
    this.storageKey = conversationId ? catalogHierarchyStorageKey(siteId, conversationId) : null;
  }

  load(): void {
    this.levels = {};
    this.collapsed.clear();
    if (!this.storageKey || !this.alive()) return;
    try {
      const raw = localStorage.getItem(this.storageKey);
      if (!raw) return;
      const data: unknown = JSON.parse(raw);
      if (typeof data !== 'object' || data === null) return;
      const { levels, collapsed } = data as { levels?: unknown; collapsed?: unknown };
      if (typeof levels === 'object' && levels !== null && !Array.isArray(levels)) {
        for (const [id, level] of Object.entries(levels)) {
          if (level === 1 || level === 2 || level === 3) this.levels[id] = level;
        }
      }
      if (Array.isArray(collapsed))
        for (const id of collapsed) if (typeof id === 'string') this.collapsed.add(id);
    } catch {
      // Host storage may be unavailable; the current conversation remains usable.
    }
  }

  setMarkerLevel(id: string, level: MarkerLevel): void {
    // A cached previous thread can remain mounted after the URL names the next conversation.
    if (!this.alive() || !this.storageKey || !this.canEdit(id)) return;
    if (level === 1) delete this.levels[id];
    else this.levels[id] = level;
    this.save();
  }

  toggleCollapse(id: string): void {
    if (!this.alive() || !this.storageKey || !this.canEdit(id)) return;
    if (!this.collapsed.delete(id)) this.collapsed.add(id);
    this.save();
  }

  private save(): void {
    if (!this.storageKey) return;
    try {
      localStorage.setItem(
        this.storageKey,
        JSON.stringify({ levels: this.levels, collapsed: [...this.collapsed] }),
      );
    } catch {
      // Keep a working in-memory hierarchy when the host blocks localStorage.
    }
    this.onChange();
  }
}
