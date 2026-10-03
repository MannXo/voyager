export interface CatalogTimelineConfig {
  readonly siteId: string;
  readonly siteLabel: string;
  readonly turnSelector: string;
  readonly assistantTurnSelector?: string;
  readonly conversationIdPattern?: string;
  readonly conversationIdAttribute?: string;
  readonly turnItemSelector?: string;
  readonly scrollContainerSelector?: string;
  readonly yieldWhenSelector?: string;
  readonly position: 'left' | 'right';
  readonly pluginId: string;
  readonly coachmarkId: string;
}

/** Keep the existing once-per-user guide identity across every catalog site. */
export const TIMELINE_STYLE_COACHMARK_ID = 'claude-timeline-compact-style-intro-v1';

export function catalogStarsStorageKey(siteId: string, conversationId: string): string {
  return `gvTimelineStars:${siteId}:${conversationId}`;
}

export function catalogHierarchyStorageKey(siteId: string, conversationId: string): string {
  return `gvTimelineHierarchy:${siteId}:${conversationId}`;
}
