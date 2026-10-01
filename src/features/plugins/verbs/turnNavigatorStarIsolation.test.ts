import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { StorageKeys } from '@/core/types/common';
import type { StarredMessage } from '@/pages/content/timeline/starredTypes';

import { PluginScope } from '../runtime/pluginScope';
import type { SiteAdapter } from '../types';
import { turnNavigatorPrimitive } from './turnNavigator';
import { buildTurnId } from './turnNavigator/TurnNavigator';
import type { PrimitiveContext } from './types';

const { addStarredMessage, getStarredMessagesForConversation, showTimelineStyleCoachmark } =
  vi.hoisted(() => ({
    addStarredMessage: vi.fn().mockResolvedValue(undefined),
    getStarredMessagesForConversation: vi.fn().mockResolvedValue([]),
    showTimelineStyleCoachmark: vi.fn().mockResolvedValue(undefined),
  }));

vi.mock('@/utils/i18n', () => ({
  initI18n: vi.fn().mockResolvedValue(undefined),
  getTranslationSync: (key: string) => key,
}));
vi.mock('@/pages/content/timeline/StarredMessagesService', () => ({
  StarredMessagesService: {
    addStarredMessage,
    getStarredMessagesForConversation,
    removeStarredMessage: vi.fn().mockResolvedValue(undefined),
  },
}));
vi.mock('@/features/plugins/storage/pluginSettingRequest', () => ({
  requestPluginSetting: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('@/pages/content/timeline/timelineStyleCoachmark', () => ({
  showTimelineStyleCoachmark,
}));

const deepseek: SiteAdapter = {
  id: 'deepseek',
  label: 'DeepSeek',
  matches: ['https://chat.deepseek.com/*'],
  selectors: { userTurn: '.ds-user' },
  theme: { hostSelector: 'body', lightSelector: 'body.light', darkSelector: 'body.dark' },
  capabilities: new Set(['chat']),
  conversationIdPattern: '^/a/chat/s/([^/?#]+)',
};

function context(adapter: SiteAdapter | null, settings = {}) {
  const counters: Array<() => number> = [];
  const ctx: PrimitiveContext = {
    doc: document,
    adapter,
    pluginId: 'voyager.deepseek-timeline',
    settings,
    setTargetCounter: (count) => counters.push(count),
  };
  return { ctx, counters };
}

async function flush(): Promise<void> {
  for (let i = 0; i < 6; i += 1) await Promise.resolve();
}

beforeEach(() => {
  document.body.innerHTML = '';
  history.replaceState({}, '', '/a/chat/s/abc123');
  addStarredMessage.mockClear();
  getStarredMessagesForConversation.mockClear();
  showTimelineStyleCoachmark.mockClear();
  window.scrollTo = vi.fn();
});

afterEach(() => {
  document.body.innerHTML = '';
});

describe('turnNavigator async star isolation', () => {
  it('ignores a delayed old-conversation result after the new conversation has loaded', async () => {
    document.body.innerHTML = '<div class="ds-user">same prompt</div>';
    const scope = new PluginScope();
    getStarredMessagesForConversation.mockResolvedValue([]);
    turnNavigatorPrimitive.activate(scope, {}, context(deepseek).ctx);
    await flush();
    let release!: (value: StarredMessage[]) => void;
    getStarredMessagesForConversation.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          release = resolve;
        }),
    );
    const callbacks = vi.mocked(chrome.storage.onChanged.addListener).mock.calls;
    const notify = callbacks[callbacks.length - 1][0];
    notify({ [StorageKeys.TIMELINE_STARRED_MESSAGES]: { newValue: [] } }, 'local');
    history.replaceState({}, '', '/a/chat/s/new-chat');
    const starred = {
      turnId: buildTurnId('same prompt'),
      content: 'same prompt',
      conversationId: 'deepseek:conv:new-chat',
      conversationUrl: location.href,
      conversationTitle: 'New',
      starredAt: 1,
    };
    getStarredMessagesForConversation.mockResolvedValue([starred]);
    document.querySelector('.ds-user')!.replaceWith(
      Object.assign(document.createElement('div'), {
        className: 'ds-user',
        textContent: 'same prompt',
      }),
    );
    await vi.waitFor(() =>
      expect(getStarredMessagesForConversation).toHaveBeenCalledWith('deepseek:conv:new-chat'),
    );
    await vi.waitFor(() =>
      expect(document.querySelector('.timeline-dot')?.getAttribute('aria-pressed')).toBe('true'),
    );
    release([]);
    await flush();
    expect(document.querySelectorAll('.timeline-dot')).toHaveLength(1);
    expect(document.querySelector('.timeline-dot')?.getAttribute('aria-pressed')).toBe('true');
    await scope.dispose();
  });

  it('cannot star the previous thread after a far scroll replaced every mounted turn', async () => {
    document.body.innerHTML = '<div class="ds-user">prompt A1</div>';
    const scope = new PluginScope();
    turnNavigatorPrimitive.activate(scope, {}, context(deepseek).ctx);
    await vi.waitFor(() => expect(document.querySelectorAll('.timeline-dot')).toHaveLength(1));
    // Virtualization: a far scroll unmounts every turn on screen and mounts others.
    document.querySelector('.ds-user')!.replaceWith(
      Object.assign(document.createElement('div'), {
        className: 'ds-user',
        textContent: 'prompt A2',
      }),
    );
    await vi.waitFor(() => expect(document.querySelectorAll('.timeline-dot')).toHaveLength(2));

    // The URL changes first; this thread is still on screen.
    history.pushState({}, '', '/a/chat/s/other');
    await vi.waitFor(() =>
      expect(getStarredMessagesForConversation).toHaveBeenLastCalledWith('deepseek:conv:other'),
    );
    await new Promise((resolve) => setTimeout(resolve, 200));
    document.querySelector('.timeline-dot')!.dispatchEvent(new Event('pointerdown'));
    await new Promise((resolve) => setTimeout(resolve, 700));

    expect(addStarredMessage).not.toHaveBeenCalled();
    await scope.dispose();
  });

  it('cannot star the previous thread when its turns remount after the DOM briefly empties', async () => {
    document.body.innerHTML = '<div class="ds-user">prompt A</div>';
    const scope = new PluginScope();
    turnNavigatorPrimitive.activate(scope, {}, context(deepseek).ctx);
    await vi.waitFor(() => expect(document.querySelectorAll('.timeline-dot')).toHaveLength(1));

    history.pushState({}, '', '/a/chat/s/other');
    await vi.waitFor(() =>
      expect(getStarredMessagesForConversation).toHaveBeenLastCalledWith('deepseek:conv:other'),
    );
    document.querySelector('.ds-user')!.remove();
    // Let a refresh see the empty thread.
    await new Promise((resolve) => setTimeout(resolve, 300));
    // The previous thread re-renders with fresh elements.
    document.body.append(
      Object.assign(document.createElement('div'), {
        className: 'ds-user',
        textContent: 'prompt A',
      }),
    );
    await vi.waitFor(() => expect(document.querySelectorAll('.timeline-dot')).toHaveLength(1));
    document.querySelector('.timeline-dot')!.dispatchEvent(new Event('pointerdown'));
    await new Promise((resolve) => setTimeout(resolve, 700));

    expect(addStarredMessage).not.toHaveBeenCalled();
    await scope.dispose();
  });

  it('stars a new chat re-rendered under the id it was given', async () => {
    history.replaceState({}, '', '/');
    document.body.innerHTML = '<div class="ds-user">first prompt</div>';
    const scope = new PluginScope();
    turnNavigatorPrimitive.activate(scope, {}, context(deepseek).ctx);
    await vi.waitFor(() => expect(document.querySelectorAll('.timeline-dot')).toHaveLength(1));

    history.replaceState({}, '', '/a/chat/s/given');
    document.querySelector('.ds-user')!.replaceWith(
      Object.assign(document.createElement('div'), {
        className: 'ds-user',
        textContent: 'first prompt',
      }),
    );
    await vi.waitFor(() =>
      expect(getStarredMessagesForConversation).toHaveBeenLastCalledWith('deepseek:conv:given'),
    );
    await new Promise((resolve) => setTimeout(resolve, 200));
    document.querySelector('.timeline-dot')!.dispatchEvent(new Event('pointerdown'));
    await vi.waitFor(() =>
      expect(addStarredMessage).toHaveBeenCalledWith(
        expect.objectContaining({ conversationId: 'deepseek:conv:given', content: 'first prompt' }),
      ),
    );
    await scope.dispose();
  });

  it("drops the previous conversation's dots when a star change lands mid-switch", async () => {
    document.body.innerHTML = '<div class="ds-user">prompt A</div>';
    const scope = new PluginScope();
    turnNavigatorPrimitive.activate(scope, {}, context(deepseek).ctx);
    await vi.waitFor(() => expect(document.querySelectorAll('.timeline-dot')).toHaveLength(1));

    history.pushState({}, '', '/a/chat/s/other');
    // Another tab starred something before this tab refreshed for the new route.
    const callbacks = vi.mocked(chrome.storage.onChanged.addListener).mock.calls;
    const notify = callbacks[callbacks.length - 1][0];
    notify({ [StorageKeys.TIMELINE_STARRED_MESSAGES]: { newValue: [] } }, 'local');
    document.querySelector('.ds-user')!.replaceWith(
      Object.assign(document.createElement('div'), {
        className: 'ds-user',
        textContent: 'prompt B',
      }),
    );

    await vi.waitFor(() =>
      expect(
        Array.from(document.querySelectorAll('.timeline-dot')).map((dot) =>
          dot.getAttribute('aria-label'),
        ),
      ).toEqual(['prompt B']),
    );
    await scope.dispose();
  });
});
