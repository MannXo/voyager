import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { buildScopedStorageKey } from '@/core/services/AccountIsolationService';
import {
  type MemoryStorage,
  createMemoryStorage,
  settle,
} from '@/features/plugins/builtin/chatgptFolders/__tests__/memoryStorage';
import type { TimelineHierarchyData } from '@/pages/content/timeline/hierarchyTypes';

import { TimelineState } from '../TimelineState';
import type { TimelineStoragePolicy } from '../TimelineStoragePolicy';

const KEY = 'gvCatalogTimelineHierarchy:claude';
const TURN = 'c-turn';
const states: TimelineState[] = [];
let storage: MemoryStorage;
let current: Set<string>;
/** Counts down reads from the next one; the read that reaches zero is held. */
let readsUntilHold: number;
let release: (() => void) | null;

function outline(conversation: string, level: 1 | 2 | 3) {
  return {
    conversationUrl: `https://claude.ai/chat/${conversation}`,
    levels: { [TURN]: level },
    collapsed: [],
    updatedAt: 1,
  };
}

function stored(conversation: string) {
  return (storage.values.local.get(KEY) as TimelineHierarchyData | undefined)?.conversations[
    `claude:conv:${conversation}`
  ];
}

function create(
  conversation: string,
  account: Pick<TimelineStoragePolicy['hierarchy'], 'accountAttributes' | 'resolveAccountScope'> = {
    accountAttributes: [],
    resolveAccountScope: async () => null,
  },
): TimelineState {
  current.add(conversation);
  const policy: TimelineStoragePolicy = {
    conversationId: `claude:conv:${conversation}`,
    url: `https://claude.ai/chat/${conversation}`,
    settingsPrefix: 'gvTimeline:claude:',
    stars: { matchLegacyConversations: false, resolveAccount: async () => undefined },
    hierarchy: {
      extensionKey: KEY,
      legacyLevelsKey: null,
      legacyCollapsedKey: null,
      adoptUnscopedHierarchy: false,
      ...account,
    },
    resolveMountedTurnId: (id) => id,
    resolveStoredTurnId: (id) => id,
    getStoredTurnIdAliases: (id) => [id],
    canEdit: () => true,
    isCurrent: () => current.has(conversation),
    getConversationTitle: () => conversation,
  };
  const state = new TimelineState(() => {}, policy);
  states.push(state);
  return state;
}

async function open(conversation: string): Promise<TimelineState> {
  const state = create(conversation);
  await state.init();
  return state;
}

beforeEach(() => {
  storage = createMemoryStorage();
  current = new Set();
  readsUntilHold = 0;
  release = null;
  const get = storage.api.local.get.bind(storage.api.local) as (keys: unknown) => Promise<unknown>;
  // Like chrome.storage, a held read still returns the bucket as it was when the read was issued.
  const local = {
    ...storage.api.local,
    get: async (keys: unknown) => {
      const snapshot = await get(keys);
      if (readsUntilHold > 0 && --readsUntilHold === 0) {
        await new Promise<void>((resolve) => {
          release = resolve;
        });
      }
      return snapshot;
    },
  };
  vi.stubGlobal('chrome', {
    ...chrome,
    runtime: {
      ...chrome.runtime,
      sendMessage: (_request: unknown, respond: (response: unknown) => void) =>
        respond({ ok: true, messages: [] }),
    },
    storage: { ...chrome.storage, local, onChanged: storage.api.onChanged },
  });
});

afterEach(async () => {
  release?.();
  await settle();
  states.splice(0).forEach((state) => state.destroy());
  vi.unstubAllGlobals();
});

describe('timeline outline persistence', () => {
  it('a second edit survives the first save’s storage echo', async () => {
    const state = await open('a');
    readsUntilHold = 2;
    state.hierarchy.setMarkerLevel(TURN, 2);
    state.hierarchy.toggleCollapse(TURN);
    await settle(30);
    expect(state.hierarchy.getMarkerLevel(TURN)).toBe(2);
    expect(state.hierarchy.isMarkerCollapsed(TURN)).toBe(true);

    release?.();
    await settle(30);
    expect(state.hierarchy.isMarkerCollapsed(TURN)).toBe(true);
    expect(stored('a')).toMatchObject({ levels: { [TURN]: 2 }, collapsed: [TURN] });
  });

  it('two conversations edited in one page both keep their outline', async () => {
    storage.values.local.set(KEY, {
      conversations: { 'claude:conv:a': outline('a', 2), 'claude:conv:b': outline('b', 2) },
    });
    const a = await open('a');
    const b = await open('b');
    readsUntilHold = 1;
    a.hierarchy.setMarkerLevel(TURN, 3);
    b.hierarchy.setMarkerLevel(TURN, 3);
    await settle(30);
    expect(a.hierarchy.getMarkerLevel(TURN)).toBe(3);

    release?.();
    await settle(30);
    expect(a.hierarchy.getMarkerLevel(TURN)).toBe(3);
    expect(b.hierarchy.getMarkerLevel(TURN)).toBe(3);
    expect(stored('a')?.levels).toEqual({ [TURN]: 3 });
    expect(stored('b')?.levels).toEqual({ [TURN]: 3 });
  });

  it('an outline edit stays on screen when another tab saves the bucket before it lands', async () => {
    storage.values.local.set(KEY, {
      conversations: { 'claude:conv:a': outline('a', 2), 'claude:conv:b': outline('b', 2) },
    });
    const a = await open('a');
    readsUntilHold = 1;
    a.hierarchy.setMarkerLevel(TURN, 3);
    await settle();
    storage.external('local', KEY, {
      conversations: { 'claude:conv:a': outline('a', 2), 'claude:conv:b': outline('b', 3) },
    });
    await settle(30);
    expect(a.hierarchy.getMarkerLevel(TURN)).toBe(3);

    release?.();
    await settle(30);
    expect(a.hierarchy.getMarkerLevel(TURN)).toBe(3);
    expect(stored('a')?.levels).toEqual({ [TURN]: 3 });
  });

  it('an outline edit made just before leaving the conversation is kept', async () => {
    storage.values.local.set(KEY, { conversations: { 'claude:conv:a': outline('a', 2) } });
    const state = await open('a');
    readsUntilHold = 1;
    state.hierarchy.setMarkerLevel(TURN, 3);
    expect(state.hierarchy.getMarkerLevel(TURN)).toBe(3);
    await settle();
    current.delete('a');
    state.destroy();

    release?.();
    await settle(30);
    expect(stored('a')?.levels).toEqual({ [TURN]: 3 });
    expect((await open('a')).hierarchy.getMarkerLevel(TURN)).toBe(3);
  });

  it('the previous account’s outline stays hidden while a switched account is still resolving', async () => {
    const attribute = 'data-test-account';
    const keyFor = (account: string) => buildScopedStorageKey(KEY, account);
    const resolving: Array<(account: string) => void> = [];
    document.documentElement.setAttribute(attribute, 'a');
    try {
      const state = create('a', {
        accountAttributes: [attribute],
        resolveAccountScope: () =>
          new Promise((resolve) =>
            resolving.push((accountKey) => resolve({ accountKey, routeUserId: null })),
          ),
      });
      void state.init();
      await settle();
      document.documentElement.setAttribute(attribute, 'b');
      await settle();
      expect(resolving).toHaveLength(2);

      resolving[0]('a');
      await settle(30);
      storage.external('local', keyFor('a'), {
        conversations: { 'claude:conv:a': outline('a', 3) },
      });
      await settle(30);
      expect(state.hierarchy.getMarkerLevel(TURN)).toBe(1);

      resolving[1]('b');
      await settle(30);
      expect(state.hierarchy.getMarkerLevel(TURN)).toBe(1);
      state.hierarchy.setMarkerLevel(TURN, 2);
      await settle(30);
      expect(storage.values.local.get(keyFor('a'))).toEqual({
        conversations: { 'claude:conv:a': outline('a', 3) },
      });
      expect(storage.values.local.get(keyFor('b'))).toMatchObject({
        conversations: { 'claude:conv:a': { levels: { [TURN]: 2 } } },
      });
    } finally {
      document.documentElement.removeAttribute(attribute);
    }
  });
});
