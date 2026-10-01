/**
 * The ChatGPT timeline is the `voyager.chatgpt-timeline` builtin manifest
 * driving the `turnNavigator` primitive with the bundled ChatGPT adapter.
 * Fixtures follow the DOM the ChatGPT export adapter is built and tested
 * against (`export/adapter/__tests__/chatgpt.test.ts`): one
 * `[data-turn-id-container]` virtual-list item per turn whose inner message
 * DOM unmounts off-screen, plus `*-root` bookkeeping containers.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { requireBundledSiteAdapter } from '../catalog/sites';
import { PluginScope } from '../runtime/pluginScope';
import type { NativeOperation } from '../types';
import { turnNavigatorPrimitive } from '../verbs/turnNavigator';
import { BUILTIN_PLUGINS } from './index';

const { getStarredMessagesForConversation } = vi.hoisted(() => ({
  getStarredMessagesForConversation: vi.fn().mockResolvedValue([]),
}));

vi.mock('@/utils/i18n', () => ({
  initI18n: vi.fn().mockResolvedValue(undefined),
  getTranslationSync: (key: string) => key,
}));
vi.mock('@/pages/content/timeline/StarredMessagesService', () => ({
  StarredMessagesService: {
    addStarredMessage: vi.fn().mockResolvedValue(undefined),
    getStarredMessagesForConversation,
    removeStarredMessage: vi.fn().mockResolvedValue(undefined),
  },
}));
vi.mock('@/features/plugins/storage/pluginState', () => ({
  setPluginSetting: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('@/pages/content/timeline/timelineStyleCoachmark', () => ({
  showTimelineStyleCoachmark: vi.fn().mockResolvedValue(undefined),
}));

/** Poll of the shared route watcher plus the navigator's refresh debounce. */
const ROUTE_SETTLE_MS = 400 + 150;

let scope: PluginScope;
let thread: HTMLElement;
let targetCount: () => number;

function manifest() {
  const timeline = BUILTIN_PLUGINS.find((plugin) => plugin.id === 'voyager.chatgpt-timeline');
  if (!timeline) throw new Error('voyager.chatgpt-timeline is not a builtin');
  return timeline;
}

async function mount(): Promise<void> {
  const op = manifest().contributes.domOps?.find((entry): entry is NativeOperation => {
    return entry.op === 'native';
  });
  if (!op) throw new Error('the ChatGPT timeline needs a native op');
  const params = turnNavigatorPrimitive.validateParams(op.params);
  if (!params.success) throw new Error('invalid turnNavigator params');
  turnNavigatorPrimitive.activate(scope, params.data, {
    doc: document,
    adapter: requireBundledSiteAdapter('chatgpt'),
    pluginId: manifest().id,
    settings: {},
    setTargetCounter: (count) => {
      targetCount = count;
    },
  });
  await settle();
}

async function settle(ms = 150): Promise<void> {
  await vi.advanceTimersByTimeAsync(ms);
}

function message(role: 'user' | 'assistant', text: string): HTMLElement {
  const element = document.createElement('div');
  element.setAttribute('data-message-author-role', role);
  element.textContent = text;
  return element;
}

/** One virtual-list item: `<div data-turn-id-container><section data-turn>…`. */
function turnShell(id: string, role: 'user' | 'assistant', text: string): HTMLElement {
  const shell = document.createElement('div');
  shell.setAttribute('data-turn-id-container', id);
  mountContent(shell, role, text);
  return shell;
}

function mountContent(shell: HTMLElement, role: 'user' | 'assistant', text: string): HTMLElement {
  const frame = document.createElement('section');
  frame.setAttribute('data-turn', role);
  const content = message(role, text);
  frame.appendChild(content);
  shell.replaceChildren(frame);
  return content;
}

/** ChatGPT keeps the item and drops its message DOM once it leaves the viewport. */
function unmountContent(shell: HTMLElement): void {
  shell.replaceChildren();
}

function addExchange(index: number, prompt: string, answer = `Answer ${index}`): HTMLElement {
  const user = turnShell(`user-${index}`, 'user', prompt);
  thread.append(user, turnShell(`assistant-${index}`, 'assistant', answer));
  return user;
}

function dots(): HTMLButtonElement[] {
  return Array.from(document.querySelectorAll<HTMLButtonElement>('.timeline-dot'));
}

function labels(): string[] {
  return dots().map((dot) => dot.getAttribute('aria-label') ?? '');
}

function rect(top: number): () => DOMRect {
  return () => ({ top, bottom: top + 40, height: 40, left: 0, right: 0, width: 0 }) as DOMRect;
}

function makeScroller(options: { reverse?: boolean } = {}): HTMLElement & { scrollTo: never } {
  thread.style.overflowY = 'auto';
  if (options.reverse) {
    thread.style.display = 'flex';
    thread.style.flexDirection = 'column-reverse';
  }
  Object.defineProperties(thread, {
    clientHeight: { configurable: true, value: 600 },
    scrollHeight: { configurable: true, value: 2000 },
  });
  thread.getBoundingClientRect = rect(0);
  thread.scrollTo = vi.fn() as never;
  return thread as HTMLElement & { scrollTo: never };
}

beforeEach(() => {
  vi.useFakeTimers();
  history.replaceState({}, '', '/c/first');
  document.body.innerHTML = `
    <main>
      <div id="thread">
        <div data-turn-id-container="paginated-root:first"></div>
      </div>
    </main>
  `;
  thread = document.getElementById('thread')!;
  scope = new PluginScope();
  targetCount = () => -1;
  getStarredMessagesForConversation.mockClear();
  window.scrollTo = vi.fn();
});

afterEach(async () => {
  await scope.dispose();
  document.body.innerHTML = '';
  vi.useRealTimers();
});

describe('ChatGPT timeline', () => {
  it('marks every user turn, skips answers and bookkeeping roots, and files stars under chatgpt', async () => {
    addExchange(1, 'First question');
    addExchange(2, 'Second question');

    await mount();

    expect(document.querySelectorAll('[data-gv-turn-navigator="chatgpt"]')).toHaveLength(1);
    expect(labels()).toEqual(['First question', 'Second question']);
    expect(targetCount()).toBe(2);
    expect(getStarredMessagesForConversation).toHaveBeenLastCalledWith('chatgpt:conv:first');
  });

  it('scrolls the conversation container, not the window, when a dot is clicked', async () => {
    const scroller = makeScroller();
    addExchange(1, 'Opening question');
    const target = addExchange(2, 'Jump here');
    target.querySelector<HTMLElement>('[data-message-author-role]')!.getBoundingClientRect =
      rect(700);
    await mount();

    dots()[1].click();

    expect(scroller.scrollTo).toHaveBeenCalledWith({ top: 450, behavior: 'smooth' });
    expect(window.scrollTo).not.toHaveBeenCalled();
    expect(dots()[1].getAttribute('aria-current')).toBe('true');
  });

  it('jumps through a column-reverse thread, whose offsets run negative from the newest turn', async () => {
    const scroller = makeScroller({ reverse: true });
    const target = addExchange(1, 'Older question');
    addExchange(2, 'Newest question');
    // Resting at scrollTop 0 shows the last 600px of 2000, so the view starts
    // 1400px in. This 40px turn starts 640px above that edge: its centre is
    // 1400 - 640 + 20 = 780px into the conversation.
    target.querySelector<HTMLElement>('[data-message-author-role]')!.getBoundingClientRect =
      rect(-640);
    await mount();

    dots()[0].click();

    // Centre at 45% of the view: 780 - 0.45 * 600 = 510 from the start, which
    // a column-reverse scroller counts as 510 - 1400.
    expect(scroller.scrollTo).toHaveBeenCalledWith({ top: -890, behavior: 'smooth' });
  });

  it('adds a dot when a new prompt is sent', async () => {
    addExchange(1, 'First question');
    await mount();

    addExchange(2, 'Follow-up');
    await settle();

    expect(labels()).toEqual(['First question', 'Follow-up']);
  });

  it('keeps a dot while ChatGPT unmounts the turn, and does not duplicate it on remount', async () => {
    const first = addExchange(1, 'Scrolled away');
    addExchange(2, 'Still visible');
    await mount();
    const id = dots()[0].dataset.targetTurnId;

    unmountContent(first);
    await settle();
    expect(labels()).toEqual(['Scrolled away', 'Still visible']);

    const remounted = mountContent(first, 'user', 'Scrolled away');
    await settle();
    expect(labels()).toEqual(['Scrolled away', 'Still visible']);
    expect(dots()[0].dataset.targetTurnId).toBe(id);
    expect(remounted.getAttribute('data-gv-turn-id')).toBe(id);
  });

  it('keeps repeated identical prompts apart across unmount and remount', async () => {
    const shells = [1, 2, 3].map((index) => addExchange(index, 'continue'));
    await mount();
    const ids = dots().map((dot) => dot.dataset.targetTurnId);
    expect(new Set(ids).size).toBe(3);

    // Only the third "continue" comes back into view. Without the turn key it
    // would be taken for the first one: same text, and no layout in jsdom.
    shells.forEach(unmountContent);
    await settle();
    const third = mountContent(shells[2], 'user', 'continue');
    await settle();

    expect(dots().map((dot) => dot.dataset.targetTurnId)).toEqual(ids);
    expect(third.getAttribute('data-gv-turn-id')).toBe(ids[2]);
  });

  it.each(['after', 'before'] as const)(
    'folds a turn ChatGPT briefly renders twice (copy %s the original) into one dot',
    async (where) => {
      const original = addExchange(1, 'Hello');
      await mount();
      expect(dots()).toHaveLength(1);

      // Virtual-list reconciliation can retain a second item with the same id.
      const copy = turnShell('user-1', 'user', 'Hello');
      if (where === 'after') original.after(copy);
      else original.before(copy);
      await settle();
      expect(labels()).toEqual(['Hello']);

      copy.remove();
      await settle();
      expect(labels()).toEqual(['Hello']);
    },
  );

  it('follows a turn whose list id ChatGPT renames, and its remount under the new id', async () => {
    const sent = addExchange(1, 'Just sent');
    await mount();
    const id = dots()[0].dataset.targetTurnId;

    // A sent turn could move from a client-side id to the server's.
    sent.setAttribute('data-turn-id-container', 'server-1');
    await settle();
    expect(labels()).toEqual(['Just sent']);

    unmountContent(sent);
    await settle();
    const remounted = mountContent(sent, 'user', 'Just sent');
    await settle();
    expect(labels()).toEqual(['Just sent']);
    expect(remounted.getAttribute('data-gv-turn-id')).toBe(id);
  });

  it('does not treat a wrapper around several turns as one turn', async () => {
    const root = document.createElement('div');
    root.setAttribute('data-turn-id-container', 'client-created-root');
    root.append(message('user', 'One'), message('assistant', 'A'), message('user', 'Two'));
    thread.appendChild(root);

    await mount();

    expect(labels()).toEqual(['One', 'Two']);
  });

  it('rebuilds for the next conversation, Projects routes included', async () => {
    addExchange(1, 'Old conversation');
    await mount();

    history.pushState({}, '', '/g/g-p-6a9f32f7/c/second');
    thread.replaceChildren(turnShell('user-9', 'user', 'New conversation'));
    await settle();

    expect(labels()).toEqual(['New conversation']);
    expect(getStarredMessagesForConversation).toHaveBeenLastCalledWith('chatgpt:conv:second');
  });

  it('re-keys a new chat once ChatGPT gives it an id, with no DOM change', async () => {
    history.replaceState({}, '', '/');
    addExchange(1, 'Brand new chat');
    await mount();
    expect(getStarredMessagesForConversation).toHaveBeenLastCalledWith(
      expect.stringMatching(/^chatgpt:(?!conv:)/),
    );

    history.pushState({}, '', '/c/assigned-id');
    await settle(ROUTE_SETTLE_MS);

    expect(getStarredMessagesForConversation).toHaveBeenLastCalledWith('chatgpt:conv:assigned-id');
    expect(labels()).toEqual(['Brand new chat']);
  });

  it('clears the rail when leaving for a page without turns', async () => {
    const first = addExchange(1, 'Question');
    await mount();

    // The thread goes away before the URL changes: the turn mutation alone
    // still sees the old conversation and keeps its dots.
    first.remove();
    await settle();
    history.pushState({}, '', '/gpts');
    await settle(ROUTE_SETTLE_MS);

    expect(dots()).toHaveLength(0);
  });

  it('removes the rail, tooltip and every stamp on disable, and stays gone', async () => {
    addExchange(1, 'Question');
    await mount();
    expect(document.querySelectorAll('[data-gv-turn-id]')).toHaveLength(1);

    await scope.dispose();
    addExchange(2, 'After disable');
    history.pushState({}, '', '/c/other');
    await settle(ROUTE_SETTLE_MS);

    expect(document.querySelector('[data-gv-turn-navigator]')).toBeNull();
    expect(document.getElementById('gv-turn-navigator-tooltip')).toBeNull();
    expect(document.querySelector('.timeline-preview-panel')).toBeNull();
    expect(document.querySelectorAll('[data-gv-turn-id]')).toHaveLength(0);
  });
});
