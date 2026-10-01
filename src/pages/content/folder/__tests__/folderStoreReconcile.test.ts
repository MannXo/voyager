/**
 * Another context's write to the active bucket is applied once this tab has
 * nothing newer in flight: a pending write, a debounced edit or an in-flight
 * read must neither drop the external write nor revert the local edit.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import browser from 'webextension-polyfill';

import { accountIsolationService } from '@/core/services/AccountIsolationService';

import { FolderStore } from '../FolderStore';
import type { IFolderStorageAdapter } from '../storage/FolderStorageAdapter';
import type { FolderData } from '../types';

vi.mock('webextension-polyfill', () => ({
  default: {
    storage: {
      sync: { get: vi.fn(async () => ({})), set: vi.fn(async () => {}) },
      local: { get: vi.fn(async () => ({})), set: vi.fn(async () => {}) },
      onChanged: { addListener: vi.fn(), removeListener: vi.fn() },
    },
    runtime: { id: 'test-extension-id' },
  },
}));

const KEY = 'gvFolderData';
type StorageListener = (changes: Record<string, { newValue?: unknown }>, area: string) => void;

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((complete) => {
    resolve = complete;
  });
  return { promise, resolve };
}

function folders(...names: string[]): FolderData {
  return {
    folders: names.map((name, sortIndex) => ({
      id: name,
      name,
      parentId: null,
      isExpanded: true,
      createdAt: 1,
      updatedAt: 1,
      sortIndex,
    })),
    folderContents: Object.fromEntries(names.map((name) => [name, []])),
  };
}

function names(data: FolderData | undefined): string[] {
  return (data?.folders ?? []).map((folder) => folder.name);
}

describe('FolderStore reconciles external writes after local work settles', () => {
  let stored: FolderData | undefined;
  let adapter: IFolderStorageAdapter;
  let store: FolderStore;

  /** Delivers a storage.onChanged event for the bucket, as chrome.storage would. */
  function emit(value: FolderData | undefined): void {
    const [[listener]] = vi.mocked(browser.storage.onChanged.addListener).mock.calls;
    (listener as unknown as StorageListener)(
      { [KEY]: { newValue: structuredClone(value) } },
      'local',
    );
  }

  /** Another tab commits a write and this tab hears about it. */
  function writeFromElsewhere(value: FolderData): void {
    stored = structuredClone(value);
    emit(value);
  }

  beforeEach(async () => {
    vi.useFakeTimers();
    vi.clearAllMocks();
    localStorage.clear();
    vi.spyOn(accountIsolationService, 'isIsolationEnabled').mockResolvedValue(false);
    vi.spyOn(console, 'log').mockImplementation(() => {});
    stored = folders('Alpha');
    adapter = {
      init: vi.fn(async () => {}),
      loadData: vi.fn(async () => structuredClone(stored ?? null)),
      saveData: vi.fn(async (_key: string, data: FolderData) => {
        stored = structuredClone(data);
        return true;
      }),
      removeData: vi.fn(async () => {}),
      getBackendName: () => 'test-memory',
    };
    store = new FolderStore(
      {
        getContext: () => ({ sidebar: null, sortMode: 'manual', enabled: true }),
        onChange: vi.fn(),
        onArchive: vi.fn(),
        onRecovery: vi.fn(),
      },
      adapter,
    );
    await store.init();
  });

  afterEach(() => {
    store.destroy();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('applies a write that lands while its own write is pending, then keeps it', async () => {
    const write = deferred<boolean>();
    vi.mocked(adapter.saveData).mockImplementationOnce(async (_key, data) => {
      stored = structuredClone(data); // committed; the adapter promise is still pending
      return write.promise;
    });
    store.data.folders[0].name = 'Mine';
    const saving = store.saveData();
    emit(stored); // the echo of this tab's own write
    writeFromElsewhere(folders('Mine', 'From another tab'));

    write.resolve(true);
    await saving;
    await vi.advanceTimersByTimeAsync(0);
    expect(names(store.data)).toEqual(['Mine', 'From another tab']);

    store.data.folders[1].name = 'Edited afterwards';
    await store.saveData();
    expect(names(stored)).toEqual(['Mine', 'Edited afterwards']);
  });

  it('applies a write that lands while a draft replacement is pending', async () => {
    const write = deferred<boolean>();
    vi.mocked(adapter.saveData).mockImplementationOnce(async (_key, data) => {
      stored = structuredClone(data);
      return write.promise;
    });
    const replacing = store.replaceData(folders('Imported'));
    await vi.advanceTimersByTimeAsync(0);
    emit(stored);
    writeFromElsewhere(folders('Imported', 'From another tab'));

    write.resolve(true);
    await expect(replacing).resolves.toBe(true);
    await vi.advanceTimersByTimeAsync(0);
    expect(names(store.data)).toEqual(['Imported', 'From another tab']);
  });

  it('keeps a debounced edit when an unchanged value is reported before it saves', async () => {
    store.toggleFolder('Alpha');
    // Firefox reports writes that leave the value unchanged; this one carries no new data.
    emit(stored);
    await vi.advanceTimersByTimeAsync(350);

    expect(store.data.folders[0].isExpanded).toBe(false);
    expect(stored?.folders[0].isExpanded).toBe(false);
  });

  it('does not let a read already in flight revert a later debounced edit', async () => {
    const read = deferred<FolderData | null>();
    vi.mocked(adapter.loadData).mockImplementationOnce(() => read.promise);
    writeFromElsewhere(folders('Alpha', 'From another tab'));
    store.toggleFolder('Alpha');

    read.resolve(structuredClone(stored ?? null));
    await vi.advanceTimersByTimeAsync(350);

    expect(store.data.folders[0].isExpanded).toBe(false);
    expect(stored?.folders[0].isExpanded).toBe(false);
    expect(store.data).toEqual(stored);
  });
});
