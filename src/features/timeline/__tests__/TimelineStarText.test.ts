import { afterEach, beforeEach, expect, it, vi } from 'vitest';

import { StorageKeys } from '@/core/types/common';
import { createStarStore } from '@/features/savedLibrary/starStore';
import type { StarredMessage, StarredMessagesData } from '@/features/savedLibrary/starTypes';
import { isHandledBackgroundRuntimeMessage } from '@/pages/background/runtimeMessageRouting';
import { createStarredMessagesHandler } from '@/pages/background/starredMessages';
import { createGeminiTimelineStoragePolicy } from '@/pages/content/timeline/GeminiTimelineStorage';
import { TimelineTurns } from '@/pages/content/timeline/TimelineTurns';

import { TimelineState } from '../TimelineState';

const conversationId = 'gemini:conv:full-text';
const url = 'https://gemini.google.com/app/full-text';
const turnId = 's-1111111111111111';
const states: TimelineState[] = [];
const star = (id = turnId): StarredMessage => ({
  conversationId,
  conversationUrl: url,
  turnId: id,
  content: 'First line Second line',
  starredAt: 1,
});

beforeEach(() => {
  vi.clearAllMocks();
  document.body.replaceChildren();
  history.replaceState({}, '', '/app/full-text');
  localStorage.clear();
});
afterEach(() => {
  states.splice(0).forEach((state) => state.destroy());
  vi.restoreAllMocks();
});

function fixture(messages: StarredMessage[] = []) {
  const data: StarredMessagesData = { messages: { [conversationId]: messages } };
  const values: Record<string, unknown> = {
    [StorageKeys.SAVED_LIBRARY_STARS]: structuredClone(data),
    [StorageKeys.TIMELINE_STARRED_MESSAGES]: structuredClone(data),
    [StorageKeys.SAVED_LIBRARY_STAR_TOMBSTONES]: [],
  };
  const area = {
    get: vi.fn(async () => structuredClone(values)),
    set: vi.fn(async (items: Record<string, unknown>) => {
      const changes = Object.fromEntries(
        Object.entries(items).map(([key, newValue]) => [
          key,
          { oldValue: values[key], newValue: structuredClone(newValue) },
        ]),
      );
      Object.assign(values, structuredClone(items));
      for (const [receive] of vi.mocked(chrome.storage.onChanged.addListener).mock.calls)
        receive(changes, 'local');
    }),
  };
  const store = createStarStore(area);
  const handle = createStarredMessagesHandler(store);
  vi.mocked(chrome.runtime.sendMessage).mockImplementation(((
    request: unknown,
    reply: (response: unknown) => void,
  ) => {
    if (!isHandledBackgroundRuntimeMessage(request)) throw new Error('Unregistered action');
    void handle(request)?.then(reply, (error: Error) => reply({ ok: false, error: error.message }));
  }) as typeof chrome.runtime.sendMessage);
  const policy = {
    ...createGeminiTimelineStoragePolicy(url, {
      resolveCanonicalTurnId: (_conversation, id) => (id === 'u-0' ? turnId : id),
      getTurnIdAliases: () => [turnId, 'u-0'],
    }),
    hierarchy: { localKey: null },
    stars: { matchLegacyConversations: true, resolveAccount: async () => undefined },
  };
  const state = new TimelineState(() => {}, policy);
  states.push(state);
  const mount = (id = turnId) => {
    document.body.innerHTML = `<main><user-query data-turn-id="${id}">First line
Second line</user-query><model-response>Answer stays in the conversation</model-response></main>`;
    const markers = new TimelineTurns().collect(document.querySelector('main')!, 'user-query');
    state.replaceMarkers(markers);
    return markers;
  };
  return { state, store, area, values, mount, policy };
}

it('a starred prompt keeps its line breaks through the real timeline and Library store', async () => {
  const { state, store, mount } = fixture();
  await state.init();
  mount();
  await state.toggleStar(turnId);
  expect(await store.getForConversation(conversationId)).toEqual([
    expect.objectContaining({
      content: 'First line Second line',
      text: 'First line\nSecond line',
    }),
  ]);
});

it('opening an old conversation fills in the full text of its stars once', async () => {
  const { state, store, area, mount, values } = fixture([star()]);
  await state.init();
  const markers = mount();
  expect(await store.getForConversation(conversationId)).toEqual([
    { ...star(), text: 'First line\nSecond line' },
  ]);
  expect(area.set).toHaveBeenCalledTimes(1);
  expect(values[StorageKeys.TIMELINE_STARRED_MESSAGES]).toEqual({
    messages: { [conversationId]: [star()] },
  });
  state.replaceMarkers(markers);
  await store.getAll();
  expect(area.set).toHaveBeenCalledTimes(1);
});

it('an initial Library read arriving after the turns mount still backfills their full text', async () => {
  const { state, store, mount } = fixture([star()]);
  mount();
  await state.init();
  expect(await store.getForConversation(conversationId)).toEqual([
    { ...star(), text: 'First line\nSecond line' },
  ]);
});

it('backfill enriches a verified stored alias without creating another star', async () => {
  const { state, store, mount } = fixture([star('u-0')]);
  await state.init();
  mount();
  expect(await store.getForConversation(conversationId)).toEqual([
    { ...star('u-0'), text: 'First line\nSecond line' },
  ]);
});

it('an unverified mounted fallback cannot fill another stored turn with its text', async () => {
  const { state, store, area, mount } = fixture([star('u-0')]);
  await state.init();
  mount('u-0');
  expect(await store.getForConversation(conversationId)).toEqual([star('u-0')]);
  expect(area.set).not.toHaveBeenCalled();
});

it('a disconnected remembered marker cannot backfill an unopened turn', async () => {
  const { state, store, area, mount } = fixture([star()]);
  const markers = mount();
  document.body.replaceChildren();
  await state.init();
  state.replaceMarkers(markers);
  expect(await store.getForConversation(conversationId)).toEqual([star()]);
  expect(area.set).not.toHaveBeenCalled();
});

it('a destroyed timeline does not backfill from a late Library read', async () => {
  const { state, store, area, mount } = fixture([star()]);
  let release!: () => void;
  const waiting = new Promise<void>((resolve) => {
    release = resolve;
  });
  const get = area.get.getMockImplementation()!;
  area.get.mockImplementationOnce(async () => {
    await waiting;
    return get();
  });
  mount();
  const initializing = state.init();
  state.destroy();
  release();
  await initializing;
  expect(await store.getForConversation(conversationId)).toEqual([star()]);
  expect(area.set).not.toHaveBeenCalled();
});

it('a star press keeps the full text captured before account lookup yields', async () => {
  const { state, store, mount, policy } = fixture();
  await state.init();
  const [marker] = mount();
  let release!: () => void;
  const waiting = new Promise<void>((resolve) => {
    release = resolve;
  });
  policy.stars.resolveAccount = async () => {
    await waiting;
    return undefined;
  };
  const pressing = state.toggleStar(turnId);
  marker!.text = 'Changed after the press';
  release();
  await pressing;
  expect((await store.getForConversation(conversationId))[0]?.text).toBe('First line\nSecond line');
});

it('navigation before delayed teardown cannot backfill the old route from a late Library read', async () => {
  const { state, store, area, mount } = fixture([star()]);
  let release!: () => void;
  const waiting = new Promise<void>((resolve) => {
    release = resolve;
  });
  const get = area.get.getMockImplementation()!;
  area.get.mockImplementationOnce(async () => {
    await waiting;
    return get();
  });
  mount();
  const initializing = state.init();
  history.replaceState({}, '', '/app/next-conversation');
  release();
  await initializing;
  expect(await store.getForConversation(conversationId)).toEqual([star()]);
  expect(area.set).not.toHaveBeenCalled();
});

it('navigation during account lookup keeps a full-text star press on its captured route', async () => {
  const { state, store, mount, policy } = fixture();
  await state.init();
  mount();
  let release!: () => void;
  const waiting = new Promise<void>((resolve) => {
    release = resolve;
  });
  policy.stars.resolveAccount = async () => {
    await waiting;
    return undefined;
  };
  const pressing = state.toggleStar(turnId);
  history.replaceState({}, '', '/app/next-conversation');
  release();
  await pressing;
  expect(await store.getForConversation(conversationId)).toEqual([
    expect.objectContaining({ conversationUrl: url, text: 'First line\nSecond line' }),
  ]);
});
