import { type TimelineStyle } from '@/core/types/common';
import { applyRTLClass } from '@/core/utils/rtl';

import { getTimelineSpringProfile } from './TimelineNavigation';
import { TimelinePreviewPanel } from './TimelinePreviewPanel';
import { TimelineRailPlacement } from './TimelineRailPlacement';
import { TimelineSlider } from './TimelineSlider';
import type { TimelineState } from './TimelineState';
import type { TimelinePositionData } from './types';
import type { DotElement } from './types';
interface TimelineViewOptions {
  getViewport: () => HTMLElement | null;
  getActiveId: () => string | null;
  navigate: (turnId: string, index: number) => void;
  search: (query: string) => void;
  onStyleChange: () => void;
  onResize: () => void;
}
/** Owns the timeline rail, rendered dots, slider and their pointer/resize lifetimes. */
export class TimelineView {
  ui: {
    timelineBar: HTMLElement | null;
    track?: HTMLElement | null;
    trackContent?: HTMLElement | null;
    slider?: HTMLElement | null;
    sliderHandle?: HTMLElement | null;
  } = { timelineBar: null };

  timelineStyle: TimelineStyle = 'dots';

  hideContainer: boolean = false;

  private runnerRing: HTMLElement | null = null;

  private runnerAnimationGeneration = 0;

  private contentHeight = 0;

  yPositions: number[] = [];

  markerTops: number[] = [];

  private visibleRange: { start: number; end: number } = { start: 0, end: -1 };

  firstUserTurnOffset = 0;

  contentSpanPx = 1;

  private usePixelTop = false;

  private _cssVarTopSupported: boolean | null = null;

  private resizeIdleTimer: number | null = null;

  private resizeIdleDelay = 140;

  previewPanel: TimelinePreviewPanel | null = null;

  rtl = false;
  private readonly dots = new Map<string, DotElement>();
  private normalizedPositions: number[] = [];
  private destroyed = false;
  private runnerRaf: number | null = null;
  private resizeObserver: ResizeObserver | null = null;
  private readonly lifetime = new AbortController();
  constructor(
    private readonly state: TimelineState,
    private readonly options: TimelineViewOptions,
  ) {
    this.placement = new TimelineRailPlacement({
      getStyle: () => this.timelineStyle,
      onWidthChange: () => this.applyContainerVisibility(),
    });
  }
  private readonly placement: TimelineRailPlacement;
  private slider: TimelineSlider | null = null;

  get barWidth(): number {
    return this.placement.barWidth;
  }
  set barWidth(value: number) {
    this.placement.barWidth = value;
  }
  get barWidthMin(): number {
    return this.placement.barWidthMin;
  }
  get barWidthMax(): number {
    return this.placement.barWidthMax;
  }
  get savedTimelinePosition(): TimelinePositionData | null {
    return this.placement.savedPosition;
  }
  set savedTimelinePosition(value: TimelinePositionData | null) {
    this.placement.savedPosition = value;
  }
  updateSlider(): void {
    this.slider?.update();
  }
  updateSliderPosition(): void {
    this.slider?.updatePosition();
  }
  toggleDraggable(enabled: boolean): void {
    this.placement.toggleDraggable(enabled);
  }
  applyPosition(top: number, left: number): void {
    if (!this.ui.timelineBar) return;
    this.placement.applyPosition(top, left);
    this.previewPanel?.reposition();
  }
  updateRulerDirection(left?: number): void {
    this.placement.updateRulerDirection(left);
  }
  reapplyPosition(): void {
    if (this.placement.reapplyPosition()) this.previewPanel?.reposition();
  }
  private get markers() {
    return this.state.markers;
  }
  private get scrollContainer() {
    return this.options.getViewport();
  }
  private get activeTurnId() {
    return this.options.getActiveId();
  }
  private getActiveIndex() {
    return this.markers.findIndex((marker) => marker.id === this.activeTurnId);
  }
  mount(): void {
    if (this.destroyed) return;
    let bar = document.querySelector('.gemini-timeline-bar') as HTMLElement | null;
    if (!bar) {
      bar = document.createElement('div');
      bar.className = 'gemini-timeline-bar';
      document.body.appendChild(bar);
    }
    this.ui.timelineBar = bar;
    let track = bar.querySelector('.timeline-track') as HTMLElement | null;
    if (!track) {
      track = document.createElement('div');
      track.className = 'timeline-track';
      bar.appendChild(track);
    }
    let content = track.querySelector('.timeline-track-content') as HTMLElement | null;
    if (!content) {
      content = document.createElement('div');
      content.className = 'timeline-track-content';
      track.appendChild(content);
    }
    this.ui.track = track;
    this.ui.trackContent = content;

    let slider = document.querySelector('.timeline-left-slider') as HTMLElement | null;
    if (!slider) {
      slider = document.createElement('div');
      slider.className = 'timeline-left-slider';
      const handle = document.createElement('div');
      handle.className = 'timeline-left-handle';
      slider.appendChild(handle);
      document.body.appendChild(slider);
    }
    this.ui.slider = slider;
    this.ui.sliderHandle = slider.querySelector('.timeline-left-handle') as HTMLElement | null;

    this.previewPanel = new TimelinePreviewPanel(bar);
    this.previewPanel.init(this.options.navigate, this.options.search, (id) =>
      this.state.toggleStar(id),
    );
    this.slider = new TimelineSlider(bar, track, slider, this.ui.sliderHandle, {
      getLayout: () => ({
        contentHeight: this.contentHeight,
        padding: this.getTrackPadding(),
        rtl: this.rtl,
      }),
      onScroll: () => this.updateVirtualRangeAndRender(),
    });
    this.placement.mount(bar);
    this.setupEventListeners();
    this.resizeObserver = new ResizeObserver(() => this.render());
    this.resizeObserver.observe(bar);
  }
  render(): void {
    if (this.destroyed) return;
    this.updateTimelineGeometry();
    this.syncTimelineTrackToMain();
    this.updateVirtualRangeAndRender();
    this.updateSlider();
  }
  updateActiveDotUI(): void {
    for (const [id, dot] of this.dots) dot.classList.toggle('active', id === this.activeTurnId);
    this.previewPanel?.updateActiveTurn(this.activeTurnId);
  }
  updatePreviewMarkers(): void {
    this.previewPanel?.updateMarkers(
      this.markers.map((marker, index) => ({
        id: marker.id,
        summary: marker.summary,
        index,
        starred: marker.starred,
      })),
    );
  }
  updateVirtualRangeAndRender(): void {
    if (!this.ui.track || !this.ui.trackContent) return;
    const hidden = this.state.getHiddenMarkerIndices();
    const dense = this.timelineStyle !== 'dots';
    const top = this.ui.track.scrollTop;
    const height = this.ui.track.clientHeight;
    const buffer = Math.max(100, height);
    const start = dense ? 0 : this.lowerBound(this.yPositions, top - buffer);
    const end = dense
      ? this.markers.length - 1
      : Math.max(start - 1, this.upperBound(this.yPositions, top + height + buffer));
    const offsets = dense ? this.buildCompactMarkerOffsets(hidden) : new Map<number, number>();
    const visibleIds = new Set<string>();
    const fragment = document.createDocumentFragment();
    for (let index = start; index <= end; index++) {
      const marker = this.markers[index];
      if (!marker || hidden.has(index)) continue;
      visibleIds.add(marker.id);
      let dot = this.dots.get(marker.id);
      if (!dot) {
        dot = document.createElement('button') as DotElement;
        dot.className = 'timeline-dot';
        dot.dataset.targetTurnId = marker.id;
        dot.setAttribute('tabindex', '0');
        dot.setAttribute('aria-describedby', 'gemini-timeline-tooltip');
        this.dots.set(marker.id, dot);
        fragment.appendChild(dot);
      }
      dot.dataset.markerIndex = String(index);
      dot.setAttribute('aria-label', marker.summary);
      this.applyDotPosition(dot, index, offsets.get(index));
      const collapsed = this.state.isMarkerCollapsed(marker.id);
      dot.classList.toggle('active', marker.id === this.activeTurnId);
      dot.classList.toggle('starred', marker.starred);
      dot.classList.toggle('collapsed', collapsed);
      dot.setAttribute('aria-pressed', String(marker.starred));
      dot.setAttribute('aria-expanded', String(!collapsed));
      dot.dataset.level = String(this.state.getMarkerLevel(marker.id));
    }
    for (const [id, dot] of this.dots) {
      if (visibleIds.has(id)) continue;
      dot.remove();
      this.dots.delete(id);
    }
    this.ui.trackContent.appendChild(fragment);
    this.visibleRange = { start, end };
    this.updateRulerWave();
  }
  private setupEventListeners(): void {
    const signal = this.lifetime.signal;
    this.ui.timelineBar!.addEventListener(
      'wheel',
      (event) => {
        if (this.scrollContainer) this.scrollContainer.scrollTop += event.deltaY;
        this.slider?.show();
        event.preventDefault();
      },
      { passive: false, signal },
    );
    // Both resize sources funnel through one trailing debounce so a resize
    // burst runs geometry/layout work only once per idle window.
    const onWindowResize = () => this.scheduleResizeWork();
    window.addEventListener('resize', onWindowResize, { signal: this.lifetime.signal });
    if (window.visualViewport) {
      const onVisualViewportResize = () => this.scheduleResizeWork();
      window.visualViewport.addEventListener('resize', onVisualViewportResize, {
        signal: this.lifetime.signal,
      });
    }
  }
  destroy(): void {
    this.destroyed = true;

    this.lifetime.abort();
    this.resizeObserver?.disconnect();
    if (this.runnerRaf !== null) cancelAnimationFrame(this.runnerRaf);
    if (this.resizeIdleTimer !== null) clearTimeout(this.resizeIdleTimer);
    this.slider?.destroy();
    this.placement.destroy();
    this.previewPanel?.destroy();
    this.previewPanel = null;
    this.ui.slider?.remove();
    this.ui.timelineBar?.remove();
    this.ui = { timelineBar: null };
    this.dots.clear();
  }
  applyContainerVisibility(): void {
    if (!this.ui.timelineBar) return;
    const bar = this.ui.timelineBar;
    // Visual background width (::before is centered, bar stays 24px for dots)
    bar.style.setProperty('--timeline-bar-width', `${this.barWidth}px`);
    // hideContainer is an independent binary toggle
    bar.classList.toggle('timeline-no-container', !!this.hideContainer);
  }

  applyTimelineStyle(): void {
    const bar = this.ui.timelineBar;
    if (!bar) return;
    const compact = this.timelineStyle === 'compact';
    const ruler = this.timelineStyle === 'ruler';
    const dense = compact || ruler;
    bar.classList.toggle('timeline-style-compact', compact);
    bar.classList.toggle('gv-timeline-style-ruler', ruler);
    this.updateRulerDirection();
    this.ui.slider?.classList.toggle('timeline-style-compact', dense);
    this.options.onStyleChange();
    if (dense) {
      if (this.ui.track) this.ui.track.scrollTop = 0;
    }
    if (compact) {
      this.ui.track?.setAttribute('aria-hidden', 'true');
    } else {
      this.ui.track?.removeAttribute('aria-hidden');
      if (!ruler) this.syncTimelineTrackToMain();
    }
    this.previewPanel?.setCompactMode(compact);
    this.previewPanel?.setFloatingToggleSuppressed(ruler);
    this.updateVirtualRangeAndRender();
    this.updateSlider();
  }

  private getCSSVarNumber(el: Element, name: string, fallback: number): number {
    const v = getComputedStyle(el).getPropertyValue(name).trim();
    const n = parseFloat(v);
    return Number.isFinite(n) ? n : fallback;
  }

  private getTrackPadding(): number {
    return this.ui.timelineBar
      ? this.getCSSVarNumber(this.ui.timelineBar, '--timeline-track-padding', 12)
      : 12;
  }

  private getMinGap(): number {
    return this.ui.timelineBar
      ? this.getCSSVarNumber(this.ui.timelineBar, '--timeline-min-gap', 12)
      : 12;
  }

  private detectCssVarTopSupport(pad: number, usableC: number): boolean {
    try {
      const test = document.createElement('button');
      test.className = 'timeline-dot';
      test.style.visibility = 'hidden';
      test.setAttribute('aria-hidden', 'true');
      test.style.setProperty('--n', '0.5');
      this.ui.trackContent!.appendChild(test);
      const cs = getComputedStyle(test);
      const px = parseFloat(cs.top || '');
      test.remove();
      const expected = pad + 0.5 * usableC;
      return Number.isFinite(px) && Math.abs(px - expected) <= 2;
    } catch {
      return false;
    }
  }

  updateTimelineGeometry(): void {
    if (!this.ui.timelineBar || !this.ui.trackContent) return;
    const H = this.ui.timelineBar.clientHeight || 0;
    const pad = this.getTrackPadding();
    const minGap = this.getMinGap();
    const N = this.markers.length;
    // Get hidden markers for collapse feature
    const hiddenIndices = this.state.getHiddenMarkerIndices();
    const visibleCount = N - hiddenIndices.size;
    const desired = Math.max(
      H,
      visibleCount > 0 ? 2 * pad + Math.max(0, visibleCount - 1) * minGap : H,
    );
    this.contentHeight = Math.ceil(desired);
    this.ui.trackContent.style.height = `${this.contentHeight}px`;

    const usableC = Math.max(1, this.contentHeight - 2 * pad);
    // Calculate Y positions with collapse - using effective baseN for repositioning
    const { desiredY } = this.state.calculateCollapsedPositions(hiddenIndices, pad, usableC);

    // Apply min gap only to visible markers
    const gapMultipliers: number[] = new Array(N).fill(1.0);
    const adjusted = this.applyMinGapWithHidden(
      desiredY,
      pad,
      pad + usableC,
      minGap,
      hiddenIndices,
      gapMultipliers,
    );
    this.yPositions = adjusted;

    for (let i = 0; i < N; i++) {
      if (hiddenIndices.has(i)) {
        this.normalizedPositions[i] = -1;
        continue;
      }
      const top = adjusted[i];
      const n = (top - pad) / usableC;
      this.normalizedPositions[i] = Math.max(0, Math.min(1, n));
      const dot = this.dots.get(this.markers[i].id);
      if (dot && !this.usePixelTop) {
        dot.style.setProperty('--n', String(this.normalizedPositions[i]));
      }
    }
    if (this._cssVarTopSupported === null) {
      this._cssVarTopSupported = this.detectCssVarTopSupport(pad, usableC);
      this.usePixelTop = !this._cssVarTopSupported;
    }
    this.slider?.updateGeometry();
  }

  /* Apply minimum gap between visible markers, skipping hidden ones */
  private applyMinGapWithHidden(
    positions: number[],
    minTop: number,
    maxTop: number,
    gap: number,
    hiddenIndices: Set<number>,
    gapMultipliers: number[],
  ): number[] {
    const n = positions.length;
    if (n === 0) return positions;

    const out = positions.slice();
    let prevVisibleIdx = -1;
    for (let i = 0; i < n; i++) {
      if (hiddenIndices.has(i)) continue;

      if (prevVisibleIdx === -1) {
        out[i] = Math.max(minTop, Math.min(positions[i], maxTop));
      } else {
        const currentGap = gap * gapMultipliers[i];
        const minAllowed = out[prevVisibleIdx] + currentGap;
        out[i] = Math.max(positions[i], minAllowed);
      }
      prevVisibleIdx = i;
    }
    let lastVisibleIdx = -1;
    for (let i = n - 1; i >= 0; i--) {
      if (!hiddenIndices.has(i)) {
        lastVisibleIdx = i;
        break;
      }
    }

    if (lastVisibleIdx >= 0 && out[lastVisibleIdx] > maxTop) {
      out[lastVisibleIdx] = maxTop;

      let nextVisibleIdx = lastVisibleIdx;
      for (let i = lastVisibleIdx - 1; i >= 0; i--) {
        if (hiddenIndices.has(i)) continue;

        const currentGap = gap * gapMultipliers[nextVisibleIdx];
        const maxAllowed = out[nextVisibleIdx] - currentGap;
        out[i] = Math.min(out[i], maxAllowed);
        nextVisibleIdx = i;
      }
    }

    // Clamp all visible markers
    for (let i = 0; i < n; i++) {
      if (hiddenIndices.has(i)) continue;
      if (out[i] < minTop) out[i] = minTop;
      if (out[i] > maxTop) out[i] = maxTop;
    }

    return out;
  }

  private ensureRunnerRing(): void {
    if (!this.ui.trackContent) return;
    if (!this.runnerRing) {
      const ring = document.createElement('div');
      ring.className = 'timeline-runner-ring';
      Object.assign(ring.style, {
        position: 'absolute',
        left: '50%',
        top: '0',
        width: '20px',
        height: '20px',
        transform: 'translate3d(-50%, -10px, 0)',
        borderRadius: '9999px',
        boxShadow: '0 0 0 2px var(--timeline-dot-active-color), 0 0 12px rgba(59,130,246,.45)',
        background: 'transparent',
        pointerEvents: 'none',
        zIndex: '4',
        opacity: '0',
        transition: 'opacity 120ms ease',
        willChange: 'transform, opacity',
      } as CSSStyleDeclaration);
      this.ui.trackContent.appendChild(ring);
      this.runnerRing = ring;
    }
  }

  startRunner(fromIdx: number, toIdx: number, duration: number): void {
    this.ensureRunnerRing();
    if (!this.runnerRing) return;
    if (this.runnerRaf !== null) cancelAnimationFrame(this.runnerRaf);
    const animationGeneration = ++this.runnerAnimationGeneration;
    const y1 = Math.round(this.yPositions[fromIdx]);
    const y2 = Math.round(this.yPositions[toIdx]);
    const spring = getTimelineSpringProfile();
    const t0 =
      typeof performance !== 'undefined' && performance.now ? performance.now() : Date.now();
    this.runnerRing.style.opacity = '1';
    const animate = () => {
      if (this.destroyed || animationGeneration !== this.runnerAnimationGeneration) {
        return;
      }
      const now =
        typeof performance !== 'undefined' && performance.now ? performance.now() : Date.now();
      const t = Math.min(1, (now - t0) / Math.max(1, duration));
      let eased: number;
      if (spring === 'snappy') eased = Math.min(1, t + 0.08 * Math.sin(t * 8));
      else if (spring === 'gentle') eased = t * t * (3 - 2 * t);
      else eased = t * t * (3 - 2 * t) * 0.85 + t * 0.15;
      const y = Math.round(y1 + (y2 - y1) * eased);
      if (this.runnerRing) {
        this.runnerRing.style.transform = `translate3d(-50%, ${y - 10}px, 0)`;
      }
      if (t < 1) {
        this.runnerRaf = requestAnimationFrame(animate);
      } else {
        if (this.runnerRing) {
          this.runnerRing.style.opacity = '0';
        }
      }
    };
    animate();
  }

  syncTimelineTrackToMain(): void {
    if (this.timelineStyle !== 'dots') return;
    if (this.slider?.dragging) return;
    if (!this.ui.track || !this.scrollContainer || !this.contentHeight) return;
    const scrollTop = this.scrollContainer.scrollTop;
    const ref = scrollTop + this.scrollContainer.clientHeight * 0.45;
    const span = Math.max(1, this.contentSpanPx || 1);
    const r = Math.max(0, Math.min(1, (ref - (this.firstUserTurnOffset || 0)) / span));
    const maxScroll = Math.max(0, this.contentHeight - (this.ui.track.clientHeight || 0));
    const target = Math.round(r * maxScroll);
    if (Math.abs((this.ui.track.scrollTop || 0) - target) > 1) this.ui.track.scrollTop = target;
  }

  private lowerBound(arr: number[], x: number): number {
    let lo = 0,
      hi = arr.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (arr[mid] < x) lo = mid + 1;
      else hi = mid;
    }
    return lo;
  }

  private upperBound(arr: number[], x: number): number {
    let lo = 0,
      hi = arr.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (arr[mid] <= x) lo = mid + 1;
      else hi = mid;
    }
    return lo - 1;
  }

  private getRulerFocusIndex(): number {
    const fallback = Math.max(0, this.getActiveIndex());
    if (
      !this.scrollContainer ||
      this.markerTops.length !== this.markers.length ||
      this.markerTops.length === 0
    ) {
      return fallback;
    }

    const focusTop =
      this.scrollContainer.scrollTop + Math.max(0, this.scrollContainer.clientHeight) * 0.45;
    const upperIndex = this.lowerBound(this.markerTops, focusTop);
    if (upperIndex <= 0) return 0;
    if (upperIndex >= this.markerTops.length) return this.markerTops.length - 1;

    const lowerIndex = upperIndex - 1;
    const lowerTop = this.markerTops[lowerIndex];
    const upperTop = this.markerTops[upperIndex];
    const progress = Math.max(
      0,
      Math.min(1, (focusTop - lowerTop) / Math.max(1, upperTop - lowerTop)),
    );
    return lowerIndex + progress;
  }

  /** Smooth Gaussian crest that travels through the ruler as the page scrolls. */
  private updateRulerWave(): void {
    if (this.timelineStyle !== 'ruler') {
      this.markers.forEach((marker) => {
        this.dots.get(marker.id)?.style.removeProperty('--gv-timeline-ruler-scale');
        this.dots.get(marker.id)?.style.removeProperty('--gv-timeline-ruler-opacity');
      });
      return;
    }

    const focusIndex = this.getRulerFocusIndex();
    const sigma = 1.2;
    const start = Math.max(0, this.visibleRange.start);
    const end =
      this.visibleRange.end >= start
        ? Math.min(this.visibleRange.end, this.markers.length - 1)
        : this.markers.length - 1;
    for (let index = start; index <= end; index++) {
      const marker = this.markers[index];
      if (!marker) continue;
      const dot = this.dots.get(marker.id);
      if (!dot) continue;
      const level = this.state.getMarkerLevel(marker.id);
      const baseScale = level === 3 ? 0.54 : level === 2 ? 0.42 : 0.29;
      const distance = Math.abs(index - focusIndex);
      const crest = Math.exp(-(distance * distance) / (2 * sigma * sigma));
      const scale = baseScale + (1 - baseScale) * crest;
      const opacity = 0.42 + 0.5 * crest;
      dot.style.setProperty('--gv-timeline-ruler-scale', scale.toFixed(3));
      dot.style.setProperty('--gv-timeline-ruler-opacity', opacity.toFixed(3));
    }
  }

  private buildCompactMarkerOffsets(hiddenIndices: ReadonlySet<number>): Map<number, number> {
    const visibleIndices: number[] = [];
    for (let index = 0; index < this.markers.length; index++) {
      if (!hiddenIndices.has(index)) visibleIndices.push(index);
    }

    const offsets = new Map<number, number>();
    const count = visibleIndices.length;
    if (count === 0) return offsets;
    const gap = count > 1 ? Math.min(8, 160 / (count - 1)) : 0;
    const center = (count - 1) / 2;
    visibleIndices.forEach((markerIndex, rank) => {
      offsets.set(markerIndex, (rank - center) * gap);
    });
    return offsets;
  }

  private applyDotPosition(dot: DotElement, index: number, compactOffset?: number): void {
    if (this.timelineStyle === 'compact' || this.timelineStyle === 'ruler') {
      const offset = compactOffset ?? 0;
      const operator = offset < 0 ? '-' : '+';
      dot.style.top = `calc(50% ${operator} ${Math.abs(offset)}px)`;
      dot.style.setProperty('--timeline-compact-offset', `${offset}px`);
      return;
    }

    dot.style.removeProperty('--timeline-compact-offset');
    dot.style.setProperty('--n', String(this.normalizedPositions[index] || 0));
    if (this.usePixelTop) {
      dot.style.top = `${Math.round(this.yPositions[index])}px`;
    } else {
      dot.style.removeProperty('top');
    }
  }

  /** Reset inline placement when the page direction changes. */
  applyRTLUpdate(language?: string | null): void {
    const wasRTL = this.rtl;
    this.rtl = applyRTLClass(language);
    if (wasRTL !== this.rtl) {
      // Reset inline position so the CSS default for the new direction takes effect
      if (this.ui.timelineBar) {
        this.ui.timelineBar.style.top = '';
        this.ui.timelineBar.style.left = '';
      }
      this.updateRulerDirection();
      this.updateSlider();
      this.previewPanel?.reposition();
    }
  }

  /** Trailing-debounced handler shared by window and visualViewport resize. */
  private scheduleResizeWork(): void {
    if (this.resizeIdleTimer !== null) clearTimeout(this.resizeIdleTimer);
    this.resizeIdleTimer = window.setTimeout(() => {
      this.resizeIdleTimer = null;
      if (this.destroyed) return;
      this.options.onResize();
      this.updateTimelineGeometry();
      this.syncTimelineTrackToMain();
      this.updateVirtualRangeAndRender();
      this.updateSlider();
      // Reapply position for responsive design (v2 format only)
      this.reapplyPosition();
    }, this.resizeIdleDelay);
  }
}
