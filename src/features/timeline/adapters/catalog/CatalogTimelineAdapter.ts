import type { TimelineAdapter, TimelineElements, TimelineStateOwner } from '../../TimelineAdapter';
import type { TimelineMarker } from '../../types';
import { CatalogTimelineState } from './CatalogTimelineState';
import type { CatalogTimelineConfig } from './config';
import { NavigatorStars } from './navigatorStars';
import { type Marker, type MountedTurn, mergeMountedTurns, rememberedMarkers } from './turnMerge';
import { mountedOwnershipTurns } from './turnOwnership';
import { renderedCheck, togglesVisibility } from './turnVisibility';

/** Site selectors and virtualized DOM identity; every visual surface belongs to the shared engine. */
export class CatalogTimelineAdapter implements TimelineAdapter {
  readonly virtualized = true;
  readonly defaultMarkerLevelEnabled = true;
  readonly settingsPrefix: string;
  readonly observationOptions: MutationObserverInit = {
    childList: true,
    characterData: true,
    subtree: true,
    attributes: true,
    attributeOldValue: true,
    attributeFilter: ['style', 'hidden'],
  };
  private known: Marker[] = [];
  private readonly originalStamps = new Map<HTMLElement, string | null>();

  constructor(
    readonly config: CatalogTimelineConfig,
    private readonly stars: NavigatorStars,
  ) {
    this.settingsPrefix = `gvTimeline:${config.siteId}:`;
  }

  get siteId(): string {
    return this.config.siteId;
  }
  get position(): 'left' | 'right' {
    return this.config.position;
  }

  createState(onChange: () => void): TimelineStateOwner {
    return new CatalogTimelineState(this.config, this.stars, onChange);
  }

  createTimestamps(): null {
    return null;
  }

  async findElements(signal: AbortSignal): Promise<TimelineElements | null> {
    return signal.aborted ? null : this.refreshElements(this.config.turnSelector);
  }

  refreshElements(selector: string): TimelineElements | null {
    if (!document.body) return null;
    const turn = Array.from(document.querySelectorAll<HTMLElement>(selector)).find(renderedCheck());
    return {
      container: document.body,
      selector,
      viewport: this.getViewport(turn ?? document.body),
    };
  }

  getViewport(element: HTMLElement): HTMLElement {
    if (this.config.scrollContainerSelector) {
      try {
        const configured = document.querySelector<HTMLElement>(this.config.scrollContainerSelector);
        if (configured?.contains(element)) return configured;
      } catch {
        /* Fall back to the nearest scroll ancestor for stale catalog selectors. */
      }
    }
    for (
      let parent = element.parentElement;
      parent && parent !== document.body;
      parent = parent.parentElement
    ) {
      if (
        /(auto|scroll|overlay)/.test(getComputedStyle(parent).overflowY) &&
        parent.scrollHeight > parent.clientHeight
      )
        return parent;
    }
    return document.scrollingElement instanceof HTMLElement
      ? document.scrollingElement
      : document.documentElement;
  }

  collect(container: HTMLElement, selector: string, previous: TimelineMarker[]): TimelineMarker[] {
    const mounted: MountedTurn[] = Array.from(container.querySelectorAll<HTMLElement>(selector))
      .filter(renderedCheck())
      .map((element) => ({
        element,
        summary: (element.textContent ?? '').replace(/\s+/g, ' ').trim(),
      }));
    for (const turn of mounted)
      if (!this.originalStamps.has(turn.element))
        this.originalStamps.set(turn.element, turn.element.getAttribute('data-gv-turn-id'));
    const viewport = this.getViewport(mounted[0]?.element ?? container);
    const viewportTop =
      viewport === document.documentElement || viewport === document.body
        ? 0
        : viewport.getBoundingClientRect().top;
    const offset =
      viewport === document.documentElement || viewport === document.body
        ? window.scrollY
        : viewport.scrollTop;
    const reverse = getComputedStyle(viewport).flexDirection === 'column-reverse';
    const scrollTop = reverse
      ? Math.max(0, viewport.scrollHeight - viewport.clientHeight + offset)
      : offset;
    const old = new Map(previous.map((marker) => [marker.id, marker]));
    // Shared navigation remeasures returned markers; carry its frame back into the merge owner.
    for (const marker of this.known) {
      const measured = old.get(marker.id);
      if (measured?.center !== undefined) marker.center = measured.center;
      if (measured?.measuredAt !== undefined) marker.measuredAt = measured.measuredAt;
    }
    const centerOf = (element: HTMLElement): number => {
      const rect = element.getBoundingClientRect();
      return scrollTop + rect.top - viewportTop + rect.height / 2;
    };
    this.known = mergeMountedTurns(rememberedMarkers(this.known, mounted), mounted, centerOf);
    const pass =
      this.known.reduce((latest, marker) => Math.max(latest, marker.measuredAt ?? 0), 0) + 1;
    for (const marker of this.known) {
      if (!marker.element.isConnected) continue;
      marker.center = centerOf(marker.element);
      marker.measuredAt = pass;
    }
    this.stars.observe(mountedOwnershipTurns(mounted));
    const assistantByElement = this.assistantSummaries(mounted, container);
    return this.known.map((marker, index) => ({
      id: marker.id,
      element: marker.element,
      summary: marker.summary,
      assistantSummary:
        assistantByElement.get(marker.element) ?? old.get(marker.id)?.assistantSummary ?? '',
      baseN: this.known.length === 1 ? 0.5 : index / Math.max(1, this.known.length - 1),
      starred: !!this.stars.get(marker.hash),
      hash: marker.hash,
      center: marker.center,
      measuredAt: marker.measuredAt,
    }));
  }

  private assistantSummaries(
    mounted: readonly MountedTurn[],
    container: HTMLElement,
  ): Map<HTMLElement, string> {
    const result = new Map<HTMLElement, string>();
    if (!this.config.assistantTurnSelector) return result;
    const replies = Array.from(
      container.querySelectorAll<HTMLElement>(this.config.assistantTurnSelector),
    ).filter(renderedCheck());
    mounted.forEach(({ element }, index) => {
      const next = mounted[index + 1]?.element;
      const reply = replies.find(
        (candidate) =>
          !!(element.compareDocumentPosition(candidate) & Node.DOCUMENT_POSITION_FOLLOWING) &&
          (!next || !!(candidate.compareDocumentPosition(next) & Node.DOCUMENT_POSITION_FOLLOWING)),
      );
      if (reply) result.set(element, (reply.textContent ?? '').replace(/\s+/g, ' ').trim());
    });
    return result;
  }

  shouldRefresh(records: MutationRecord[]): boolean {
    const selectors = [this.config.turnSelector, this.config.assistantTurnSelector]
      .filter(Boolean)
      .join(', ');
    const elementOf = (node: Node): Element | null =>
      node instanceof Element ? node : node.parentElement;
    const touches = (node: Node): boolean => {
      const element = elementOf(node);
      return !!(element?.closest(selectors) || element?.querySelector(selectors));
    };
    return records.some((record) => {
      if (
        elementOf(record.target)?.closest(
          '[data-gv-turn-navigator], .timeline-preview-panel, .timeline-preview-toggle, .timeline-tooltip',
        )
      )
        return false;
      if (record.type === 'attributes') return togglesVisibility(record) && touches(record.target);
      return (
        !!elementOf(record.target)?.closest(selectors) ||
        [...Array.from(record.addedNodes), ...Array.from(record.removedNodes)].some(touches)
      );
    });
  }

  reportTurns(): void {
    /* Plugin health uses the primitive's target counter. */
  }

  destroy(): void {
    for (const [element, original] of this.originalStamps) {
      if (original === null) element.removeAttribute('data-gv-turn-id');
      else element.setAttribute('data-gv-turn-id', original);
    }
    this.originalStamps.clear();
    this.known = [];
  }
}
