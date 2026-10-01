import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { StorageKeys } from '@/core/types/common';

import { startResearchPack } from '../index';
import {
  emitStorageChange,
  flush,
  geminiPageUrl,
  packOf,
  sharedStorage,
  shownItems,
} from './fixtures';

const GLOBAL = StorageKeys.RESEARCH_PACK;

describe('research pack recovery', () => {
  let stop: (() => void) | null = null;

  beforeEach(() => {
    document.body.innerHTML = '';
    vi.mocked(chrome.storage.onChanged.addListener).mockClear();
    history.replaceState(null, '', '/u/0/app');
  });

  afterEach(() => {
    stop?.();
    stop = null;
    document.body.innerHTML = '';
    history.replaceState(null, '', '/');
  });

  it('never brings back a pack from before it was removed, once it has been recreated', async () => {
    // The owner's clock moves on between writes, as it does between user actions.
    let clock = 1_000;
    const shared = sharedStorage({}, { now: () => (clock += 10) });
    stop = startResearchPack({
      pageUrl: geminiPageUrl,
      store: shared.store,
      resolveKey: async () => GLOBAL,
    });
    await flush();
    const before = await shared.store.apply(GLOBAL, {
      kind: 'add',
      draft: { ...packOf('old item').items[0] },
    });
    for (let i = 0; i < 4; i += 1) {
      await shared.store.apply(GLOBAL, { kind: 'setInstruction', instruction: `edit ${i}` });
    }
    const last = shared.stored(GLOBAL)!;
    emitStorageChange({ [GLOBAL]: { newValue: last } }, 'local');
    expect(shownItems()).toEqual(['old item']);

    // Clearing extension data removes the pack; a new add recreates it.
    shared.remove(GLOBAL);
    emitStorageChange({ [GLOBAL]: { oldValue: last } }, 'local');
    expect(shownItems()).toEqual([]);
    const recreated = await shared.store.apply(GLOBAL, {
      kind: 'add',
      draft: { ...packOf('new item').items[0] },
    });
    emitStorageChange({ [GLOBAL]: { newValue: recreated.pack } }, 'local');
    expect(shownItems()).toEqual(['new item']);

    // A snapshot from before the removal arrives late.
    emitStorageChange({ [GLOBAL]: { newValue: last } }, 'local');
    emitStorageChange({ [GLOBAL]: { newValue: before.pack } }, 'local');
    expect(shownItems()).toEqual(['new item']);

    // Later writes keep showing.
    const next = await shared.store.apply(GLOBAL, {
      kind: 'add',
      draft: { ...packOf('newer item').items[0] },
    });
    emitStorageChange({ [GLOBAL]: { newValue: next.pack } }, 'local');
    expect(shownItems()).toEqual(['new item', 'newer item']);
  });
});
