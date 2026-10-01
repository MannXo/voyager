import { describe, expect, it, vi } from 'vitest';

import { buildScopedStorageKey } from '@/core/services/AccountIsolationService';
import { StorageKeys } from '@/core/types/common';

import { addItem, setInstruction } from '../packModel';
import {
  type ResearchPackStorageArea,
  createResearchPackStore,
  isResearchPackStorageKey,
  resolveResearchPackStorageKey,
} from '../packStore';
import type { ResearchPackDraftItem } from '../types';

function memoryArea(initial: Record<string, unknown> = {}) {
  const data = new Map(Object.entries(initial));
  const area: ResearchPackStorageArea = {
    get: vi.fn(async (key: string) => (data.has(key) ? { [key]: data.get(key) } : {})),
    set: vi.fn(async (items: Record<string, unknown>) => {
      for (const [key, value] of Object.entries(items)) data.set(key, structuredClone(value));
    }),
  };
  return { area, data };
}

const draft = (text: string): ResearchPackDraftItem => ({
  text,
  excerpt: false,
  prompt: '',
  sourceTitle: 'Conversation',
  sourceUrl: 'https://gemini.google.com/app/abc',
  platform: 'gemini',
  citations: [{ url: 'https://example.com/a', title: 'A' }],
});

describe('research pack store', () => {
  it('round-trips a pack through storage', async () => {
    const { area, data } = memoryArea();
    const store = createResearchPackStore({ area, resolveKey: async () => 'k' });

    await store.update((pack) => ({ pack: addItem(pack, draft('one'), 1).pack, result: null }));
    await store.update((pack) => ({ pack: setInstruction(pack, 'Go deeper', 2), result: null }));

    const loaded = await store.load();
    expect(loaded.items.map((item) => item.text)).toEqual(['one']);
    expect(loaded.items[0].citations).toEqual([{ url: 'https://example.com/a', title: 'A' }]);
    expect(loaded.instruction).toBe('Go deeper');
    expect(data.get('k')).toEqual(loaded);
  });

  it('serializes concurrent updates so none is lost', async () => {
    const { area } = memoryArea();
    const store = createResearchPackStore({ area, resolveKey: async () => 'k' });

    await Promise.all(
      ['a', 'b', 'c'].map((text, index) =>
        store.update((pack) => ({ pack: addItem(pack, draft(text), index).pack, result: null })),
      ),
    );

    expect((await store.load()).items.map((item) => item.text)).toEqual(['a', 'b', 'c']);
  });

  it('skips the write when nothing changed', async () => {
    const { area } = memoryArea();
    const store = createResearchPackStore({ area, resolveKey: async () => 'k' });

    await store.update((pack) => ({ pack, result: null }));
    expect(area.set).not.toHaveBeenCalled();
  });

  it('reads malformed data as an empty pack instead of failing', async () => {
    const { area } = memoryArea({ k: 'garbage' });
    const store = createResearchPackStore({ area, resolveKey: async () => 'k' });

    expect((await store.load()).items).toEqual([]);
  });

  it('never overwrites a pack written by a newer build', async () => {
    const newer = { version: 2, items: [{ text: 'future' }] };
    const { area, data } = memoryArea({ k: newer });
    const store = createResearchPackStore({ area, resolveKey: async () => 'k' });

    await store.update((pack) => ({ pack: addItem(pack, draft('x'), 1).pack, result: null }));
    expect(area.set).not.toHaveBeenCalled();
    expect(data.get('k')).toEqual(newer);
  });
});

describe('research pack storage key', () => {
  it('uses one global key while account isolation is off', async () => {
    const resolveAccountKey = vi.fn(async () => 'email:abc');
    await expect(
      resolveResearchPackStorageKey({ isIsolationEnabled: async () => false, resolveAccountKey }),
    ).resolves.toBe(StorageKeys.RESEARCH_PACK);
    expect(resolveAccountKey).not.toHaveBeenCalled();
  });

  it('scopes the pack per account when isolation is on', async () => {
    const key = await resolveResearchPackStorageKey({
      isIsolationEnabled: async () => true,
      resolveAccountKey: async () => 'email:abc',
    });

    expect(key).toBe(buildScopedStorageKey(StorageKeys.RESEARCH_PACK, 'email:abc'));
    expect(key).not.toBe(StorageKeys.RESEARCH_PACK);
    expect(isResearchPackStorageKey(key)).toBe(true);
  });

  it('recognizes only pack keys, not the enable toggle', () => {
    expect(isResearchPackStorageKey(StorageKeys.RESEARCH_PACK)).toBe(true);
    expect(isResearchPackStorageKey(StorageKeys.RESEARCH_PACK_ENABLED)).toBe(false);
    expect(isResearchPackStorageKey('gvResearchPackOther')).toBe(false);
  });
});
