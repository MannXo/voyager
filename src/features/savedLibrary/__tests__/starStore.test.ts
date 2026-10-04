import { describe, expect, it, vi } from 'vitest';

import { GoogleDriveSyncPayloads } from '@/core/services/GoogleDriveSyncPayloads';
import { StorageKeys } from '@/core/types/common';

import { createStarStore } from '../starStore';
import type { StarredMessage, StarredMessagesData } from '../starTypes';

const neutral = StorageKeys.SAVED_LIBRARY_STARS;
const legacy = StorageKeys.TIMELINE_STARRED_MESSAGES;
const keys = [neutral, legacy];
const star = (turnId: string, starredAt = 1): StarredMessage => ({
  turnId,
  starredAt,
  conversationId: 'chat',
  conversationUrl: 'https://gemini.google.com/u/2/app/chat',
  content: `preview ${turnId}`,
});
const data = (...items: StarredMessage[]): StarredMessagesData => ({ messages: { chat: items } });

function setup(initial: Record<string, unknown> = {}) {
  const values = structuredClone(initial);
  const area = {
    get: vi.fn(async (requested: string[]) =>
      Object.fromEntries(
        requested.filter((key) => key in values).map((key) => [key, structuredClone(values[key])]),
      ),
    ),
    set: vi.fn(async (items: Record<string, unknown>) => {
      Object.assign(values, structuredClone(items));
    }),
  };
  return { values, area, store: createStarStore(area) };
}

function expectProjections(values: Record<string, unknown>, expected: StarredMessagesData) {
  expect(values[neutral]).toEqual(expected);
  expect(values[legacy]).toEqual(expected);
}

describe('Saved Library dual projections', () => {
  it('the first queued read migrates legacy stars once and later clean reads do not write', async () => {
    const expected = data(star('old'));
    const { store, values, area } = setup({ [legacy]: expected });
    await expect(Promise.all([store.getAll(), store.getForConversation('chat')])).resolves.toEqual([
      expected,
      expected.messages.chat,
    ]);
    expectProjections(values, expected);
    expect(area.set).toHaveBeenCalledTimes(1);
    expect(area.set).toHaveBeenCalledWith({ [neutral]: expected, [legacy]: expected });
    expect(area.get).toHaveBeenCalledTimes(2);
    expect(area.get).toHaveBeenCalledWith(keys);
  });

  it('an unused store stays absent until a mutation writes both projections in one call', async () => {
    const { store, area, values } = setup();
    await expect(store.getAll()).resolves.toEqual({ messages: {} });
    expect(area.set).not.toHaveBeenCalled();
    await store.add(star('first'));
    expect(area.set).toHaveBeenCalledTimes(1);
    expectProjections(values, data(star('first')));
  });

  it('a mutation folds initial migration into its one dual write', async () => {
    const { store, area, values } = setup({ [legacy]: data(star('old')) });
    await store.add(star('new'));
    expect(area.set).toHaveBeenCalledTimes(1);
    expectProjections(values, data(star('old'), star('new')));
    area.set.mockClear();
    await expect(store.add(star('old', 9))).resolves.toBe(false);
    await expect(store.remove('chat', 'missing')).resolves.toBe(false);
    expect(area.set).not.toHaveBeenCalled();
  });

  it('unions both copies with neutral ties, newer legacy values and preserved metadata', async () => {
    const rich = {
      ...star('tie', 5),
      content: 'neutral',
      account: 'opaque',
      conversationTitle: 'Title',
    };
    const { store, values } = setup({
      [neutral]: data(rich, star('newer', 3), star('neutral-only')),
      [legacy]: data(
        { ...star('tie', 5), content: 'legacy' },
        { turnId: 'newer', starredAt: 9 } as StarredMessage,
        star('legacy-only'),
      ),
    });
    const expected = data(rich, { ...star('newer', 9) }, star('legacy-only'), star('neutral-only'));
    await expect(store.getAll()).resolves.toEqual(expected);
    expectProjections(values, expected);
  });

  it('imports downgrade additions even when neutral exists and revives accepted legacy-only deletions', async () => {
    const original = data(star('kept'));
    const { store, values } = setup({ [neutral]: original, [legacy]: original });
    values[legacy] = data(star('kept'), star('downgrade-added'));
    await expect(store.getAll()).resolves.toEqual(data(star('kept'), star('downgrade-added')));
    values[legacy] = data(star('downgrade-added'));
    await expect(store.getAll()).resolves.toEqual(data(star('downgrade-added'), star('kept')));
    expectProjections(values, data(star('downgrade-added'), star('kept')));
    await store.remove('chat', 'kept');
    expectProjections(values, data(star('downgrade-added')));
  });

  it('successful reconciliation removes source buckets through later reads and owner restart', async () => {
    const draft = { ...star('draft-turn'), conversationId: 'draft' };
    const { store, values, area } = setup({
      [neutral]: data(star('existing')),
      [legacy]: { messages: { draft: [draft] } },
    });
    const result = await store.reconcile('chat', ['draft'], star('existing').conversationUrl);
    const expected = data(star('existing'), { ...draft, conversationId: 'chat' });
    expect(result).toEqual(expected.messages.chat);
    expect(area.set).toHaveBeenCalledTimes(1);
    await expect(store.getAll()).resolves.toEqual(expected);
    await expect(createStarStore(area).getAll()).resolves.toEqual(expected);
    expectProjections(values, expected);
    expect(area.set).toHaveBeenCalledTimes(1);
  });

  it.each([neutral, legacy])(
    'a malformed %s copy refuses every write and preserves the valid sibling',
    async (brokenKey) => {
      const initial = {
        [neutral]: data(star('safe')),
        [legacy]: data(star('safe')),
        [brokenKey]: { messages: { broken: null } },
      };
      const { store, values, area } = setup(initial);
      await expect(store.add(star('new'))).rejects.toThrow('Invalid starred messages bucket');
      await expect(store.getAll()).rejects.toThrow('Invalid starred messages bucket');
      expect(values).toEqual(initial);
      expect(area.set).not.toHaveBeenCalled();
    },
  );

  it('migration quota failure retains legacy bytes and a later queued read retries successfully', async () => {
    const expected = data(star('legacy'));
    const { store, area, values } = setup({ [legacy]: expected });
    area.set.mockRejectedValueOnce(new Error('quota'));
    await expect(store.getAll()).rejects.toThrow('quota');
    expect(values).toEqual({ [legacy]: expected });
    await expect(store.getAll()).resolves.toEqual(expected);
    expectProjections(values, expected);
  });

  it.each([neutral, legacy])(
    'a partial write to %s rejects removal and the next operation rereads both copies',
    async (writtenKey) => {
      const expected = data(star('kept'));
      const { store, area, values } = setup({ [neutral]: expected, [legacy]: expected });
      area.set.mockImplementationOnce(async (items) => {
        values[writtenKey] = structuredClone(items[writtenKey]);
        throw new Error('partial write');
      });
      await expect(store.remove('chat', 'kept')).rejects.toThrow('partial write');
      await expect(store.getAll()).resolves.toEqual(expected);
      expectProjections(values, expected);
      await expect(store.remove('chat', 'kept')).resolves.toBe(true);
      expectProjections(values, { messages: {} });
    },
  );

  it('the unchanged v1 Drive reader accepts a legacy projection with opaque account metadata', async () => {
    const saved = { ...star('account-star'), account: 'opaque-account' };
    const { store, values } = setup();
    await store.add(saved);
    const remote = new Map<string, unknown>();
    const payloads = new GoogleDriveSyncPayloads({
      ensure: async (_token, name) => name,
      find: async (_token, name) => (remote.has(name) ? name : null),
      upload: async (_token, name, payload) => {
        remote.set(name, structuredClone(payload));
      },
      download: async <T>(_token: string, name: string): Promise<T | null> =>
        (remote.get(name) as T) ?? null,
      prepareDownload: async () => {},
    });
    await payloads.upload('token', {
      folders: { folders: [], folderContents: {} },
      prompts: [],
      starred: values[legacy] as StarredMessagesData,
      platform: 'gemini',
      forks: null,
      timelineHierarchy: null,
      accountScope: null,
      timelineHierarchyAccountScope: null,
      settings: null,
      plugins: null,
    });
    const downloaded = await payloads.download('token', 'gemini', null, null);
    expect(downloaded?.starred).toEqual(
      expect.objectContaining({
        format: 'gemini-voyager.starred.v1',
        data: data(saved),
      }),
    );
    expect(Object.keys(values[legacy] as object)).toEqual(['messages']);
  });
});
