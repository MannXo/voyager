import {
  getGeminiTurnSelectors,
  getGeminiUserTurnObserverScope,
} from '@/core/gemini/turnSelectors';
import type {
  TimelineAdapter,
  TimelineElements,
  TimelineStateOwner,
} from '@/features/timeline/TimelineAdapter';
import type { TimelineMarker } from '@/features/timeline/types';

import { nativeHealthReporter } from '../nativeHealth';
import { hasRenderedConversationContent } from '../nativeHealth/pageEvidence';
import { TimelineState } from './TimelineState';
import { TimelineTimestamps } from './TimelineTimestamps';
import { TimelineTurns } from './TimelineTurns';

export interface GeminiTimelineOptions {
  previousUrl?: string | null;
}

export class GeminiTimelineAdapter implements TimelineAdapter {
  readonly siteId = 'gemini';
  readonly settingsPrefix = 'geminiTimeline';
  private conversationContainer: HTMLElement | null = null;
  private userTurnSelector = '';
  private readonly turns = new TimelineTurns();
  constructor(private readonly options: GeminiTimelineOptions = {}) {}
  createState(onChange: () => void): TimelineState {
    return new TimelineState(onChange);
  }
  createTimestamps(state: TimelineStateOwner): TimelineTimestamps {
    const geminiState = state as TimelineState;
    return new TimelineTimestamps(
      {
        getMarkers: () => state.markers,
        getTurnText: (element) => this.turns.getTurnTextCached(element),
        getTurnAliases: (id) => geminiState.getStoredTurnIdAliases(id),
        onIdentityChange: () => geminiState.refreshStars(),
      },
      this.options,
    );
  }
  collect(container: HTMLElement, selector: string, previous: TimelineMarker[]): TimelineMarker[] {
    return this.turns.collect(container, selector, previous);
  }
  refreshElements(selector: string): TimelineElements | null {
    const firstTurn = document.querySelector<HTMLElement>(selector);
    if (!firstTurn) return null;
    return {
      container: document.querySelector<HTMLElement>('main') || document.body,
      selector,
      viewport: this.getViewport(firstTurn),
    };
  }
  reportTurns(found: boolean, recheck: () => boolean): void {
    if (found) nativeHealthReporter.reportFound('timeline');
    else
      nativeHealthReporter.reportMissing('timeline', {
        route: 'conversation',
        recheck,
        expected: () => hasRenderedConversationContent(),
      });
  }
  destroy(): void {
    nativeHealthReporter.withdraw('timeline');
  }
  private waitForAnyElement(
    selectors: string[],
    signal: AbortSignal,
    timeoutMs = 5000,
  ): Promise<{ element: Element; selector: string } | null> {
    const find = () => {
      for (const selector of selectors) {
        const element = document.querySelector(selector);
        if (element) return { element, selector };
      }
      return null;
    };
    const found = find();
    if (found || signal.aborted) return Promise.resolve(found);
    return new Promise((resolve) => {
      const finish = (result: ReturnType<typeof find>) => {
        observer.disconnect();
        clearTimeout(timer);
        signal.removeEventListener('abort', onAbort);
        resolve(result);
      };
      const observer = new MutationObserver(() => {
        const result = find();
        if (result) finish(result);
      });
      const onAbort = () => finish(null);
      const timer = window.setTimeout(() => finish(null), timeoutMs);
      observer.observe(document.body, { childList: true, subtree: true });
      signal.addEventListener('abort', onAbort, { once: true });
    });
  }
  async findElements(signal: AbortSignal): Promise<TimelineElements | null> {
    let userOverride = '';
    let autoDetected = '';
    try {
      userOverride = localStorage.getItem('geminiTimelineUserTurnSelector') || '';
      autoDetected = localStorage.getItem('geminiTimelineUserTurnSelectorAuto') || '';
    } catch {}
    const defaultCandidates = getGeminiTurnSelectors('turn.user');
    // Compatibility strategy:
    // - Keep explicit user override as highest priority.
    // - Prefer built-in defaults over auto-detected cache, so stale auto cache can self-heal after refresh.
    let candidates = [...defaultCandidates];
    if (userOverride.length) {
      candidates = [userOverride, ...defaultCandidates.filter((s) => s !== userOverride)];
    } else {
      const cached = autoDetected;
      if (cached && !candidates.includes(cached)) candidates.push(cached);
    }
    let firstTurn: Element | null = null;
    let matchedSelector = '';
    const found = await this.waitForAnyElement(candidates, signal, 4000);
    if (found) {
      firstTurn = found.element;
      matchedSelector = found.selector;
      this.userTurnSelector = matchedSelector;
    }
    if (!firstTurn) {
      this.conversationContainer =
        (document.querySelector('main') as HTMLElement) || (document.body as HTMLElement);
      this.userTurnSelector = defaultCandidates.join(',');
    } else {
      // Scope selection/observers:
      // - Broad scope (main/body) if the user's explicit override matched, or the matched
      //   selector belongs to Gemini's Angular layout, where turns are not siblings
      // - Otherwise, scope to the immediate parent for performance
      const needsConversationScope =
        getGeminiUserTurnObserverScope(matchedSelector) === 'conversation';
      if ((userOverride && matchedSelector === userOverride) || needsConversationScope) {
        this.conversationContainer =
          (document.querySelector('main') as HTMLElement) || (document.body as HTMLElement);
      } else {
        const parent = firstTurn.parentElement as HTMLElement | null;
        if (!parent) return null;
        this.conversationContainer = parent;
      }
      // Persist auto-detected selector for future sessions when no explicit user override exists
      if (!userOverride && matchedSelector) {
        try {
          localStorage.setItem('geminiTimelineUserTurnSelectorAuto', matchedSelector);
        } catch {}
      }
      // If a stale user override failed (matchedSelector differs), clear it so we don't keep retrying it
      if (userOverride && matchedSelector && matchedSelector !== userOverride) {
        try {
          localStorage.removeItem('geminiTimelineUserTurnSelector');
        } catch {}
      }
    }
    return {
      container: this.conversationContainer!,
      selector: this.userTurnSelector,
      viewport: this.getViewport((firstTurn as HTMLElement) || this.conversationContainer!),
    };
  }

  getViewport(element: HTMLElement): HTMLElement {
    let p: HTMLElement | null = element;
    while (p && p !== document.body) {
      const st = getComputedStyle(p);
      if (st.overflowY === 'auto' || st.overflowY === 'scroll') {
        return p;
      }
      p = p.parentElement;
    }

    return (
      (document.scrollingElement as HTMLElement | null) ||
      (document.documentElement as HTMLElement | null) ||
      (document.body as unknown as HTMLElement)
    );
  }
}
