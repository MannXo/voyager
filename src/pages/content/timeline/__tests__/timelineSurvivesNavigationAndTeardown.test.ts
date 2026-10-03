// @vitest-environment jsdom
// @vitest-environment-options { "url": "https://gemini.google.com/app" }
/**
 * Characterization of the Gemini timeline across Gemini's SPA lifecycle: switching conversations,
 * hash-only changes, Gemini replacing the chat viewport, and leaving conversations altogether
 * (which must remove every piece of timeline UI and stop reacting to input).
 */
import { describe, expect, it, vi } from 'vitest';

import {
  type GeminiTurn,
  GeminiPage,
  SURFACE,
  activeDotLabel,
  dotFor,
  dotLabels,
  leaveConversation,
  longPress,
  navigateTo,
  openLevelMenu,
  pressKey,
  settle,
  startTimelineOnPage,
  starredDotLabels,
  timelineBar,
  trackPageListeners,
  useTimelinePage,
} from './geminiTimelineHarness';

vi.mock('webextension-polyfill', async () =>
  (await import('./geminiTimelineHarness')).polyfillMock(),
);

const KYOTO: GeminiTurn[] = [
  { prompt: 'Plan a trip to Kyoto', serverId: 'aaaaaaaaaaaaaaaa' },
  { prompt: 'Add a day in Nara', serverId: 'bbbbbbbbbbbbbbbb' },
  { prompt: 'Book the ryokan', serverId: 'cccccccccccccccc' },
];
const RECIPES: GeminiTurn[] = [
  { prompt: 'Sourdough starter', serverId: '1111111111111111' },
  { prompt: 'Feeding schedule', serverId: '2222222222222222' },
];

/** Every element the timeline adds to the page, as seen from outside. */
const TIMELINE_UI = [
  SURFACE.bar,
  SURFACE.slider,
  SURFACE.tooltip,
  SURFACE.previewToggle,
  SURFACE.previewPanel,
  '.gv-timeline-preview-hover-bridge',
  SURFACE.levelMenu,
];
const timelineUiLeft = () =>
  TIMELINE_UI.filter((selector) => document.querySelector(selector) !== null);

describe('switching between Gemini conversations', () => {
  const ext = useTimelinePage('/app/kyoto');

  it('opening another conversation rebuilds the rail for its turns', async () => {
    const page = new GeminiPage(KYOTO);
    await startTimelineOnPage();

    page.render(RECIPES);
    await navigateTo('/app/recipes');

    expect(dotLabels()).toEqual(RECIPES.map((turn) => turn.prompt));
    expect(document.querySelectorAll(SURFACE.bar)).toHaveLength(1);
  });

  it('stars belong to their conversation and come back when returning to it', async () => {
    const page = new GeminiPage(KYOTO);
    await startTimelineOnPage();
    await longPress(dotFor(KYOTO[1].prompt));
    await settle();

    page.render(RECIPES);
    await navigateTo('/app/recipes');
    expect(starredDotLabels()).toEqual([]);

    page.render(KYOTO);
    await navigateTo('/app/kyoto');
    expect(starredDotLabels()).toEqual([KYOTO[1].prompt]);
  });

  it('a query-string change on the same conversation also rebuilds the rail', async () => {
    const page = new GeminiPage(KYOTO);
    await startTimelineOnPage();
    const before = timelineBar();

    page.render(RECIPES);
    await navigateTo('/app/kyoto?hl=ja');

    expect(timelineBar()).not.toBe(before);
    expect(dotLabels()).toEqual(RECIPES.map((turn) => turn.prompt));
  });

  it('a hash-only change keeps the same rail, stars and active turn', async () => {
    ext().seed('sync', { geminiTimelineScrollMode: 'jump' });
    const page = new GeminiPage(KYOTO);
    await startTimelineOnPage();
    await longPress(dotFor(KYOTO[0].prompt));
    await settle();
    dotFor(KYOTO[2].prompt).click();
    await settle();
    const bar = timelineBar();

    history.pushState(null, '', '/app/kyoto#section');
    window.dispatchEvent(new HashChangeEvent('hashchange'));
    await settle(2000);

    expect(timelineBar()).toBe(bar);
    expect(starredDotLabels()).toEqual([KYOTO[0].prompt]);
    expect(activeDotLabel()).toBe(KYOTO[2].prompt);
    expect(page.viewport.scrollTop).toBe(page.topOf(KYOTO[2].prompt));
  });
});

describe('Gemini replacing the chat viewport', () => {
  const ext = useTimelinePage('/app/kyoto');

  it('keeps stars and scrolls the new viewport after Gemini re-renders the chat', async () => {
    ext().seed('sync', { geminiTimelineScrollMode: 'jump' });
    const page = new GeminiPage(KYOTO);
    await startTimelineOnPage();
    await longPress(dotFor(KYOTO[1].prompt));
    await settle();
    const oldViewport = page.viewport;

    page.render(KYOTO);
    await settle(2000);

    expect(page.viewport).not.toBe(oldViewport);
    expect(dotLabels()).toEqual(KYOTO.map((turn) => turn.prompt));
    expect(starredDotLabels()).toEqual([KYOTO[1].prompt]);

    dotFor(KYOTO[2].prompt).click();
    await settle();
    expect(page.viewport.scrollTop).toBe(page.topOf(KYOTO[2].prompt));
    expect(activeDotLabel()).toBe(KYOTO[2].prompt);
  });
});

describe('leaving conversations tears the timeline down', () => {
  const ext = useTimelinePage('/app/kyoto');

  it('opening Gemini home removes every piece of timeline UI', async () => {
    ext().seed('sync', { geminiTimelineMarkerLevel: true });
    new GeminiPage(KYOTO);
    await startTimelineOnPage();
    document.querySelector<HTMLElement>(SURFACE.previewToggle)!.click();
    openLevelMenu(dotFor(KYOTO[1].prompt));
    expect(timelineUiLeft()).toEqual(TIMELINE_UI);

    await leaveConversation('/');

    expect(timelineUiLeft()).toEqual([]);
  });

  it('after leaving, keyboard shortcuts and chat scrolling no longer drive a timeline', async () => {
    ext().seed('sync', { geminiTimelineScrollMode: 'jump' });
    const page = new GeminiPage(KYOTO);
    await startTimelineOnPage();

    await leaveConversation('/');
    pressKey('j');
    page.scrollTo(page.topOf(KYOTO[2].prompt));
    await settle();

    expect(page.viewport.scrollTop).toBe(page.topOf(KYOTO[2].prompt));
    expect(timelineUiLeft()).toEqual([]);
  });

  it('settings changes after leaving do not resurrect the rail', async () => {
    new GeminiPage(KYOTO);
    await startTimelineOnPage();

    await leaveConversation('/');
    ext().external('sync', { geminiTimelineHideContainer: true, geminiTimelineStyle: 'compact' });
    await settle();

    expect(timelineUiLeft()).toEqual([]);
  });

  // Only window/document listeners are compared: the shared keyboard-shortcut service currently
  // adds one `chrome.storage.onChanged` listener per visit, so a storage-listener count would fail.
  it('entering and leaving conversations repeatedly does not pile up page listeners', async () => {
    const pageListeners = trackPageListeners();
    const page = new GeminiPage(KYOTO);
    await startTimelineOnPage();
    const whileOpen = pageListeners();
    await leaveConversation('/');
    const afterFirstVisit = pageListeners();
    expect(afterFirstVisit).toBeLessThan(whileOpen);

    for (let visit = 0; visit < 3; visit += 1) {
      page.render(KYOTO);
      await navigateTo('/app/kyoto');
      expect(dotLabels()).toEqual(KYOTO.map((turn) => turn.prompt));
      await leaveConversation('/');
    }

    expect(pageListeners()).toBe(afterFirstVisit);
  });

  it('coming back to a conversation after leaving shows its rail again', async () => {
    const page = new GeminiPage(KYOTO);
    await startTimelineOnPage();
    await leaveConversation('/');

    page.render(KYOTO);
    await navigateTo('/app/kyoto');

    expect(dotLabels()).toEqual(KYOTO.map((turn) => turn.prompt));
    expect(document.querySelectorAll(SURFACE.bar)).toHaveLength(1);
  });
});
