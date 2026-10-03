import { StorageKeys, isTimelineStyle } from '@/core/types/common';
import { applyRTLClass } from '@/core/utils/rtl';
import { initI18n } from '@/utils/i18n';

import type {
  TimelineAdapter,
  TimelineStateOwner,
  TimelineTimestampOwner,
} from './TimelineAdapter';
import { TimelineMarkerInteractions } from './TimelineMarkerInteractions';
import { TimelineNavigation } from './TimelineNavigation';
import { TimelineTooltip } from './TimelineTooltip';
import { TimelineView } from './TimelineView';
import type { DotElement, ExtGlobal, SyncSettingsListener, TimelinePositionData } from './types';
/** Composes one conversation's DOM observation, state, navigation and timeline surfaces. */
export class TimelineEngine {
  private conversationContainer: HTMLElement | null = null;
  private destroyed = false;
  private mutationObserver: MutationObserver | null = null;
  private intersectionObserver: IntersectionObserver | null = null;
  private zeroTurnsTimer: number | null = null;
  private zeroTurnsRetryCount = 0;
  private onSyncSettingsChanged: SyncSettingsListener | null = null;
  private userTurnSelector: string = '';
  private static readonly SEARCH_HIGHLIGHT_CLASS = 'timeline-search-highlight';
  private readonly state: TimelineStateOwner;
  private readonly timestamps: TimelineTimestampOwner | null;
  private readonly navigation: TimelineNavigation;
  private readonly view: TimelineView;
  private tooltip: TimelineTooltip | null = null;
  private interactions: TimelineMarkerInteractions | null = null;
  private readonly lifetime = new AbortController();
  private recalcTimer: number | null = null;
  private pluginSettings: Record<string, unknown> | null = null;
  constructor(private readonly adapter: TimelineAdapter) {
    this.state = adapter.createState(() => this.onStateChange());
    this.navigation = new TimelineNavigation({
      virtualized: adapter.virtualized,
      getMarkers: () => this.state.markers,
      getMarkerTops: () => this.view.markerTops,
      getMarkerPositions: () => this.view.yPositions,
      getTrackHeight: () => this.view.ui.timelineBar?.clientHeight ?? 0,
      refreshMarkers: (target, direction) =>
        direction
          ? this.maybeRefreshMarkersForNavigation(direction)
          : this.maybeRefreshMarkersForInteraction(target),
      resolveStoredId: (id) => this.state.resolveMarkerIdForStorageId(id),
      onActiveChange: () => this.view.updateActiveDotUI(),
      onScroll: () => {
        this.view.syncTimelineTrackToMain();
        this.view.updateVirtualRangeAndRender();
        this.view.updateSliderPosition();
      },
      animateRunner: (from, to, duration) => this.view.startRunner(from, to, duration),
    });
    this.view = new TimelineView(this.state, {
      getViewport: () => this.navigation.viewport,
      getActiveId: () => this.navigation.activeTurnId,
      navigate: (id, index) => this.navigation.navigateToMarker(id, index, 'preview'),
      search: (query) => this.highlightSearchInDOM(query),
      onStyleChange: () => this.tooltip?.hide(true),
      onResize: () => this.tooltip?.refreshCurrent(),
      storagePrefix: adapter.settingsPrefix,
      mountAnchor: adapter.mountAnchor,
      position: adapter.position,
    });
    this.timestamps = adapter.createTimestamps(this.state);
  }
  handleHash = (): void => {
    this.navigation.handleStarredMessageNavigation();
  };
  private settingKey(suffix: string): string {
    return `${this.adapter.settingsPrefix}${suffix}`;
  }
  updateSettings(settings: Record<string, unknown>): void {
    if (this.destroyed) return;
    this.pluginSettings = settings;
    this.view.timelineStyle = settings.compactView === true ? 'compact' : 'dots';
    if (isTimelineStyle(settings.timelineStyle)) this.view.timelineStyle = settings.timelineStyle;
    this.view.applyTimelineStyle();
    this.view.toggleDraggable(settings.draggable !== false);
    this.setMarkerLevelEnabled(settings.markerLevel !== false);
  }
  private mountUI(): void {
    this.view.mount();
    const bar = this.view.ui.timelineBar!;
    if (this.adapter.virtualized) bar.dataset.gvTurnNavigator = this.adapter.siteId;
    this.tooltip = new TimelineTooltip(bar, {
      getContext: () => ({
        style: this.view.timelineStyle,
        previewOpen: this.view.previewPanel?.isOpen ?? false,
      }),
      getContent: (dot) => {
        const id = dot.dataset.targetTurnId ?? '';
        const marker = this.state.markerMap.get(id);
        return {
          text: this.buildTooltipText(dot),
          summary: marker?.summary ?? dot.getAttribute('aria-label') ?? '',
          assistantSummary: marker?.assistantSummary ?? '',
          starred: this.state.isMarkerStarred(id),
        };
      },
    });
    this.interactions = new TimelineMarkerInteractions(bar, this.tooltip, {
      navigate: (index, id) => this.navigation.navigateToMarker(id, index),
      toggleStar: (id) => void this.state.toggleStar(id),
      getHierarchy: (id) =>
        this.state.hierarchy.markerLevelEnabled
          ? {
              level: this.state.hierarchy.getMarkerLevel(id),
              collapsed: this.state.hierarchy.isMarkerCollapsed(id),
              canCollapse: this.state.hierarchy.canCollapseMarker(id),
            }
          : null,
      setLevel: (id, level) => this.state.hierarchy.setMarkerLevel(id, level),
      toggleCollapse: (id) => this.state.hierarchy.toggleCollapse(id),
    });
  }
  private onStateChange(): void {
    if (this.destroyed) return;
    // Syncing to the chat here would reset the user's manually scrolled rail after marker edits.
    this.view.updateTimelineGeometry();
    this.view.updateVirtualRangeAndRender();
    this.view.updateSlider();
    this.view.updatePreviewMarkers();
    this.tooltip?.refreshCurrent();
  }
  private setMarkerLevelEnabled(enabled: boolean): void {
    this.state.hierarchy.markerLevelEnabled = enabled;
    if (!enabled) this.interactions?.closeMenu();
    this.onStateChange();
  }
  private debouncedRecalc = (): void => {
    if (this.destroyed) return;
    if (this.recalcTimer !== null) clearTimeout(this.recalcTimer);
    this.recalcTimer = window.setTimeout(() => {
      this.recalcTimer = null;
      this.recalculateAndRenderMarkers();
    }, 200);
  };
  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    this.lifetime.abort();
    this.unregisterSyncSettingsListener();
    this.mutationObserver?.disconnect();
    this.intersectionObserver?.disconnect();
    if (this.recalcTimer !== null) clearTimeout(this.recalcTimer);
    if (this.zeroTurnsTimer !== null) clearTimeout(this.zeroTurnsTimer);
    this.adapter.destroy();
    this.navigation.destroy();
    this.interactions?.destroy();
    this.tooltip?.destroy();
    this.clearSearchHighlights();
    this.view.destroy();
    this.state.destroy();
    this.timestamps?.destroy();
    this.conversationContainer = null;
  }
  async init(): Promise<void> {
    if (this.destroyed) return;
    await initI18n();
    if (this.destroyed) return;
    const ok = await this.findCriticalElements();
    if (!ok || this.destroyed) return;
    this.mountUI();
    this.setupObservers();
    await this.state.init();
    if (this.destroyed) return;
    await this.timestamps?.init();
    if (this.destroyed) return;
    // Ensure initial render even when Gemini DOM is already stable (no mutations after observer attaches)
    this.recalculateAndRenderMarkers();
    // Handle URL hash for starred message navigation
    this.navigation.handleStarredMessageNavigation();
    // Initialize keyboard shortcuts
    await this.navigation.initKeyboardShortcuts();
    if (this.destroyed) return;
    try {
      const g = globalThis as ExtGlobal;
      const defaults = {
        [this.settingKey('ScrollMode')]: 'flow',
        [this.settingKey('Style')]: 'dots',
        [this.settingKey('HideContainer')]: false,
        [this.settingKey('BarWidth')]: null,
        [this.settingKey('Draggable')]: false,
        [this.settingKey('MarkerLevel')]: this.adapter.defaultMarkerLevelEnabled ?? false,
        [this.settingKey('Position')]: null,
        [this.settingKey('PreviewPinned')]: false,
        [StorageKeys.LANGUAGE]: null,
      };

      let res: Record<string, unknown> | null = null;
      // prefer chrome.storage or browser.storage if available to sync with popup
      if (g.chrome?.storage?.sync || g.browser?.storage?.sync) {
        res = await new Promise((resolve) => {
          if (g.chrome?.storage?.sync?.get) {
            g.chrome.storage.sync.get(
              defaults as Record<string, unknown>,
              (items: Record<string, unknown>) => {
                if (g.chrome.runtime.lastError) {
                  console.error(
                    `[Timeline] chrome.storage.get failed: ${g.chrome.runtime.lastError.message}`,
                  );
                  resolve(null);
                } else {
                  resolve(items);
                }
              },
            );
          } else {
            g.browser?.storage?.sync
              ?.get(defaults)
              .then(resolve)
              .catch((error: Error) => {
                console.error(`[Timeline] browser.storage.get failed: ${error.message}`);
                resolve(null);
              });
          }
        });
      } else {
        // No extension storage available, try to load critical fallback from localStorage
        const saved = localStorage.getItem(this.settingKey('ScrollMode'));
        if (saved === 'flow' || saved === 'jump') res = { [this.settingKey('ScrollMode')]: saved };
      }
      if (this.destroyed) return;

      const m = res?.[this.settingKey('ScrollMode')];
      if (m === 'flow' || m === 'jump') this.navigation.mode = m;
      const storedTimelineStyle = res?.[this.settingKey('Style')];
      if (isTimelineStyle(storedTimelineStyle)) {
        this.view.timelineStyle = storedTimelineStyle;
      }
      this.view.hideContainer = !!res?.[this.settingKey('HideContainer')];
      this.view.placement.restoreWidth(res?.[this.settingKey('BarWidth')]);
      this.view.applyContainerVisibility();
      this.view.applyTimelineStyle();
      this.view.toggleDraggable(!!res?.[this.settingKey('Draggable')]);
      this.setMarkerLevelEnabled(!!res?.[this.settingKey('MarkerLevel')]);
      this.view.previewPanel?.setPinned(res?.[this.settingKey('PreviewPinned')] === true);
      this.view.rtl = applyRTLClass(res?.[StorageKeys.LANGUAGE] as string | null | undefined);

      this.view.placement.restorePosition(
        res?.[this.settingKey('Position')] as TimelinePositionData | undefined,
      );
      this.view.updateRulerDirection();
      this.view.previewPanel?.reposition();

      if (this.pluginSettings) this.updateSettings(this.pluginSettings);

      // listen for changes from popup and update mode live
      this.registerSyncSettingsListener();
    } catch (err) {
      console.error('[Timeline] Init storage error:', err);
    }
  }

  /**
   * Listen for sync-storage changes from the popup and update settings live.
   * The listener is kept as a class field so destroy() can remove it — a new
   * TimelineEngine is created on every SPA navigation and leaked listeners
   * would otherwise accumulate and retain detached DOM.
   */
  private registerSyncSettingsListener(): void {
    if (this.destroyed || this.onSyncSettingsChanged) return;
    try {
      const g = globalThis as ExtGlobal;
      const onChanged = g.chrome?.storage?.onChanged || g.browser?.storage?.onChanged;
      if (!onChanged) return;
      this.onSyncSettingsChanged = (
        changes: Record<string, { newValue: unknown }>,
        area: string,
      ) => {
        if (area !== 'sync') return;
        if (changes?.[this.settingKey('ScrollMode')]) {
          const n = changes[this.settingKey('ScrollMode')].newValue;
          if (n === 'flow' || n === 'jump') this.navigation.mode = n;
        }
        if (changes?.[this.settingKey('Style')]) {
          const nextStyle = changes[this.settingKey('Style')].newValue;
          if (isTimelineStyle(nextStyle)) {
            this.view.timelineStyle = nextStyle;
            this.view.applyTimelineStyle();
          }
        }
        if (changes?.[this.settingKey('HideContainer')]) {
          this.view.hideContainer = !!changes[this.settingKey('HideContainer')].newValue;
          this.view.applyContainerVisibility();
        }
        if (changes?.[this.settingKey('BarWidth')]) {
          if (this.view.placement.restoreWidth(changes[this.settingKey('BarWidth')].newValue)) {
            this.view.applyContainerVisibility();
          }
        }
        if (changes?.[this.settingKey('Draggable')]) {
          this.view.toggleDraggable(!!changes[this.settingKey('Draggable')].newValue);
        }
        if (changes?.[this.settingKey('MarkerLevel')]) {
          this.setMarkerLevelEnabled(!!changes[this.settingKey('MarkerLevel')].newValue);
        }
        if (changes?.[this.settingKey('PreviewPinned')]) {
          this.view.previewPanel?.setPinned(
            changes[this.settingKey('PreviewPinned')].newValue === true,
          );
        }
        if (changes?.[this.settingKey('Position')]) {
          this.view.placement.updateSavedPosition(
            changes[this.settingKey('Position')].newValue as TimelinePositionData | null,
          );
        }
        if (changes?.[StorageKeys.LANGUAGE]) {
          const newLang = changes[StorageKeys.LANGUAGE].newValue as string | null | undefined;
          this.view.applyRTLUpdate(newLang);
        }
      };
      onChanged.addListener(this.onSyncSettingsChanged);
    } catch {
      this.onSyncSettingsChanged = null;
    }
  }

  private unregisterSyncSettingsListener(): void {
    if (!this.onSyncSettingsChanged) return;
    try {
      const g = globalThis as ExtGlobal;
      g.chrome?.storage?.onChanged?.removeListener?.(this.onSyncSettingsChanged);
      g.browser?.storage?.onChanged?.removeListener?.(this.onSyncSettingsChanged);
    } catch {}
    this.onSyncSettingsChanged = null;
  }

  private updateIntersectionObserverTargetsFromMarkers(): void {
    if (!this.intersectionObserver) return;
    this.intersectionObserver.disconnect();
    this.state.markers.forEach((m) => this.intersectionObserver!.observe(m.element));
  }

  private async findCriticalElements(): Promise<boolean> {
    const elements = await this.adapter.findElements(this.lifetime.signal);
    if (!elements || this.destroyed) return false;
    this.conversationContainer = elements.container;
    this.userTurnSelector = elements.selector;
    this.navigation.setViewport(elements.viewport);
    return true;
  }

  private recalculateAndRenderMarkers = (): void => {
    if (
      this.destroyed ||
      !this.conversationContainer ||
      !this.view.ui.timelineBar ||
      !this.navigation.viewport ||
      !this.userTurnSelector
    )
      return;
    if (this.adapter.virtualized) {
      const elements = this.adapter.refreshElements(this.userTurnSelector);
      if (elements && elements.viewport !== this.navigation.viewport) {
        this.refreshCriticalElementsFromDocument();
      }
    }
    const userTurnNodeList = this.conversationContainer.querySelectorAll(this.userTurnSelector);
    if (userTurnNodeList.length === 0 && !this.adapter.virtualized) {
      this.timestamps?.update([], []);
      this.reportMissingTurns();
      if (!this.zeroTurnsTimer) {
        this.zeroTurnsRetryCount++;
        // Empty-page polling with backoff: 200ms for the first 30 attempts,
        // then doubling per attempt, capped at 2s (avoids an unbounded fast loop).
        const delay =
          this.zeroTurnsRetryCount > 30
            ? Math.min(2000, 200 * 2 ** (this.zeroTurnsRetryCount - 30))
            : 200;
        this.zeroTurnsTimer = window.setTimeout(() => {
          this.zeroTurnsTimer = null;
          this.recalculateAndRenderMarkers();
        }, delay);
      }
      return;
    }
    if (this.zeroTurnsTimer) {
      clearTimeout(this.zeroTurnsTimer);
      this.zeroTurnsTimer = null;
    }
    this.zeroTurnsRetryCount = 0;
    this.adapter.reportTurns(true, () => true);

    const previousMarkers = this.state.markers;

    const nextMarkers = this.adapter.collect(
      this.conversationContainer,
      this.userTurnSelector,
      previousMarkers,
    );
    if (nextMarkers.length === 0) {
      if (this.adapter.virtualized) {
        this.state.replaceMarkers([]);
        this.onStateChange();
      }
      return;
    }
    const elements = nextMarkers.map((marker) => marker.element);
    this.view.measureMarkers(elements);
    this.state.replaceMarkers(nextMarkers);
    this.timestamps?.update(previousMarkers, nextMarkers);
    this.view.updateTimelineGeometry();
    // Virtualized adapters select the viewport's nearest turn instead of Gemini's initial last turn.
    if (this.adapter.virtualized) this.navigation.computeActiveByScroll();
    else if (!this.navigation.activeTurnId && this.state.markers.length > 0)
      this.navigation.activeTurnId = this.state.markers[this.state.markers.length - 1].id;
    this.updateIntersectionObserverTargetsFromMarkers();
    this.view.syncTimelineTrackToMain();
    this.view.updateVirtualRangeAndRender();
    this.view.updateActiveDotUI();
    this.navigation.scheduleScrollSync();
    this.view.updatePreviewMarkers();
  };

  /** The zero-turn poll is the probe: no extra observer, and the verdict re-runs this query. */
  private reportMissingTurns(): void {
    this.adapter.reportTurns(
      false,
      () =>
        !!this.userTurnSelector &&
        !!this.conversationContainer?.querySelector(this.userTurnSelector),
    );
  }

  private setupObservers(): void {
    if (this.destroyed) return;
    this.mutationObserver = new MutationObserver((records) => {
      if (this.shouldIgnoreSelfInjectedMutations(records)) return;
      if (this.adapter.shouldRefresh && !this.adapter.shouldRefresh(records)) return;
      this.debouncedRecalc();
    });
    if (this.conversationContainer)
      this.mutationObserver.observe(
        this.conversationContainer,
        this.adapter.observationOptions ?? { childList: true, subtree: true },
      );

    this.intersectionObserver = new IntersectionObserver(
      () => {
        this.navigation.scheduleScrollSync();
      },
      { root: this.navigation.viewport, threshold: 0.1, rootMargin: '-40% 0px -59% 0px' },
    );
  }

  private clearSearchHighlights(): void {
    const cls = TimelineEngine.SEARCH_HIGHLIGHT_CLASS;
    const marks = this.conversationContainer?.querySelectorAll(`mark.${cls}`);
    if (!marks) return;
    marks.forEach((mark) => {
      const parent = mark.parentNode;
      if (!parent) return;
      parent.replaceChild(document.createTextNode(mark.textContent || ''), mark);
      parent.normalize();
    });
    this.discardSelfHighlightMutationRecords();
  }

  private highlightSearchInDOM(query: string): void {
    this.clearSearchHighlights();
    if (!query || !this.conversationContainer) return;
    const lowerQuery = query.toLowerCase();
    for (const marker of this.state.markers) {
      if (!marker.element) continue;
      const walker = document.createTreeWalker(marker.element, NodeFilter.SHOW_TEXT);
      const matches: { node: Text; index: number }[] = [];
      let node: Text | null;
      while ((node = walker.nextNode() as Text | null)) {
        const idx = node.textContent?.toLowerCase().indexOf(lowerQuery) ?? -1;
        if (idx !== -1) matches.push({ node, index: idx });
      }
      // Process in reverse to keep offsets stable
      for (let i = matches.length - 1; i >= 0; i--) {
        const { node: textNode, index: matchIdx } = matches[i];
        const after = textNode.splitText(matchIdx + query.length);
        const matchText = textNode.splitText(matchIdx);
        const mark = document.createElement('mark');
        mark.className = TimelineEngine.SEARCH_HIGHLIGHT_CLASS;
        mark.textContent = matchText.textContent;
        matchText.parentNode!.replaceChild(mark, matchText);
        // keep reference to 'after' to avoid TS unused warning
        void after;
      }
    }
    this.discardSelfHighlightMutationRecords();
  }

  private buildTooltipText(dot: DotElement): string {
    let fullText = (dot.getAttribute('aria-label') || '').trim();
    const id = dot.dataset.targetTurnId || '';
    if (id && this.state.isMarkerStarred(id)) fullText = `★ ${fullText}`;

    const timestamp = this.timestamps?.formatTooltipTimestamp(id);
    if (timestamp) fullText = timestamp + '\n' + fullText;
    return fullText;
  }

  private shouldAttemptRefreshForNavigation(): boolean {
    if (!this.userTurnSelector) return false;

    const documentCount = document.querySelectorAll(this.userTurnSelector).length;
    const containersDisconnected =
      (this.conversationContainer ? !this.conversationContainer.isConnected : true) ||
      (this.navigation.viewport ? !this.navigation.viewport.isConnected : true);

    return containersDisconnected || documentCount > this.state.markers.length;
  }

  private getScrollContainerForElement(element: HTMLElement): HTMLElement {
    return this.adapter.getViewport(element);
  }

  private shouldRefreshForInteraction(targetElement: HTMLElement | null): boolean {
    // Avoid the document-wide marker count scan on the common path, but still
    // validate the nearest scroll container. Gemini can insert a new viewport
    // inside the old one while both the marker and old viewport remain
    // connected; treating connectivity as freshness writes scrollTop to the
    // wrong element and makes clicks and shortcuts appear inert.
    if (
      targetElement?.isConnected &&
      this.conversationContainer?.isConnected &&
      this.navigation.viewport?.isConnected &&
      this.conversationContainer.contains(targetElement) &&
      this.navigation.viewport.contains(targetElement)
    ) {
      return this.getScrollContainerForElement(targetElement) !== this.navigation.viewport;
    }

    if (this.shouldAttemptRefreshForNavigation()) return true;

    if (targetElement && !targetElement.isConnected) return true;

    if (
      targetElement &&
      this.conversationContainer &&
      !this.conversationContainer.contains(targetElement)
    ) {
      return true;
    }

    if (!targetElement || !this.navigation.viewport) return false;

    const expectedScrollContainer = this.getScrollContainerForElement(targetElement);
    return expectedScrollContainer !== this.navigation.viewport;
  }

  private maybeRefreshMarkersForInteraction(targetElement: HTMLElement | null): boolean {
    if (!this.userTurnSelector) return false;
    if (!this.shouldRefreshForInteraction(targetElement)) return false;

    const refreshed = this.refreshCriticalElementsFromDocument();
    if (!refreshed) return false;

    this.recalculateAndRenderMarkers();
    return true;
  }

  private maybeRefreshMarkersForNavigation(direction: 'previous' | 'next'): boolean {
    if (!this.userTurnSelector) return false;

    const currentIndex = this.navigation.getActiveIndex();
    const isAtStart = currentIndex === 0;
    const isAtEnd = currentIndex >= 0 && currentIndex === this.state.markers.length - 1;

    const shouldAttemptRefresh =
      (direction === 'previous' && isAtStart) || (direction === 'next' && isAtEnd);
    if (!shouldAttemptRefresh) return false;

    if (!this.shouldAttemptRefreshForNavigation()) return false;

    const refreshed = this.refreshCriticalElementsFromDocument();
    if (!refreshed) return false;

    this.recalculateAndRenderMarkers();
    return true;
  }

  private refreshCriticalElementsFromDocument(): boolean {
    if (!this.userTurnSelector) return false;

    const elements = this.adapter.refreshElements(this.userTurnSelector);
    if (!elements) return false;
    this.conversationContainer = elements.container;
    this.navigation.setViewport(elements.viewport);

    if (this.mutationObserver && this.conversationContainer) {
      try {
        this.mutationObserver.disconnect();
        this.mutationObserver.observe(
          this.conversationContainer,
          this.adapter.observationOptions ?? { childList: true, subtree: true },
        );
      } catch {}
    }

    if (this.intersectionObserver && this.navigation.viewport) {
      try {
        this.intersectionObserver.disconnect();
        this.intersectionObserver = new IntersectionObserver(
          () => {
            this.navigation.scheduleScrollSync();
          },
          { root: this.navigation.viewport, threshold: 0.1, rootMargin: '-40% 0px -59% 0px' },
        );
      } catch {}
    }

    return true;
  }

  /**
   * True when every record was caused by the timeline's own DOM injections
   * (message timestamps or search-highlight marks). Those mutations must not
   * re-trigger a full marker recalc.
   */
  private shouldIgnoreSelfInjectedMutations(records: MutationRecord[]): boolean {
    if (records.length === 0) return false;

    return records.every((record) => {
      if (record.type !== 'childList') return false;

      const changedNodes = [...Array.from(record.addedNodes), ...Array.from(record.removedNodes)];
      if (changedNodes.length === 0) return false;

      return changedNodes.every((node) => this.isSelfInjectedMutationNode(node));
    });
  }

  private isSelfInjectedMutationNode(node: Node): boolean {
    if (node instanceof HTMLElement) {
      return (
        node.classList.contains('gv-timestamp') ||
        node.classList.contains(TimelineEngine.SEARCH_HIGHLIGHT_CLASS) ||
        !!node.closest(`.gv-timestamp, .${TimelineEngine.SEARCH_HIGHLIGHT_CLASS}`)
      );
    }

    if (node.nodeType === Node.TEXT_NODE) {
      return !!node.parentElement?.closest(
        `.gv-timestamp, .${TimelineEngine.SEARCH_HIGHLIGHT_CLASS}`,
      );
    }

    return false;
  }

  /**
   * Flush mutation records queued synchronously by the timeline's own search
   * highlight edits so they never reach the observer callback. Highlighting
   * splits text nodes inside message elements, so plain text-node changes are
   * treated as self-inflicted within this synchronous window only. Any foreign
   * (element-level) record found is re-dispatched to the debounced recalc.
   */
  private discardSelfHighlightMutationRecords(): void {
    if (!this.mutationObserver) return;
    const records = this.mutationObserver.takeRecords();
    if (records.length === 0) return;
    const hasForeign = records.some((record) => {
      if (record.type !== 'childList') return true;
      const changedNodes = [...Array.from(record.addedNodes), ...Array.from(record.removedNodes)];
      return changedNodes.some(
        (node) => node.nodeType !== Node.TEXT_NODE && !this.isSelfInjectedMutationNode(node),
      );
    });
    if (hasForeign) this.debouncedRecalc();
  }
}
