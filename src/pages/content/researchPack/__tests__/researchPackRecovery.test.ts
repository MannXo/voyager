import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { StorageKeys } from '@/core/types/common';
import type { ResearchPackStore } from '@/features/researchPack/services/packStore';

import { startResearchPack } from '../index';
import {
  clickAdd,
  emitStorageChange,
  flush,
  geminiPageUrl,
  packOf,
  sharedStorage,
  shownItems,
  turn,
} from './fixtures';

const GLOBAL = StorageKeys.RESEARCH_PACK;

const loadError = () => document.querySelector<HTMLElement>('.gv-rp-load-error')!;
const retryButton = () => loadError().querySelector<HTMLButtonElement>('button')!;
const instructionBox = () => document.querySelector<HTMLTextAreaElement>('#gv-rp-instruction')!;
const footerButtons = () =>
  Array.from(document.querySelectorAll<HTMLButtonElement>('.gv-rp-actions button'));

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

  describe('when the scope cannot be resolved at first', () => {
    const failingOnce = () => {
      let calls = 0;
      return vi.fn(async () => {
        calls += 1;
        if (calls === 1) throw new Error('isolation setting unreadable');
        return GLOBAL;
      });
    };

    it('resolves it again when the user adds an answer', async () => {
      const shared = sharedStorage();
      const host = turn('<p>Added after storage recovered.</p>');
      stop = startResearchPack({
        pageUrl: geminiPageUrl,
        store: shared.store,
        resolveKey: failingOnce(),
      });
      await flush();
      expect(loadError().hidden).toBe(false);

      clickAdd(host);
      await flush();

      expect(shared.at(GLOBAL).map((item) => item.text)).toEqual([
        'Added after storage recovered.',
      ]);
      expect(shownItems()).toEqual(['Added after storage recovered.']);
      expect(loadError().hidden).toBe(true);
    });

    it('resolves it again from the Retry button', async () => {
      const shared = sharedStorage({ [GLOBAL]: packOf('stored item') });
      stop = startResearchPack({
        pageUrl: geminiPageUrl,
        store: shared.store,
        resolveKey: failingOnce(),
      });
      await flush();
      expect(shownItems()).toEqual([]);

      retryButton().click();
      await flush();

      expect(shownItems()).toEqual(['stored item']);
      expect(loadError().hidden).toBe(true);
      expect(instructionBox().disabled).toBe(false);
    });
  });

  it('shows a load failure with Retry, and keeps editing blocked until a load succeeds', async () => {
    const shared = sharedStorage({ [GLOBAL]: { ...packOf('stored item'), instruction: 'Keep' } });
    let failLoads = 2;
    const store: ResearchPackStore = {
      load: async (key) => {
        if (failLoads > 0) {
          failLoads -= 1;
          throw new Error('storage.local unavailable');
        }
        return shared.store.load(key);
      },
      apply: (key, op) => shared.store.apply(key, op),
    };
    stop = startResearchPack({ pageUrl: geminiPageUrl, store, resolveKey: async () => GLOBAL });
    await flush();

    expect(loadError().hidden).toBe(false);
    expect(instructionBox().disabled).toBe(true);
    expect(footerButtons().every((button) => button.disabled)).toBe(true);

    retryButton().click();
    await flush();
    expect(loadError().hidden).toBe(false);
    expect(instructionBox().disabled).toBe(true);

    retryButton().click();
    await flush();
    expect(loadError().hidden).toBe(true);
    expect(shownItems()).toEqual(['stored item']);
    expect(instructionBox().disabled).toBe(false);
    expect(instructionBox().value).toBe('Keep');
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
