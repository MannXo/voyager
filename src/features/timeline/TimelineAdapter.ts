import type { MarkerLevel, TimelineMarker } from './types';

export interface TimelineHierarchyOwner {
  markerLevelEnabled: boolean;
  getMarkerLevel(id: string): MarkerLevel;
  setMarkerLevel(id: string, level: MarkerLevel): void;
  isMarkerCollapsed(id: string): boolean;
  toggleCollapse(id: string): void;
  canCollapseMarker(id: string): boolean;
  getHiddenMarkerIndices(): Set<number>;
  calculateCollapsedPositions(
    hidden: Set<number>,
    pad: number,
    usable: number,
  ): {
    desiredY: number[];
    effectiveBaseNs: number[];
  };
}

export interface TimelineStateOwner {
  readonly hierarchy: TimelineHierarchyOwner;
  markers: TimelineMarker[];
  readonly markerMap: Map<string, TimelineMarker>;
  init(): Promise<void>;
  destroy(): void;
  replaceMarkers(markers: TimelineMarker[]): void;
  isMarkerStarred(id: string): boolean;
  toggleStar(id: string): Promise<void>;
  resolveMarkerIdForStorageId(id: string): string;
}

export interface TimelineElements {
  container: HTMLElement;
  selector: string;
  viewport: HTMLElement;
}

export interface TimelineTimestampOwner {
  init(): Promise<void>;
  update(previous: TimelineMarker[], next: TimelineMarker[]): void;
  formatTooltipTimestamp(id: string): string | null;
  destroy(): void;
}

/** One captured conversation; the engine owns viewport rebinds and UI lifetime. */
export interface TimelineAdapter {
  readonly siteId: string;
  readonly settingsPrefix: string;
  readonly virtualized?: boolean;
  readonly observationOptions?: MutationObserverInit;
  readonly defaultMarkerLevelEnabled?: boolean;
  readonly mountAnchor?: HTMLElement;
  readonly position?: 'left' | 'right';
  shouldRefresh?(records: MutationRecord[]): boolean;
  createState(onChange: () => void): TimelineStateOwner;
  createTimestamps(state: TimelineStateOwner): TimelineTimestampOwner | null;
  findElements(signal: AbortSignal): Promise<TimelineElements | null>;
  refreshElements(selector: string): TimelineElements | null;
  getViewport(element: HTMLElement): HTMLElement;
  collect(container: HTMLElement, selector: string, previous: TimelineMarker[]): TimelineMarker[];
  reportTurns(found: boolean, recheck: () => boolean): void;
  destroy(): void;
}
