import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { StorageKeys } from '@/core/types/common';
import { AUTHORITY_FENCE_KEY } from '@/features/folder/owner/authorityFence';
import { CHATGPT_FOLDER_CONFIG } from '@/features/plugins/builtin/chatgptFolders/config';

import { FolderRepository } from './FolderRepository';
import {
  AISTUDIO_FOLDER_CONFIG,
  GEMINI_FOLDER_CONFIG,
  type PlatformFolderConfig,
} from './platformFolderConfig';
import { AIStudioFolderStorageAdapter } from './storage/AIStudioFolderStorageAdapter';
import { LocalStorageFolderAdapter } from './storage/FolderStorageAdapter';
import type { FolderData } from './types';

vi.mock('webextension-polyfill', () => ({
  default: {
    get storage() {
      return chrome.storage;
    },
    get runtime() {
      return chrome.runtime;
    },
  },
}));

type Listener = (changes: Record<string, { newValue?: unknown }>, area: string) => void;
const configs = [GEMINI_FOLDER_CONFIG, AISTUDIO_FOLDER_CONFIG, CHATGPT_FOLDER_CONFIG];
const initial: FolderData = {
  folders: [
    {
      id: 'f',
      name: 'Stored',
      parentId: null,
      isExpanded: true,
      createdAt: 1,
      updatedAt: 1,
      sortIndex: 0,
    },
  ],
  folderContents: { f: [] },
};
const clone = <T>(value: T): T => (value === undefined ? value : structuredClone(value));
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((complete) => {
    resolve = complete;
  });
  return { promise, resolve };
}
async function settle() {
  for (let i = 0; i < 150; i++) await Promise.resolve();
}

let originalStorage: typeof chrome.storage;
let stored: Record<string, unknown>;
let listeners: Set<Listener>;
const repositories: FolderRepository[] = [];
const recovery = vi.fn();
const set = vi.fn<(items: Record<string, unknown>) => Promise<void>>();
const get = vi.fn<(keys: string | string[]) => Promise<Record<string, unknown>>>();
function read(keys: string | string[]) {
  return Object.fromEntries(
    (Array.isArray(keys) ? keys : [keys]).map((key) => [key, clone(stored[key])]),
  );
}
function emit(key: string, value: unknown) {
  stored[key] = clone(value);
  for (const listener of listeners) listener({ [key]: { newValue: clone(value) } }, 'local');
}
function commit(items: Record<string, unknown>) {
  for (const [key, value] of Object.entries(items)) emit(key, value);
}
function owner(config: PlatformFolderConfig) {
  const site = config.storageKey === StorageKeys.FOLDER_DATA_CHATGPT ? 'chatgpt' : config.platform;
  return { build: 'test', sites: { [site!]: 'owner' } };
}
function create(config: PlatformFolderConfig) {
  const reloads = vi.fn();
  const repo = new FolderRepository(
    config,
    config === GEMINI_FOLDER_CONFIG
      ? new LocalStorageFolderAdapter()
      : new AIStudioFolderStorageAdapter(),
    {
      onChange: () => {},
      onAccountReleased: () => {},
      onRecovery: recovery,
      isEnabled: () => true,
      onExternalChange: () => {
        reloads();
        // Bound a broken reload loop so the regression reports failure instead of starving Vitest.
        if (reloads.mock.calls.length <= 20) void repo.loadData();
      },
    },
  );
  repositories.push(repo);
  return { repo, reloads };
}
async function ready(config: PlatformFolderConfig) {
  stored[config.storageKey] = clone(initial);
  const result = create(config);
  await result.repo.init();
  await settle();
  return result;
}
function emergency(config: PlatformFolderConfig) {
  return JSON.parse(localStorage.getItem(`gvBackup_${config.backupNamespace}_emergency`)!) as {
    data: FolderData;
  };
}

beforeEach(() => {
  vi.useFakeTimers();
  originalStorage = chrome.storage;
  stored = {};
  listeners = new Set();
  recovery.mockReset();
  get.mockReset().mockImplementation(async (keys) => read(keys));
  set.mockReset().mockImplementation(async (items) => commit(items));
  chrome.storage = {
    local: {
      get,
      set,
      remove: vi.fn(async (keys: string | string[]) => {
        for (const key of Array.isArray(keys) ? keys : [keys]) delete stored[key];
      }),
    },
    sync: { get: vi.fn(async () => ({})), set: vi.fn(async () => {}) },
    onChanged: {
      addListener: (listener: Listener) => listeners.add(listener),
      removeListener: (listener: Listener) => listeners.delete(listener),
    },
  } as unknown as typeof chrome.storage;
  localStorage.clear();
  document.body.replaceChildren();
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => {
  for (const repo of repositories.splice(0)) repo.destroy();
  chrome.storage = originalStorage;
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe.each(configs)('folder fence availability for $storageKey', (config) => {
  it.each(['owner', 'unreadable'] as const)(
    'does not spin reconciliation after a bucket event while authority is %s',
    async (state) => {
      const { repo, reloads } = await ready(config);
      repo.data.folders[0].name = 'Memory';
      if (state === 'owner') emit(AUTHORITY_FENCE_KEY, owner(config));
      else {
        get.mockImplementation(async (keys) => {
          if (keys === AUTHORITY_FENCE_KEY) throw new Error('Authority unreadable');
          return read(keys);
        });
        await repo.loadData();
      }
      reloads.mockClear();
      emit(config.storageKey, {
        ...initial,
        folders: [{ ...initial.folders[0], name: 'External' }],
      });
      await settle();
      expect(reloads.mock.calls.length).toBeLessThanOrEqual(1);
      expect(repo.canEdit).toBe(false);
      expect(repo.data.folders[0].name).toBe('Memory');
      if (state === 'owner') {
        await vi.advanceTimersByTimeAsync(60000);
        expect(reloads.mock.calls.length).toBeLessThanOrEqual(1);
        expect(document.querySelectorAll('[role="alert"]')).toHaveLength(1);
      }
    },
  );

  it('keeps a failed rename visible and recovers after authority outlasts account retries', async () => {
    const { repo } = await ready(config);
    set.mockRejectedValue(new Error('Save unavailable'));
    repo.data.folders[0].name = 'Mine';
    expect(await repo.saveData()).toBe(false);
    await settle();
    set.mockImplementation(async (items) => commit(items));
    get.mockImplementation(async (keys) => {
      if (keys === AUTHORITY_FENCE_KEY) throw new Error('Authority unreadable');
      return read(keys);
    });
    repo.suspend();
    await repo.refreshAccountScope();
    await repo.loadData();
    await vi.advanceTimersByTimeAsync(120000);
    expect(repo.data.folders[0]?.name).toBe('Mine');
    expect(repo.canEdit).toBe(false);
    stored[config.storageKey] = { corrupted: true };
    localStorage.removeItem(config.storageKey);
    get.mockImplementation(async (keys) => read(keys));
    await vi.advanceTimersByTimeAsync(30000);
    await settle();
    expect(repo.data.folders[0]?.name).toBe('Mine');
    expect(repo.canEdit).toBe(true);
    expect((stored[config.storageKey] as FolderData).folders[0].name).toBe('Mine');
  });

  it('retries an accepted queued rename after temporary authority failure without rolling it back', async () => {
    const { repo } = await ready(config);
    const first = deferred<void>();
    const started = deferred<void>();
    set.mockImplementation(async (items) => {
      if ((items[config.storageKey] as FolderData | undefined)?.folders[0]?.name === 'B') {
        started.resolve();
        await first.promise;
      }
      commit(items);
    });
    repo.data.folders[0].name = 'B';
    const savingB = repo.saveData();
    await started.promise;
    let unavailable = true;
    get.mockImplementation(async (keys) => {
      if (keys === AUTHORITY_FENCE_KEY && unavailable) throw new Error('Authority unreadable');
      return read(keys);
    });
    repo.data.folders[0].name = 'C';
    let completedC: boolean | undefined;
    const savingC = repo.saveData().then((saved) => (completedC = saved));
    await settle();
    first.resolve();
    expect(await savingB).toBe(true);
    await settle();
    expect(repo.data.folders[0].name).toBe('C');
    expect(completedC).toBeUndefined();
    expect((stored[config.storageKey] as FolderData).folders[0].name).toBe('B');
    // Availability recovers for one probe, then disappears again before the actual replay.
    let recoveredProbe = false;
    get.mockImplementation(async (keys) => {
      if (keys === AUTHORITY_FENCE_KEY) {
        if (recoveredProbe) throw new Error('Authority unavailable again');
        recoveredProbe = true;
      }
      return read(keys);
    });
    await vi.advanceTimersByTimeAsync(1000);
    await settle();
    expect(recoveredProbe).toBe(true);
    expect(completedC).toBeUndefined();
    expect(repo.data.folders[0].name).toBe('C');
    expect((stored[config.storageKey] as FolderData).folders[0].name).toBe('B');
    unavailable = false;
    get.mockImplementation(async (keys) => read(keys));
    await vi.advanceTimersByTimeAsync(30000);
    await settle();
    expect(await savingC).toBe(true);
    expect(repo.data.folders[0].name).toBe('C');
    expect((stored[config.storageKey] as FolderData).folders[0].name).toBe('C');
    expect(emergency(config).data.folders[0].name).toBe('C');
  });

  it('an accepted debounced expansion survives unreadable authority and suspend/resume', async () => {
    const { repo } = await ready(config);
    repo.data.folders[0].isExpanded = false;
    repo.scheduleSaveData();
    get.mockImplementation(async (keys) => {
      if (keys === AUTHORITY_FENCE_KEY) throw new Error('Authority unreadable');
      return read(keys);
    });
    await repo.loadData();
    repo.suspend();
    await repo.refreshAccountScope();
    expect(repo.canEdit).toBe(false);
    expect(repo.data.folders[0].isExpanded).toBe(false);
    get.mockImplementation(async (keys) => read(keys));
    await vi.advanceTimersByTimeAsync(30000);
    await settle();
    expect(repo.canEdit).toBe(true);
    expect(repo.data.folders[0].isExpanded).toBe(false);
    expect((stored[config.storageKey] as FolderData).folders[0].isExpanded).toBe(false);
  });

  it('destroy flushes an accepted debounced edit when no owner fence exists', async () => {
    const { repo } = await ready(config);
    repo.data.folders[0].isExpanded = false;
    repo.scheduleSaveData();
    repo.destroy();
    await settle();
    expect((stored[config.storageKey] as FolderData).folders[0].isExpanded).toBe(false);
  });

  it('an older authorization cannot replace the newest emergency recovery snapshot', async () => {
    const { repo } = await ready(config);
    const earlier = deferred<Record<string, unknown>>();
    let held = false;
    get.mockImplementation(async (keys) => {
      if (keys === AUTHORITY_FENCE_KEY && !held) {
        held = true;
        return earlier.promise;
      }
      return read(keys);
    });
    set.mockRejectedValue(new Error('Save unavailable'));
    repo.data.folders[0].name = 'Earlier';
    const firstSave = repo.saveData();
    repo.data.folders[0].name = 'Newest';
    const newestSave = repo.saveData();
    await settle();
    expect(emergency(config).data.folders[0].name).toBe('Newest');
    earlier.resolve({});
    expect(await firstSave).toBe(false);
    expect(await newestSave).toBe(false);
    await settle();
    expect(emergency(config).data.folders[0].name).toBe('Newest');
    repo.destroy();
    localStorage.removeItem(`gvBackup_${config.backupNamespace}_primary`);
    localStorage.removeItem(config.storageKey);
    stored[config.storageKey] = { corrupted: true };
    set.mockImplementation(async (items) => commit(items));
    const recovered = create(config).repo;
    await recovered.init();
    await settle();
    expect(recovered.data.folders[0]?.name).toBe('Newest');
    expect((stored[config.storageKey] as FolderData).folders[0]?.name).toBe('Newest');
  });

  it('a hung authority read parks edits by deadline and retries the latest accepted rename', async () => {
    const { repo } = await ready(config);
    const hung = deferred<Record<string, unknown>>();
    get.mockImplementation(async (keys) =>
      keys === AUTHORITY_FENCE_KEY ? hung.promise : read(keys),
    );
    repo.data.folders[0].name = 'Earlier';
    const savingEarlier = repo.saveData();
    repo.data.folders[0].name = 'Latest';
    const savingLatest = repo.saveData();
    await settle();
    await vi.advanceTimersByTimeAsync(1001);
    expect(repo.canEdit).toBe(false);
    expect(repo.data.folders[0].name).toBe('Latest');
    expect(stored[config.storageKey]).toEqual(initial);
    expect(recovery).toHaveBeenCalledWith('unreadable');
    expect(await savingEarlier).toBe(false);
    get.mockImplementation(async (keys) => read(keys));
    await vi.advanceTimersByTimeAsync(30000);
    await settle();
    expect(await savingLatest).toBe(true);
    expect((stored[config.storageKey] as FolderData).folders[0].name).toBe('Latest');
    expect(repo.canEdit).toBe(true);
    hung.resolve({});
    await settle();
    expect(repo.data.folders[0].name).toBe('Latest');
  });

  it('a late authority answer cannot reopen an owner-fenced tab or replay accepted edits', async () => {
    const { repo, reloads } = await ready(config);
    const hung = deferred<Record<string, unknown>>();
    get.mockImplementation(async (keys) =>
      keys === AUTHORITY_FENCE_KEY ? hung.promise : read(keys),
    );
    repo.data.folders[0].name = 'Unsaved';
    const saving = repo.saveData();
    await settle();
    await vi.advanceTimersByTimeAsync(1001);
    emit(AUTHORITY_FENCE_KEY, owner(config));
    hung.resolve({});
    await settle();
    expect(await saving).toBe(false);
    await vi.advanceTimersByTimeAsync(60000);
    expect(repo.canEdit).toBe(false);
    expect(repo.data.folders[0].name).toBe('Unsaved');
    expect(stored[config.storageKey]).toEqual(initial);
    expect(document.querySelectorAll('[role="alert"]')).toHaveLength(1);
    expect(reloads.mock.calls.length).toBeLessThanOrEqual(1);
  });
});
