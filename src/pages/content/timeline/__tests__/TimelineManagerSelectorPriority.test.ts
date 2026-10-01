import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { TimelineManager } from '../manager';

describe('TimelineManager selector priority compatibility', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
    localStorage.clear();
    vi.restoreAllMocks();
  });

  it('prefers built-in selectors over stale auto-detected selector cache', async () => {
    const main = document.createElement('main');

    const defaultTurn = document.createElement('div');
    defaultTurn.className = 'user-query-bubble-with-background';
    defaultTurn.textContent = 'default turn';
    main.appendChild(defaultTurn);

    const staleTurn = document.createElement('div');
    staleTurn.className = 'stale-selector-target';
    staleTurn.textContent = 'stale turn';
    main.appendChild(staleTurn);

    document.body.appendChild(main);
    localStorage.setItem('geminiTimelineUserTurnSelectorAuto', '.stale-selector-target');

    const manager = new TimelineManager();
    const internal = manager as unknown as {
      findCriticalElements: () => Promise<boolean>;
      userTurnSelector: string;
    };

    const ok = await internal.findCriticalElements();
    expect(ok).toBe(true);
    expect(internal.userTurnSelector).toBe('.user-query-bubble-with-background');
    expect(localStorage.getItem('geminiTimelineUserTurnSelectorAuto')).toBe(
      '.user-query-bubble-with-background',
    );
  });

  it('keeps explicit user override as highest priority', async () => {
    const main = document.createElement('main');

    const defaultTurn = document.createElement('div');
    defaultTurn.className = 'user-query-bubble-with-background';
    defaultTurn.textContent = 'default turn';
    main.appendChild(defaultTurn);

    const customTurn = document.createElement('div');
    customTurn.className = 'custom-user-turn';
    customTurn.textContent = 'custom turn';
    main.appendChild(customTurn);

    document.body.appendChild(main);
    localStorage.setItem('geminiTimelineUserTurnSelector', '.custom-user-turn');

    const manager = new TimelineManager();
    const internal = manager as unknown as {
      findCriticalElements: () => Promise<boolean>;
      userTurnSelector: string;
    };

    const ok = await internal.findCriticalElements();
    expect(ok).toBe(true);
    expect(internal.userTurnSelector).toBe('.custom-user-turn');
  });
});

type TimelineSelectorInternals = {
  findCriticalElements: () => Promise<boolean>;
  userTurnSelector: string;
  conversationContainer: HTMLElement | null;
  destroy: () => void;
};

async function detect(): Promise<TimelineSelectorInternals> {
  const internal = new TimelineManager() as unknown as TimelineSelectorInternals;
  await internal.findCriticalElements();
  return internal;
}

/** Every user-turn shape Voyager has recognized on Gemini, each in its own wrapper. */
const USER_SHAPES = [
  ['bubble', '<div class="user-query-bubble-with-background">bubble</div>'],
  ['bubbleContainer', '<div class="user-query-bubble-container">bubbleContainer</div>'],
  ['queryContainer', '<div class="user-query-container">queryContainer</div>'],
  [
    'contentBubble',
    '<user-query-content><span class="user-query-bubble-with-background">contentBubble</span></user-query-content>',
  ],
  ['contentHost', '<user-query-content>contentHost</user-query-content>'],
  ['host', '<user-query>host</user-query>'],
  ['aria', '<div aria-label="User message">aria</div>'],
  ['articleAuthor', '<article data-author="user">articleAuthor</article>'],
  ['articleTurn', '<article data-turn="user">articleTurn</article>'],
  ['role', '<div data-message-author-role="user">role</div>'],
  ['listitem', '<div role="listitem" data-user="true">listitem</div>'],
] as const;

function mountShapes(names: readonly string[]): HTMLElement {
  const main = document.createElement('main');
  main.innerHTML = USER_SHAPES.filter(([name]) => names.includes(name))
    .map(
      ([name, html]) => `<section class="gv-test-wrapper" data-shape="${name}">${html}</section>`,
    )
    .join('');
  document.body.appendChild(main);
  return main;
}

function shapeOf(element: Element | null): string | undefined {
  return element?.closest<HTMLElement>('.gv-test-wrapper')?.dataset.shape;
}

describe('TimelineManager Gemini user-turn detection', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
    localStorage.clear();
    vi.restoreAllMocks();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('detects the bundled shapes in priority order with their observer scope', async () => {
    const main = mountShapes(USER_SHAPES.map(([name]) => name));
    const detected: Array<[string | undefined, 'main' | 'parent']> = [];
    const recognizable = '.gv-test-wrapper:not([data-shape="contentHost"], [data-shape="host"])';

    // Detect, remove every match, and detect again until only shapes the timeline does not
    // recognize are left.
    while (main.querySelector(recognizable)) {
      localStorage.clear();
      const internal = await detect();
      const matches = Array.from(document.querySelectorAll(internal.userTurnSelector));
      detected.push([
        shapeOf(matches[0]),
        internal.conversationContainer === main ? 'main' : 'parent',
      ]);
      matches.forEach((element) => element.closest('.gv-test-wrapper')?.remove());
      internal.destroy();
    }

    expect(detected).toEqual([
      ['bubble', 'main'],
      ['bubbleContainer', 'main'],
      ['queryContainer', 'main'],
      ['aria', 'parent'],
      ['articleAuthor', 'parent'],
      ['articleTurn', 'parent'],
      ['role', 'parent'],
      ['listitem', 'parent'],
    ]);
  });

  it('falls back to every bundled selector on main when no turn appears', async () => {
    vi.useFakeTimers();
    const main = mountShapes(['contentHost', 'host']);

    const pending = detect();
    await vi.advanceTimersByTimeAsync(4000);
    const internal = await pending;

    expect(internal.conversationContainer).toBe(main);
    expect(document.querySelectorAll(internal.userTurnSelector)).toHaveLength(0);

    main.remove();
    mountShapes(USER_SHAPES.map(([name]) => name));
    const recognized = Array.from(document.querySelectorAll(internal.userTurnSelector)).map(
      shapeOf,
    );
    expect([...new Set(recognized)]).toEqual([
      'bubble',
      'bubbleContainer',
      'queryContainer',
      'contentBubble',
      'aria',
      'articleAuthor',
      'articleTurn',
      'role',
      'listitem',
    ]);
    internal.destroy();
  });

  it('observes main for a legacy Auto selector naming user-query', async () => {
    const main = mountShapes(['host']);
    localStorage.setItem('geminiTimelineUserTurnSelectorAuto', 'user-query');

    const internal = await detect();

    expect(internal.userTurnSelector).toBe('user-query');
    expect(internal.conversationContainer).toBe(main);
    internal.destroy();
  });

  it('observes the parent for an Auto selector outside the user-query family', async () => {
    const main = mountShapes([]);
    const wrapper = document.createElement('div');
    wrapper.innerHTML = '<p class="gv-test-custom-turn">custom</p>';
    main.appendChild(wrapper);
    localStorage.setItem('geminiTimelineUserTurnSelectorAuto', '.gv-test-custom-turn');

    const internal = await detect();

    expect(internal.userTurnSelector).toBe('.gv-test-custom-turn');
    expect(internal.conversationContainer).toBe(wrapper);
    internal.destroy();
  });

  it('observes main for a matching user override and clears a stale one', async () => {
    const main = mountShapes(['articleTurn']);
    localStorage.setItem('geminiTimelineUserTurnSelector', 'article[data-turn="user"]');

    let internal = await detect();
    expect(internal.userTurnSelector).toBe('article[data-turn="user"]');
    expect(internal.conversationContainer).toBe(main);
    expect(localStorage.getItem('geminiTimelineUserTurnSelectorAuto')).toBeNull();
    internal.destroy();

    localStorage.setItem('geminiTimelineUserTurnSelector', '.gv-test-missing');
    internal = await detect();
    expect(internal.userTurnSelector).toBe('article[data-turn="user"]');
    expect(shapeOf(internal.conversationContainer)).toBe('articleTurn');
    expect(localStorage.getItem('geminiTimelineUserTurnSelector')).toBeNull();
    internal.destroy();
  });
});
