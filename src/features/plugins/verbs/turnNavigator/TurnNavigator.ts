/**
 * TurnNavigator — the conversation timeline rail behind the `turnNavigator`
 * primitive (plan §6). This is the Claude timeline's engine, parameterised by
 * a `TurnNavigatorConfig` instead of Claude-specific constants:
 *
 *   - `turnSelector` picks the user turns (normally the adapter's `userTurn`);
 *   - `conversationIdPattern` + `siteId` build the starred-message conversation
 *     id (`<siteId>:conv:<id>`), so different sites never share star storage;
 *   - `scrollContainerSelector` pins the scrolling element when auto-detection
 *     is not good enough; `yieldWhenSelector` keeps the onboarding guide closed
 *     while, say, an artifact frame is open; `position` picks the rail side.
 *
 * Markers are accumulated across refreshes by content hash so virtualised
 * conversations (Claude, DeepSeek, ChatGPT) never lose turns; see turnMerge.ts.
 */
import { StorageKeys, type TimelineStyle } from '@/core/types/common';
import { type Dispose, PluginScope } from '@/features/plugins/runtime/pluginScope';
import { requestPluginSetting } from '@/features/plugins/storage/pluginSettingRequest';
import type { PluginSettings } from '@/features/plugins/types';
import { TimelinePreviewPanel } from '@/features/timeline/TimelinePreviewPanel';
import type { PreviewMarkerData } from '@/features/timeline/types';
import { showTimelineStyleCoachmark } from '@/pages/content/timeline/timelineStyleCoachmark';
import { watchRouteChanges } from '@/pages/content/utils/routeWatcher';
import { initI18n } from '@/utils/i18n';

import type { PrimitiveHandle } from '../types';
import { buildConversationId, starConversationId, turnConversationId } from './conversationId';
import { TurnNavigation } from './navigation';
import { NavigatorStars } from './navigatorStars';
import {
  type Marker,
  type MountedTurn,
  TURN_ID_ATTR,
  mergeMountedTurns,
  rememberedMarkers,
} from './turnMerge';
import { mountedOwnershipTurns } from './turnOwnership';
import { renderedCheck, togglesVisibility } from './turnVisibility';

export interface TurnNavigatorConfig {
  /** Site adapter id; prefixes conversation ids and marks the rail. */
  readonly siteId: string;
  /** Display label, stripped from `document.title` for starred-message titles. */
  readonly siteLabel: string;
  readonly turnSelector: string;
  /** Path regular expression whose first group is the conversation id. */
  readonly conversationIdPattern?: string;
  /** Attribute holding that same id on a turn's ancestor or in its item: decides star writes. */
  readonly conversationIdAttribute?: string;
  /** Element wrapping one exchange, where `conversationIdAttribute` is looked up. */
  readonly turnItemSelector?: string;
  readonly scrollContainerSelector?: string;
  readonly yieldWhenSelector?: string;
  readonly position: 'left' | 'right';
  /** Plugin whose `compactView` setting the onboarding guide writes. */
  readonly pluginId: string;
  readonly coachmarkId: string;
}

/**
 * Shared across sites on purpose: the guide explains one Voyager feature, and
 * the id keeps the name users' `COACHMARKS_SEEN` already carry from Claude so
 * nobody sees it twice.
 */
export const TIMELINE_STYLE_COACHMARK_ID = 'claude-timeline-compact-style-intro-v1';

const TOOLTIP_ID = 'gv-turn-navigator-tooltip';
const TOOLTIP_TEXT_CLASS = 'gv-turn-navigator-tooltip-text';
const REFRESH_DELAY_MS = 120;
const LONG_PRESS_MS = 550;
const TOOLTIP_DELAY_MS = 150;
const COMPACT_VIEW_SETTING = 'compactView';
/** Compact ticks keep this pitch until the conversation outgrows the track. */
const COMPACT_TICK_PITCH_PX = 10;
/** Room kept at both track ends so the outermost ticks are never clipped. */
const COMPACT_TRACK_PADDING_PX = 16;
/** Cluster height used before the track has a layout (first paint, tests). */
const COMPACT_FALLBACK_SPAN_PX = 240;

type Dot = HTMLButtonElement & {
  dataset: DOMStringMap & { targetTurnId?: string; markerIndex?: string };
};

export class TurnNavigator {
  private bar: HTMLElement | null = null;
  private trackContent: HTMLElement | null = null;
  private tooltip: HTMLElement | null = null;
  private previewPanel: TimelinePreviewPanel | null = null;
  private observing = false;
  private markers: Marker[] = [];
  /** Route the merged markers were collected under; star reads never change it. */
  private markerRouteId = '';
  private readonly stars = new NavigatorStars({
    routeId: () => this.buildConversationId(),
    starId: () => starConversationId(this.config),
    alive: () => !this.disposed,
    turnConversation: (element) => turnConversationId(this.config, element),
  });
  private stopRefreshTimer: Dispose | null = null;
  private stopLongPressTimer: Dispose | null = null;
  private stopTooltipTimer: Dispose | null = null;
  private longPressDot: Dot | null = null;
  private suppressClickUntil = 0;
  private timelineStyle: TimelineStyle = 'dots';
  private readonly barSelector: string;
  private readonly navigation: TurnNavigation;

  constructor(
    private readonly scope: PluginScope,
    private readonly config: TurnNavigatorConfig,
  ) {
    this.barSelector = `.gemini-timeline-bar[data-gv-turn-navigator="${config.siteId}"]`;
    this.navigation = new TurnNavigation(
      scope,
      config.scrollContainerSelector,
      () => this.markers,
      (turnId, previousTurnId) => {
        if (turnId !== previousTurnId) this.updateDotActive(previousTurnId, false);
        this.updateDotActive(turnId, true);
        if (turnId !== previousTurnId) this.previewPanel?.updateActiveTurn(turnId);
      },
    );
  }

  /** `<siteId>:conv:<id>` from the site's route pattern, else a hash of the path. */
  private buildConversationId(input: string = location.href): string {
    return buildConversationId(this.config, input);
  }

  /** The onboarding guide stays closed while the yield selector matches. */
  private shouldYield(): boolean {
    const selector = this.config.yieldWhenSelector;
    if (!selector) return false;
    try {
      return !!document.querySelector(selector);
    } catch {
      return false;
    }
  }

  private get disposed(): boolean {
    return this.scope.isDisposed;
  }

  async start(settings: PluginSettings = {}): Promise<void> {
    this.updateSettings(settings);
    // A turn belongs to the conversation the URL named when it entered the page.
    this.stars.begin();
    if (document.body) {
      this.scope.observe(document.body, { childList: true, subtree: true }, (records) =>
        this.stars.recordInsertions(records),
      );
    }
    // Markers stamp `data-gv-turn-id` onto the site's own turn nodes; roll
    // every stamp back when the plugin unmounts.
    this.scope.effect(
      () => () =>
        document
          .querySelectorAll(`[${TURN_ID_ATTR}]`)
          .forEach((element) => element.removeAttribute(TURN_ID_ATTR)),
      'turn-id-attrs',
    );
    await initI18n().catch(() => {});
    if (this.disposed) return;
    this.ensureUi();
    await this.refresh();
    if (this.disposed) return;
    this.observe();
    this.scope.on(window, 'hashchange', this.navigation.handleHash);
    // A route change with no turn mutation (new chat getting its id, leaving
    // for a page without turns) must still re-key or clear the rail.
    this.scope.effect(() => watchRouteChanges(() => this.scheduleRefresh()), 'route-watch');
    this.scope.on(window, 'resize', this.handleResize);
    this.maybeShowStyleCoachmark();
  }

  updateSettings(settings: PluginSettings): void {
    const nextStyle: TimelineStyle = settings[COMPACT_VIEW_SETTING] === true ? 'compact' : 'dots';
    const changed = this.timelineStyle !== nextStyle;
    this.timelineStyle = nextStyle;
    this.applyTimelineStyle();
    if (changed && this.markers.length > 0) this.renderDots();
  }

  private maybeShowStyleCoachmark(): void {
    if (this.disposed || this.timelineStyle === 'compact') return;
    // Never open a scrimmed guide over an active artifact: the panel is part
    // of the top document view. Skipping does NOT burn the once-per-user seen
    // state, so the guide simply shows on a later artifact-free page load.
    if (this.shouldYield()) return;
    void showTimelineStyleCoachmark({
      id: this.config.coachmarkId,
      enabled: false,
      // A disposed scope aborts the signal, closing an in-flight guide.
      signal: this.scope.signal,
      onStyleChange: async (compact) => {
        if (this.disposed) return;
        this.updateSettings({ [COMPACT_VIEW_SETTING]: compact });
        await requestPluginSetting(this.config.pluginId, COMPACT_VIEW_SETTING, compact);
      },
    });
  }

  private observe(): void {
    if (!document.body || this.observing) return;
    this.observing = true;
    // A host may show or hide a whole thread without touching its turns, or edit
    // a prompt's text node in place; streamed reply text is outside every turn.
    const options: MutationObserverInit = {
      childList: true,
      characterData: true,
      subtree: true,
      attributes: true,
      attributeOldValue: true,
      attributeFilter: ['style', 'hidden'],
    };
    this.scope.observe(document.body, options, (records) => {
      if (!records.some((record) => this.shouldRefreshForMutation(record))) return;
      this.scheduleRefresh();
    });

    if (chrome.storage?.onChanged) {
      this.scope.onChromeEvent(
        chrome.storage.onChanged,
        (changes: Record<string, chrome.storage.StorageChange>, areaName: string) => {
          if (areaName !== 'local' || !changes[StorageKeys.TIMELINE_STARRED_MESSAGES]) return;
          void this.stars.load(true).then(() => this.applyStarredState());
        },
      );
    }
  }

  private isOwnMutation(record: MutationRecord): boolean {
    const nodes = [
      record.target,
      ...Array.from(record.addedNodes),
      ...Array.from(record.removedNodes),
    ];
    return nodes.every((node) => {
      const element =
        node instanceof window.Element
          ? node
          : node.parentElement instanceof window.Element
            ? node.parentElement
            : null;
      return !!element?.closest(
        '[data-gv-turn-navigator], .timeline-preview-panel, .timeline-preview-toggle',
      );
    });
  }

  private shouldRefreshForMutation(record: MutationRecord): boolean {
    if (this.isOwnMutation(record)) return false;
    if (record.type === 'attributes') {
      return togglesVisibility(record) && this.touchesTurn(record.target);
    }
    return (
      !!this.toElement(record.target)?.closest(this.config.turnSelector) ||
      [...Array.from(record.addedNodes), ...Array.from(record.removedNodes)].some((node) =>
        this.touchesTurn(node),
      )
    );
  }

  private touchesTurn(node: Node): boolean {
    const { turnSelector } = this.config;
    const element = this.toElement(node);
    return !!(element?.closest(turnSelector) || element?.querySelector?.(turnSelector));
  }

  private toElement(node: Node): Element | null {
    return node instanceof window.Element
      ? node
      : node.parentElement instanceof window.Element
        ? node.parentElement
        : null;
  }

  private ensureUi(): void {
    let bar = document.querySelector(this.barSelector) as HTMLElement | null;
    if (!bar) {
      bar = document.createElement('div');
      bar.className = 'gemini-timeline-bar';
      bar.dataset.gvTurnNavigator = this.config.siteId;
      if (this.config.position === 'left') {
        bar.dataset.gvPosition = 'left';
        bar.style.right = 'auto';
        bar.style.left = '15px';
      }
      const track = document.createElement('div');
      track.className = 'timeline-track';
      const content = document.createElement('div');
      content.className = 'timeline-track-content';
      track.appendChild(content);
      bar.appendChild(track);
      this.scope.mount(bar, document.body);
    }
    this.bar = bar;
    this.trackContent = bar.querySelector('.timeline-track-content') as HTMLElement | null;
    if (!this.tooltip) {
      const tooltip = document.createElement('div');
      tooltip.id = TOOLTIP_ID;
      tooltip.className = 'timeline-tooltip';
      tooltip.setAttribute('aria-hidden', 'true');
      const text = document.createElement('div');
      text.className = TOOLTIP_TEXT_CLASS;
      tooltip.appendChild(text);
      this.scope.mount(tooltip, document.body);
      this.tooltip = tooltip;
    }
    if (!this.previewPanel) {
      this.previewPanel = new TimelinePreviewPanel(bar);
      this.previewPanel.init(
        (turnId) => this.navigation.navigateTo(turnId),
        undefined,
        (turnId) => this.toggleStar(turnId),
      );
      // The panel manages its own timers/listeners/DOM; adopt its destroy().
      this.scope.child(this.previewPanel, 'preview-panel');
    }
    this.applyTimelineStyle();
  }

  private applyTimelineStyle(): void {
    if (!this.bar) return;
    const compact = this.timelineStyle === 'compact';
    this.bar.classList.toggle('timeline-style-compact', compact);
    const track = this.trackContent?.parentElement;
    if (compact) {
      track?.setAttribute('aria-hidden', 'true');
      this.hideTooltip();
    } else {
      track?.removeAttribute('aria-hidden');
    }
    this.previewPanel?.setCompactMode(compact);
  }

  private scheduleRefresh(): void {
    if (this.disposed) return;
    void this.stopRefreshTimer?.();
    this.stopRefreshTimer = this.scope.timer(() => {
      this.stopRefreshTimer = null;
      void this.refresh();
    }, REFRESH_DELAY_MS);
  }

  private async refresh(): Promise<void> {
    if (this.disposed) return;
    this.ensureUi();
    const routeId = this.buildConversationId();
    if (routeId !== this.markerRouteId) {
      this.resetConversationState();
      this.markerRouteId = routeId;
    }
    await this.stars.load();
    if (this.disposed) return;
    const previousIds = this.markers.map((marker) => marker.id);
    const readText = (element: HTMLElement) => this.extractText(element);
    const centerOf = (element: HTMLElement) => this.navigation.centerOf(element);
    const mounted: MountedTurn[] = Array.from(
      document.querySelectorAll<HTMLElement>(this.config.turnSelector),
    )
      .filter(renderedCheck())
      .map((element) => ({ element, summary: readText(element) }));
    if (mounted[0]) this.navigation.prepare(mounted[0].element);
    this.markers = mergeMountedTurns(rememberedMarkers(this.markers, mounted), mounted, centerOf);
    // A press that began under the previous route must not land under this one.
    if (this.stars.observe(mountedOwnershipTurns(mounted))) this.cancelLongPress();
    this.navigation.measure();
    const sameMarkers =
      previousIds.length === this.markers.length &&
      previousIds.every((id, index) => id === this.markers[index]?.id);
    if (!sameMarkers || this.markers.some((marker) => !marker.dotElement)) this.renderDots();
    this.applyStarredState();
    this.navigation.refreshActive();
    this.navigation.handleHash();
  }

  private resetConversationState(): void {
    this.markers = [];
    this.navigation.reset();
    if (this.trackContent) this.trackContent.textContent = '';
  }

  private renderDots(): void {
    if (!this.trackContent) return;
    this.trackContent.textContent = '';
    const last = Math.max(1, this.markers.length - 1);
    const compactOffsets = this.buildCompactMarkerOffsets();
    this.markers.forEach((marker, index) => {
      const dot = document.createElement('button') as Dot;
      dot.className = 'timeline-dot';
      dot.type = 'button';
      dot.dataset.targetTurnId = marker.id;
      dot.dataset.markerIndex = String(index);
      if (this.timelineStyle === 'compact') {
        dot.style.setProperty('--timeline-compact-offset', `${compactOffsets[index] ?? 0}px`);
      } else {
        dot.style.setProperty('--n', String(this.markers.length === 1 ? 0.5 : index / last));
      }
      dot.setAttribute('aria-label', marker.summary || `Message ${index + 1}`);
      dot.setAttribute('aria-pressed', marker.starred ? 'true' : 'false');
      dot.setAttribute('aria-current', marker.id === this.navigation.activeId ? 'true' : 'false');
      dot.classList.toggle('starred', marker.starred);
      dot.classList.toggle('active', marker.id === this.navigation.activeId);
      dot.addEventListener('click', (event) => {
        // The compact rail is itself the preview-panel toggle: a tick click
        // must jump, not toggle the panel it bubbles up to.
        event.stopPropagation();
        if (Date.now() < this.suppressClickUntil) {
          event.preventDefault();
          return;
        }
        this.navigation.navigateTo(marker.id);
      });
      dot.addEventListener('pointerdown', () => this.startLongPress(dot));
      dot.addEventListener('pointerup', () => this.cancelLongPress());
      dot.addEventListener('pointercancel', () => this.cancelLongPress());
      dot.addEventListener('pointerenter', () => this.scheduleTooltip(dot));
      dot.addEventListener('pointerleave', () => {
        this.cancelLongPress();
        this.hideTooltip();
      });
      dot.addEventListener('focus', () => this.showTooltip(dot));
      dot.addEventListener('blur', () => this.hideTooltip());
      marker.dotElement = dot;
      this.trackContent!.appendChild(dot);
    });
  }

  /**
   * Compact ticks keep a fixed pitch and spread over the whole track; the
   * pitch only shrinks once a conversation outgrows the track. A fixed-height
   * cluster turned every long conversation into an unreadable barcode.
   */
  private buildCompactMarkerOffsets(): number[] {
    const count = this.markers.length;
    if (count === 0) return [];
    const trackHeight = this.trackContent?.parentElement?.clientHeight ?? 0;
    const span =
      trackHeight > 0
        ? Math.max(0, trackHeight - COMPACT_TRACK_PADDING_PX * 2)
        : COMPACT_FALLBACK_SPAN_PX;
    const gap = count > 1 ? Math.min(COMPACT_TICK_PITCH_PX, span / (count - 1)) : 0;
    const center = (count - 1) / 2;
    return this.markers.map((_, index) => (index - center) * gap);
  }

  /** Re-space the existing compact ticks after the track changes height. */
  private applyCompactOffsets(): void {
    if (this.timelineStyle !== 'compact') return;
    const offsets = this.buildCompactMarkerOffsets();
    this.markers.forEach((marker, index) => {
      marker.dotElement?.style.setProperty('--timeline-compact-offset', `${offsets[index] ?? 0}px`);
    });
  }

  private startLongPress(dot: Dot): void {
    this.cancelLongPress();
    const marker = this.markers.find((item) => item.id === dot.dataset.targetTurnId);
    if (this.disposed || !marker) return;
    if (!this.stars.canStar(marker.element)) return;
    this.longPressDot = dot;
    dot.classList.add('holding');
    this.stopLongPressTimer = this.scope.timer(() => {
      this.stopLongPressTimer = null;
      this.suppressClickUntil = Date.now() + 350;
      const id = dot.dataset.targetTurnId;
      if (id) void this.toggleStar(id);
      this.cancelLongPress();
    }, LONG_PRESS_MS);
  }

  private cancelLongPress(): void {
    void this.stopLongPressTimer?.();
    this.stopLongPressTimer = null;
    this.longPressDot?.classList.remove('holding');
    this.longPressDot = null;
  }

  private async toggleStar(turnId: string): Promise<void> {
    const marker = this.markers.find((item) => item.id === turnId);
    if (!marker) return;
    const describe = () => ({ url: location.href.split('#')[0], title: this.getTitle() });
    if (await this.stars.toggle({ ...marker }, describe)) this.applyStarredState();
  }

  private applyStarredState(): void {
    this.markers.forEach((marker) => {
      const entry = this.stars.get(marker.hash);
      marker.starred = !!entry;
      marker.starredAt = entry?.starredAt;
      marker.dotElement?.classList.toggle('starred', marker.starred);
      marker.dotElement?.setAttribute('aria-pressed', marker.starred ? 'true' : 'false');
    });
    this.updatePreview();
  }

  private updatePreview(): void {
    const previewMarkers: PreviewMarkerData[] = this.markers.map((marker, index) => ({
      id: marker.id,
      summary: marker.summary,
      index,
      starred: marker.starred,
      starredAt: marker.starredAt,
    }));
    this.previewPanel?.updateMarkers(previewMarkers);
    this.previewPanel?.updateActiveTurn(this.navigation.activeId);
  }

  private updateDotActive(turnId: string | null, active: boolean): void {
    const dot = this.markers.find((marker) => marker.id === turnId)?.dotElement;
    dot?.classList.toggle('active', active);
    dot?.setAttribute('aria-current', active ? 'true' : 'false');
  }

  private scheduleTooltip(dot: Dot): void {
    // Compact ticks are clickable but stay quiet: the preview panel already
    // lists every turn while the rail is hovered.
    if (this.disposed || this.timelineStyle === 'compact') return;
    void this.stopTooltipTimer?.();
    this.stopTooltipTimer = this.scope.timer(() => {
      this.stopTooltipTimer = null;
      this.showTooltip(dot);
    }, TOOLTIP_DELAY_MS);
  }

  private showTooltip(dot: Dot): void {
    if (!this.tooltip || !dot.isConnected || this.timelineStyle === 'compact') return;
    const marker = this.markers.find((item) => item.id === dot.dataset.targetTurnId);
    if (!marker?.summary) return;

    this.getTooltipTextElement().textContent = `${marker.starred ? '★ ' : ''}${marker.summary}`;
    this.tooltip.setAttribute('dir', 'auto');
    this.tooltip.setAttribute('aria-hidden', 'false');
    this.tooltip.style.width = 'min(288px, calc(100vw - 32px))';

    const rect = dot.getBoundingClientRect();
    const gap = 18;
    const tooltipWidth = this.tooltip.offsetWidth || 288;
    const tooltipHeight = this.tooltip.offsetHeight || 78;
    const leftPlacement = rect.left > window.innerWidth / 2;
    const left = leftPlacement ? rect.left - gap - tooltipWidth : rect.right + gap;
    const top = Math.max(
      8,
      Math.min(
        window.innerHeight - tooltipHeight - 8,
        rect.top + rect.height / 2 - tooltipHeight / 2,
      ),
    );
    this.tooltip.style.left = `${Math.max(8, Math.round(left))}px`;
    this.tooltip.style.top = `${Math.round(top)}px`;
    this.tooltip.setAttribute('data-placement', leftPlacement ? 'left' : 'right');
    this.tooltip.classList.add('visible');
  }

  private hideTooltip(): void {
    void this.stopTooltipTimer?.();
    this.stopTooltipTimer = null;
    this.tooltip?.classList.remove('visible');
    this.tooltip?.setAttribute('aria-hidden', 'true');
  }

  private getTooltipTextElement(): HTMLElement {
    return (this.tooltip?.firstElementChild as HTMLElement | null) ?? this.tooltip!;
  }

  private handleResize = (): void => {
    this.applyCompactOffsets();
    this.scheduleRefresh();
    this.previewPanel?.reposition();
  };

  private extractText(element: HTMLElement): string {
    return (element.textContent || '').replace(/\s+/g, ' ').trim();
  }

  private getTitle(): string {
    const label = this.config.siteLabel.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const title = document.title.replace(new RegExp(`\\s*[|-]\\s*${label}.*$`, 'i'), '').trim();
    return (
      title || this.markers[0]?.summary.slice(0, 50) || `${this.config.siteLabel} conversation`
    );
  }
}

/**
 * Run a navigator under `scope`; the returned handle applies setting changes
 * in place (the rail and its grow-only markers survive a compact toggle).
 */
export function activateTurnNavigator(
  scope: PluginScope,
  config: TurnNavigatorConfig,
  settings: PluginSettings = {},
): PrimitiveHandle {
  const navigator = new TurnNavigator(scope, config);
  // Startup registers as a pending effect: dispose() barriers on it, and a
  // mid-startup unmount is handled by the scope instead of a destroyed flag.
  scope.effect(() => navigator.start(settings).then(() => () => {}), 'turn-navigator-start');
  return {
    updateSettings: (next) => navigator.updateSettings(next),
  };
}
