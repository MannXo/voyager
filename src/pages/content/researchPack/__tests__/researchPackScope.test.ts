import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { buildScopedStorageKey } from '@/core/services/AccountIsolationService';
import { StorageKeys } from '@/core/types/common';
import { addItem, createEmptyPack } from '@/features/researchPack/services/packModel';
import {
  type ResearchPackStorageArea,
  type ResearchPackStore,
  createResearchPackOwner,
} from '@/features/researchPack/services/packStore';
import type { ResearchPack } from '@/features/researchPack/services/types';

import { startResearchPack } from '../index';
import type { ResearchPackScopeContext } from '../scope';
import { clickAdd, flush, turn } from './fixtures';

const GLOBAL = StorageKeys.RESEARCH_PACK;
const ACCOUNT_A = buildScopedStorageKey(StorageKeys.RESEARCH_PACK, 'route:0');
const ACCOUNT_B = buildScopedStorageKey(StorageKeys.RESEARCH_PACK, 'route:1');

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function packOf(text: string): ResearchPack {
  return addItem(
    createEmptyPack(),
    {
      text,
      excerpt: false,
      prompt: '',
      sourceTitle: text,
      sourceUrl: 'https://gemini.google.com/app/x',
      platform: 'gemini',
      citations: [],
    },
    1,
  ).pack;
}

function sharedStorage(initial: Record<string, ResearchPack> = {}) {
  const data = new Map<string, unknown>(Object.entries(initial));
  const area: ResearchPackStorageArea = {
    get: async (key) => (data.has(key) ? { [key]: structuredClone(data.get(key)) } : {}),
    set: async (items) => {
      for (const [key, value] of Object.entries(items)) data.set(key, structuredClone(value));
    },
  };
  const store = createResearchPackOwner({ area });
  const at = (key: string) => (data.get(key) as ResearchPack | undefined)?.items ?? [];
  const instruction = (key: string) => (data.get(key) as ResearchPack | undefined)?.instruction;
  return { store, at, instruction };
}

/** Wrap a store so loads or applies for chosen keys wait for an explicit release. */
function gated(store: ResearchPackStore, delayMs: { load?: string; apply?: string; ms: number }) {
  return {
    load: async (key: string) => {
      if (key === delayMs.load) await wait(delayMs.ms);
      return store.load(key);
    },
    apply: async (key: string, op: Parameters<ResearchPackStore['apply']>[1]) => {
      if (key === delayMs.apply) await wait(delayMs.ms);
      return store.apply(key, op);
    },
  } satisfies ResearchPackStore;
}

const shownItems = () =>
  Array.from(document.querySelectorAll('.gv-rp-item .gv-rp-item-snippet')).map(
    (node) => node.textContent,
  );

function emitStorageChange(changes: Record<string, unknown>, areaName: string): void {
  const calls = vi.mocked(chrome.storage.onChanged.addListener).mock.calls;
  const listener = calls[calls.length - 1][0] as (
    changes: Record<string, chrome.storage.StorageChange>,
    areaName: string,
  ) => void;
  listener(changes as Record<string, chrome.storage.StorageChange>, areaName);
}

const ISOLATION_ON = { [StorageKeys.GV_ACCOUNT_ISOLATION_ENABLED_GEMINI]: { newValue: true } };

describe('research pack account scope', () => {
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

  it('swaps to the account pack when isolation turns on, and exports only that pack', async () => {
    const { store } = sharedStorage({
      [GLOBAL]: packOf('global item'),
      [ACCOUNT_A]: packOf('A item'),
    });
    let isolated = false;
    stop = startResearchPack({
      store,
      resolveKey: async () => (isolated ? ACCOUNT_A : GLOBAL),
    });
    await flush();
    expect(shownItems()).toEqual(['global item']);

    isolated = true;
    emitStorageChange(ISOLATION_ON, 'sync');
    // The old scope's content is hidden before the new one has loaded.
    expect(shownItems()).toEqual([]);
    await flush();
    expect(shownItems()).toEqual(['A item']);

    const writeText = vi.fn(async (_text: string) => undefined);
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
    document.querySelectorAll<HTMLButtonElement>('.gv-rp-actions button')[1].click();
    expect(writeText.mock.calls[0][0]).toContain('A item');
    expect(writeText.mock.calls[0][0]).not.toContain('global item');
  });

  it('ignores a slow load for a scope that is no longer current', async () => {
    const shared = sharedStorage({
      [GLOBAL]: packOf('global item'),
      [ACCOUNT_A]: packOf('A item'),
    });
    let isolated = false;
    stop = startResearchPack({
      store: gated(shared.store, { load: GLOBAL, ms: 40 }),
      resolveKey: async () => (isolated ? ACCOUNT_A : GLOBAL),
    });

    isolated = true;
    emitStorageChange(ISOLATION_ON, 'sync');
    await flush();
    expect(shownItems()).toEqual(['A item']);

    await wait(60);
    expect(shownItems()).toEqual(['A item']);
  });

  it('writes an answer to the account it was added under, even if the page switches first', async () => {
    const shared = sharedStorage();
    const resolveKey = vi.fn(async (context: ResearchPackScopeContext) => {
      await wait(5);
      return context.routeUserId === '1' ? ACCOUNT_B : ACCOUNT_A;
    });
    const host = turn('<p>Asked under account 0.</p>');
    stop = startResearchPack({
      store: gated(shared.store, { apply: ACCOUNT_A, ms: 40 }),
      resolveKey,
    });

    clickAdd(host);
    history.pushState(null, '', '/u/1/app');
    emitStorageChange(ISOLATION_ON, 'sync');
    await wait(80);

    expect(shared.at(ACCOUNT_A).map((item) => item.text)).toEqual(['Asked under account 0.']);
    expect(shared.at(ACCOUNT_B)).toEqual([]);
    // The late reply for account 0 must not show up in account 1's panel.
    expect(shownItems()).toEqual([]);
  });

  it('saves unsaved typing to the pack it was typed in, then clears the box for the new scope', async () => {
    const shared = sharedStorage({
      [GLOBAL]: packOf('global item'),
      [ACCOUNT_A]: packOf('A item'),
    });
    let isolated = false;
    stop = startResearchPack({
      store: shared.store,
      resolveKey: async () => (isolated ? ACCOUNT_A : GLOBAL),
    });
    await flush();

    const textarea = document.querySelector<HTMLTextAreaElement>('#gv-rp-instruction')!;
    textarea.value = 'Typed for the global pack';
    textarea.dispatchEvent(new Event('input', { bubbles: true }));
    isolated = true;
    emitStorageChange(ISOLATION_ON, 'sync');
    await wait(10);

    expect(shared.instruction(GLOBAL)).toBe('Typed for the global pack');
    expect(shared.instruction(ACCOUNT_A)).toBe('');
    expect(textarea.value).toBe('');
  });

  it('reads and writes nothing when the scope cannot be resolved', async () => {
    const store: ResearchPackStore = { load: vi.fn(), apply: vi.fn() };
    const host = turn('<p>Unscoped.</p>');
    stop = startResearchPack({
      store,
      resolveKey: async () => {
        throw new Error('isolation setting unreadable');
      },
    });
    await flush();

    clickAdd(host);
    await flush();

    expect(store.load).not.toHaveBeenCalled();
    expect(store.apply).not.toHaveBeenCalled();
    expect(document.querySelector('.gv-rp-toast')!.getAttribute('data-tone')).toBe('error');
  });
});
