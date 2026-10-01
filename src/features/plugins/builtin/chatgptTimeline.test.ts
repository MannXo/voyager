/**
 * The ChatGPT timeline is the `voyager.chatgpt-timeline` builtin manifest
 * driving the `turnNavigator` primitive with the bundled ChatGPT adapter.
 * Fixtures follow the DOM the ChatGPT export adapter is built and tested
 * against (`export/adapter/__tests__/chatgpt.test.ts`): one
 * `[data-turn-id-container]` virtual-list item per turn whose inner message
 * DOM unmounts off-screen, plus `*-root` bookkeeping containers.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { StorageKeys } from '@/core/types/common';
import type { StarredMessage } from '@/pages/content/timeline/starredTypes';

import { requireBundledSiteAdapter } from '../catalog/sites';
import { PluginScope } from '../runtime/pluginScope';
import type { NativeOperation } from '../types';
import { turnNavigatorPrimitive } from '../verbs/turnNavigator';
import { buildConversationId, buildTurnId } from '../verbs/turnNavigator/TurnNavigator';
import { BUILTIN_PLUGINS } from './index';

/** In-memory stand-in for the background's starred-message store. */
const {
  starStore,
  addToStore,
  getStarredMessagesForConversation,
  addStarredMessage,
  removeStarredMessage,
} = vi.hoisted(() => {
  const store = new Map<string, StarredMessage[]>();
  const addToStore = async (message: StarredMessage): Promise<void> => {
    const list = (store.get(message.conversationId) ?? []).filter(
      (item) => item.turnId !== message.turnId,
    );
    store.set(message.conversationId, [...list, message]);
  };
  return {
    starStore: store,
    addToStore,
    getStarredMessagesForConversation: vi.fn(async (conversationId: string) => [
      ...(store.get(conversationId) ?? []),
    ]),
    addStarredMessage: vi.fn(addToStore),
    removeStarredMessage: vi.fn(async (conversationId: string, turnId: string) => {
      const list = (store.get(conversationId) ?? []).filter((item) => item.turnId !== turnId);
      if (list.length) store.set(conversationId, list);
      else store.delete(conversationId);
    }),
  };
});

vi.mock('@/utils/i18n', () => ({
  initI18n: vi.fn().mockResolvedValue(undefined),
  getTranslationSync: (key: string) => key,
}));
vi.mock('@/pages/content/timeline/StarredMessagesService', () => ({
  StarredMessagesService: {
    addStarredMessage,
    getStarredMessagesForConversation,
    removeStarredMessage,
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
/** Longer than any settle window a timing heuristic could wait out. */
const SLOW_HOST_MS = 2_500;

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

function draftId(path = '/'): string {
  return buildConversationId(
    {
      siteId: 'chatgpt',
      conversationIdPattern: requireBundledSiteAdapter('chatgpt').conversationIdPattern,
    },
    `${location.origin}${path}`,
  );
}

function star(conversation: string, text: string): StarredMessage {
  return {
    turnId: buildTurnId(text),
    content: text,
    conversationId: conversation,
    conversationUrl: `${location.origin}/`,
    conversationTitle: 'Saved',
    starredAt: 1,
  };
}

/** The storage echo every star write sends to open tabs. */
function notifyStars(): void {
  const listeners = vi.mocked(chrome.storage.onChanged.addListener).mock.calls;
  const notify = listeners[listeners.length - 1][0];
  notify({ [StorageKeys.TIMELINE_STARRED_MESSAGES]: { newValue: {} } }, 'local');
}

async function longPress(dot: HTMLElement): Promise<void> {
  dot.dispatchEvent(new Event('pointerdown'));
  await vi.advanceTimersByTimeAsync(600);
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
  starStore.clear();
  getStarredMessagesForConversation.mockClear();
  addStarredMessage.mockClear();
  addStarredMessage.mockImplementation(addToStore);
  removeStarredMessage.mockClear();
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

  it('treats a normal scroller in rubber-band overscroll as a normal scroller', async () => {
    const scroller = makeScroller();
    // Safari reports a negative scrollTop while bouncing past the top edge.
    Object.defineProperty(scroller, 'scrollTop', { configurable: true, value: -20 });
    addExchange(1, 'Opening question');
    const target = addExchange(2, 'Jump here');
    target.querySelector<HTMLElement>('[data-message-author-role]')!.getBoundingClientRect =
      rect(700);
    await mount();

    dots()[1].click();

    // -20 + 700 + 20 - 0.45 * 600, on the ordinary axis.
    expect(scroller.scrollTo).toHaveBeenCalledWith({ top: 430, behavior: 'smooth' });
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

  it('updates the dot when a prompt is edited in place, without leaving a phantom', async () => {
    const shell = addExchange(1, 'Hello');
    addExchange(2, 'After');
    await mount();

    mountContent(shell, 'user', 'Hello edited');
    await settle();
    expect(labels()).toEqual(['Hello edited', 'After']);

    // The star belongs to the edited text, and survives the store's echo.
    await longPress(dots()[0]);
    notifyStars();
    await settle();

    expect(starStore.get('chatgpt:conv:first')?.map((message) => message.turnId)).toEqual([
      buildTurnId('Hello edited'),
    ]);
    expect(dots()[0].getAttribute('aria-pressed')).toBe('true');
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

  it('shows what is on screen while the URL changes before the DOM', async () => {
    const old = addExchange(1, 'Prompt A');
    await mount();

    history.pushState({}, '', '/c/second');
    await settle(ROUTE_SETTLE_MS);
    // A's turn is still on screen until ChatGPT replaces it.
    expect(labels()).toEqual(['Prompt A']);

    thread.append(turnShell('user-9', 'user', 'Prompt B'));
    await settle();
    old.nextElementSibling?.remove();
    old.remove();
    await settle();

    expect(labels()).toEqual(['Prompt B']);
    expect(getStarredMessagesForConversation).toHaveBeenLastCalledWith('chatgpt:conv:second');
  });

  it("drops the previous conversation's off-screen turns when ChatGPT removes their items", async () => {
    const shells = [addExchange(1, 'Prompt A1'), addExchange(2, 'Prompt A2')];
    await mount();
    shells.forEach(unmountContent);
    await settle();
    expect(labels()).toEqual(['Prompt A1', 'Prompt A2']);

    history.pushState({}, '', '/c/second');
    await settle(ROUTE_SETTLE_MS);
    thread.append(turnShell('user-9', 'user', 'Prompt B'));
    await settle();
    // The items React removes hold no message DOM any more.
    for (const shell of shells) {
      shell.nextElementSibling?.remove();
      shell.remove();
    }
    await settle();

    expect(labels()).toEqual(['Prompt B']);
  });

  it('shows the next conversation when its DOM arrives well before the URL', async () => {
    addExchange(1, 'Prompt A');
    await mount();

    thread.replaceChildren(turnShell('user-9', 'user', 'Prompt B'));
    await settle(600);
    expect(labels()).toEqual(['Prompt B']);

    history.pushState({}, '', '/c/second');
    await settle(ROUTE_SETTLE_MS);
    expect(labels()).toEqual(['Prompt B']);
    expect(getStarredMessagesForConversation).toHaveBeenLastCalledWith('chatgpt:conv:second');

    // The swap before the URL change shows these turns are the new conversation's.
    await longPress(dots()[0]);
    expect(starStore.get('chatgpt:conv:second')?.map((message) => message.content)).toEqual([
      'Prompt B',
    ]);
  });

  it('keeps the previous conversation off the rail when a star change lands mid-switch', async () => {
    addExchange(1, 'Prompt A');
    await mount();

    history.pushState({}, '', '/c/second');
    // Another tab starred something before this tab noticed the route change.
    notifyStars();
    thread.replaceChildren(turnShell('user-9', 'user', 'Prompt B'));
    await settle(ROUTE_SETTLE_MS);

    expect(labels()).toEqual(['Prompt B']);
  });

  it('cannot star a new chat until ChatGPT gives it an id, then stars under that id', async () => {
    history.replaceState({}, '', '/');
    addExchange(1, 'Brand new chat');
    await mount();

    await longPress(dots()[0]);
    expect(addStarredMessage).not.toHaveBeenCalled();
    // Every new chat on / shares one path-hash id: nothing there is this chat's.
    expect(getStarredMessagesForConversation).not.toHaveBeenCalled();

    history.pushState({}, '', '/c/assigned-id');
    await settle(ROUTE_SETTLE_MS);
    expect(getStarredMessagesForConversation).toHaveBeenLastCalledWith('chatgpt:conv:assigned-id');
    await longPress(dots()[0]);

    expect(starStore.get('chatgpt:conv:assigned-id')?.map((message) => message.content)).toEqual([
      'Brand new chat',
    ]);
    expect(labels()).toEqual(['Brand new chat']);
    expect(dots()[0].getAttribute('aria-pressed')).toBe('true');
  });

  it('never moves or deletes a star stored under a new-chat id', async () => {
    history.replaceState({}, '', '/');
    const saved = star(draftId(), 'Star me');
    starStore.set(draftId(), [saved]);
    // A store near its quota drops a write without an error.
    addStarredMessage.mockImplementation(async () => {});
    addExchange(1, 'Star me');
    await mount();

    history.pushState({}, '', '/c/assigned-id');
    await settle(ROUTE_SETTLE_MS + SLOW_HOST_MS);

    expect(removeStarredMessage).not.toHaveBeenCalled();
    expect(starStore.get(draftId())).toEqual([saved]);
  });

  it('keeps a new chat out of a conversation opened while the new chat is still on screen', async () => {
    history.replaceState({}, '', '/');
    starStore.set('chatgpt:conv:other', [star('chatgpt:conv:other', 'Other prompt')]);
    const draft = addExchange(1, 'Draft prompt');
    await mount();
    await longPress(dots()[0]);

    history.pushState({}, '', '/c/other');
    // ChatGPT is slow to load the conversation: the new chat stays on screen.
    await settle(ROUTE_SETTLE_MS + SLOW_HOST_MS);
    draft.nextElementSibling?.remove();
    draft.remove();
    thread.append(turnShell('user-7', 'user', 'Other prompt'));
    await settle();

    expect(labels()).toEqual(['Other prompt']);
    expect(dots()[0].getAttribute('aria-pressed')).toBe('true');
    expect(starStore.get('chatgpt:conv:other')?.map((message) => message.content)).toEqual([
      'Other prompt',
    ]);
  });

  it('ignores a star press in the moment between a URL change and the next refresh', async () => {
    addExchange(1, 'Prompt A');
    await mount();

    dots()[0].dispatchEvent(new Event('pointerdown'));
    await vi.advanceTimersByTimeAsync(549);
    history.pushState({}, '', '/c/second');
    await settle(ROUTE_SETTLE_MS);

    expect(addStarredMessage).not.toHaveBeenCalled();
  });

  it('cannot star while the previous conversation is on screen, then stars the new one', async () => {
    const old = addExchange(1, 'Prompt A');
    await mount();

    history.pushState({}, '', '/c/second');
    await settle(ROUTE_SETTLE_MS);
    expect(labels()).toEqual(['Prompt A']);
    await longPress(dots()[0]);
    thread.append(turnShell('user-9', 'user', 'Prompt B'));
    await settle();
    // A is still on screen: the URL alone does not say which thread this is.
    await longPress(dots()[1]);
    expect(addStarredMessage).not.toHaveBeenCalled();

    old.nextElementSibling?.remove();
    old.remove();
    await settle();
    await longPress(dots()[0]);

    expect(starStore.get('chatgpt:conv:second')?.map((message) => message.content)).toEqual([
      'Prompt B',
    ]);
  });

  it('drops a press begun in the previous conversation when the next one has the same prompt', async () => {
    addExchange(1, 'Same prompt');
    await mount();

    dots()[0].dispatchEvent(new Event('pointerdown'));
    await vi.advanceTimersByTimeAsync(100);
    thread.replaceChildren(turnShell('user-9', 'user', 'Same prompt'));
    history.pushState({}, '', '/c/second');
    await settle(ROUTE_SETTLE_MS);

    expect(addStarredMessage).not.toHaveBeenCalled();
  });

  it('drops a star press whose read was still pending when the user moved on', async () => {
    addExchange(1, 'Same prompt');
    await mount();
    let release!: (messages: StarredMessage[]) => void;
    getStarredMessagesForConversation.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          release = resolve;
        }),
    );

    dots()[0].dispatchEvent(new Event('pointerdown'));
    await vi.advanceTimersByTimeAsync(549);
    history.pushState({}, '', '/c/second');
    await vi.advanceTimersByTimeAsync(1);
    // The next conversation opens with the same prompt before that read lands.
    history.pushState({}, '', '/c/third');
    thread.replaceChildren(turnShell('user-c', 'user', 'Same prompt'));
    await settle(ROUTE_SETTLE_MS);
    release?.([]);
    await settle();

    expect(addStarredMessage).not.toHaveBeenCalled();
  });

  it('aims a jump again once the unloaded turn it targets mounts', async () => {
    const scroller = makeScroller();
    const target = addExchange(1, 'Scrolled away');
    addExchange(2, 'Visible');
    await mount();
    unmountContent(target);
    await settle();
    target.getBoundingClientRect = rect(700);

    dots()[0].click();
    expect(scroller.scrollTo).toHaveBeenLastCalledWith({ top: 450, behavior: 'smooth' });

    // ChatGPT mounts the message and re-measures the items around it.
    const content = mountContent(target, 'user', 'Scrolled away');
    content.getBoundingClientRect = rect(900);
    await settle(400);

    expect(scroller.scrollTo).toHaveBeenLastCalledWith({ top: 650, behavior: 'smooth' });
    // Aimed once at the mounted message, then done.
    vi.clearAllMocks();
    await settle(2_000);
    expect(scroller.scrollTo).not.toHaveBeenCalled();
  });

  it('stops waiting for an unloaded turn that never mounts', async () => {
    const scroller = makeScroller();
    const target = addExchange(1, 'Scrolled away');
    addExchange(2, 'Visible');
    await mount();
    unmountContent(target);
    await settle();
    target.getBoundingClientRect = rect(700);

    dots()[0].click();
    expect(scroller.scrollTo).toHaveBeenCalledTimes(1);
    await settle(10_000);
    const content = mountContent(target, 'user', 'Scrolled away');
    content.getBoundingClientRect = rect(900);
    await settle(400);

    expect(scroller.scrollTo).toHaveBeenCalledTimes(1);
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
