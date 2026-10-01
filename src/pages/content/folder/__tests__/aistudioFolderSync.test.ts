/**
 * Behavior AI Studio gained by moving onto FolderRepository: it reloads when
 * another context writes its active bucket, ignores its own write echoes, and
 * retries a failed account-scope resolution before the next account poll.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  accountIsolationService,
  buildScopedStorageKey,
} from '@/core/services/AccountIsolationService';
import { StorageKeys } from '@/core/types/common';
import type { PromptItem } from '@/core/types/sync';

import { AIStudioFolderManager } from '../aistudio';
import type { FolderData } from '../types';

const { mockBrowser } = vi.hoisted(() => ({
  mockBrowser: {
    runtime: {
      id: 'test-extension-id',
      onMessage: { addListener: vi.fn(), removeListener: vi.fn() },
      sendMessage: vi.fn(),
    },
    storage: {
      onChanged: { addListener: vi.fn(), removeListener: vi.fn() },
      local: { get: vi.fn(), set: vi.fn(), remove: vi.fn() },
      sync: { get: vi.fn(), set: vi.fn() },
    },
  },
}));

vi.mock('webextension-polyfill', () => ({ default: mockBrowser }));

type Manager = {
  data: FolderData;
  activeStorageKey: string;
  save(): Promise<boolean>;
  handleCloudSync(): Promise<void>;
  destroy(): void;
};

type StorageListener = (changes: Record<string, { newValue?: unknown }>, area: string) => void;

const GLOBAL_KEY = StorageKeys.FOLDER_DATA_AISTUDIO;
let local: Record<string, unknown>;
let sync: Record<string, unknown>;
const managers: Manager[] = [];

function pick(values: Record<string, unknown>, keys: unknown): Record<string, unknown> {
  if (typeof keys === 'string') return structuredClone({ [keys]: values[keys] });
  if (Array.isArray(keys)) {
    return structuredClone(Object.fromEntries(keys.map((key) => [key, values[key]])));
  }
  if (keys && typeof keys === 'object') {
    return structuredClone(
      Object.fromEntries(
        Object.entries(keys).map(([key, fallback]) => [key, values[key] ?? fallback]),
      ),
    );
  }
  return structuredClone(values);
}

function folderData(name: string): FolderData {
  return {
    folders: [{ id: name, name, parentId: null, isExpanded: true, createdAt: 1, updatedAt: 1 }],
    folderContents: { [name]: [] },
  };
}

function emitStorageChange(values: Record<string, unknown>, area: string): void {
  const changes = Object.fromEntries(
    Object.entries(values).map(([key, newValue]) => [key, { newValue }]),
  );
  for (const [listener] of mockBrowser.storage.onChanged.addListener.mock.calls) {
    (listener as StorageListener)(changes, area);
  }
}

/** chrome.storage hands listeners a fresh copy whose object keys come back sorted. */
function sortedClone(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortedClone);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(
    Object.keys(value)
      .sort()
      .map((key) => [key, sortedClone((value as Record<string, unknown>)[key])]),
  );
}

/** Another tab, the popup or cloud sync writes local storage. */
function writeFromElsewhere(values: Record<string, unknown>): void {
  Object.assign(local, structuredClone(values));
  emitStorageChange(values, 'local');
}

function bucketReads(key: string): number {
  return mockBrowser.storage.local.get.mock.calls.filter(([keys]) => keys === key).length;
}

function panelText(): string {
  return document.querySelector('.gv-folder-list')?.textContent ?? '';
}

async function scopedKey(account: string): Promise<string> {
  const scope = await accountIsolationService.resolveAccountScope({
    pageUrl: window.location.href,
    email: `${account}@example.com`,
  });
  return buildScopedStorageKey(GLOBAL_KEY, scope.accountKey);
}

async function mount(): Promise<Manager> {
  const instance = new AIStudioFolderManager();
  const manager = instance as unknown as Manager;
  managers.push(manager);
  await instance.init();
  return manager;
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.clearAllMocks();
  localStorage.clear();
  document.body.innerHTML = `
    <span class="account-switcher-text" data-email="a@example.com">a@example.com</span>
    <div class="nav-content v3-left-nav"><nav><div class="empty-space"></div></nav></div>`;
  (
    globalThis as unknown as { jsdom: { reconfigure(options: { url: string }): void } }
  ).jsdom.reconfigure({ url: 'https://aistudio.google.com/' });
  local = {};
  sync = {
    [StorageKeys.LANGUAGE]: 'en',
    [StorageKeys.GV_ACCOUNT_ISOLATION_ENABLED]: false,
    geminiFolderEnabled: true,
  };
  mockBrowser.storage.local.get.mockImplementation(async (keys: unknown) => pick(local, keys));
  // Like chrome.storage: a write that changes a value echoes back to this context's
  // listeners in a later task; an unchanged value or a rejected write emits nothing.
  mockBrowser.storage.local.set.mockImplementation(async (values: Record<string, unknown>) => {
    const changed = Object.fromEntries(
      Object.entries(values)
        .filter(([key, value]) => JSON.stringify(local[key]) !== JSON.stringify(value))
        .map(([key, value]) => [key, sortedClone(value)]),
    );
    Object.assign(local, structuredClone(values));
    if (Object.keys(changed).length > 0) setTimeout(() => emitStorageChange(changed, 'local'), 0);
  });
  mockBrowser.storage.sync.get.mockImplementation(async (keys: unknown) => pick(sync, keys));
  mockBrowser.storage.sync.set.mockImplementation(async (values: Record<string, unknown>) => {
    Object.assign(sync, structuredClone(values));
  });
  chrome.storage.local.get = mockBrowser.storage.local.get as typeof chrome.storage.local.get;
  chrome.storage.local.set = mockBrowser.storage.local.set as typeof chrome.storage.local.set;
  chrome.storage.sync.get = mockBrowser.storage.sync.get as typeof chrome.storage.sync.get;
  chrome.storage.sync.set = mockBrowser.storage.sync.set as typeof chrome.storage.sync.set;
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  for (const manager of managers.splice(0)) manager.destroy();
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.restoreAllMocks();
  document.body.innerHTML = '';
  document.documentElement.className = '';
});

describe('AI Studio folder sync across contexts', () => {
  it('reloads and repaints when another tab writes the active bucket', async () => {
    local[GLOBAL_KEY] = folderData('Mine');
    const manager = await mount();
    expect(panelText()).toContain('Mine');

    writeFromElsewhere({ [GLOBAL_KEY]: folderData('From another tab') });
    await vi.advanceTimersByTimeAsync(0);

    expect(manager.data).toEqual(folderData('From another tab'));
    expect(panelText()).toContain('From another tab');
    expect(panelText()).not.toContain('Mine');
  });

  it('does not reload for its own writes, including a merged cloud draft', async () => {
    local[GLOBAL_KEY] = folderData('Mine');
    local.gvPromptItems = [];
    const manager = await mount();
    const readsAfterMount = bucketReads(GLOBAL_KEY);

    manager.data.folders[0].name = 'Edited here';
    await expect(manager.save()).resolves.toBe(true);
    await vi.advanceTimersByTimeAsync(0);

    const prompt: PromptItem = { id: 'p', text: 'Prompt', tags: [], createdAt: 1, updatedAt: 1 };
    mockBrowser.runtime.sendMessage.mockResolvedValue({
      ok: true,
      data: { folders: { data: folderData('Cloud') }, prompts: { items: [prompt] } },
    });
    await manager.handleCloudSync();
    await vi.advanceTimersByTimeAsync(0);

    expect(bucketReads(GLOBAL_KEY)).toBe(readsAfterMount);
    expect(local.gvPromptItems).toEqual([prompt]);
    expect(manager.data.folders.map((folder) => folder.name)).toEqual(['Edited here', 'Cloud']);
  });

  it('reloads another tab write that follows an unchanged save', async () => {
    local[GLOBAL_KEY] = folderData('Mine');
    const manager = await mount();

    await expect(manager.save()).resolves.toBe(true);
    writeFromElsewhere({ [GLOBAL_KEY]: folderData('From another tab') });
    await vi.advanceTimersByTimeAsync(0);

    expect(manager.data).toEqual(folderData('From another tab'));
  });

  it('reloads another tab write that follows a rejected save', async () => {
    local[GLOBAL_KEY] = folderData('Mine');
    const manager = await mount();
    mockBrowser.storage.local.set.mockRejectedValueOnce(new Error('QUOTA_BYTES quota exceeded'));

    manager.data.folders[0].name = 'Edited here';
    await expect(manager.save()).resolves.toBe(false);
    writeFromElsewhere({ [GLOBAL_KEY]: folderData('From another tab') });
    await vi.advanceTimersByTimeAsync(0);

    expect(manager.data).toEqual(folderData('From another tab'));
  });

  it('reloads when another tab restores the value of an earlier own write', async () => {
    local[GLOBAL_KEY] = folderData('Mine');
    const manager = await mount();
    const readsAfterMount = bucketReads(GLOBAL_KEY);

    await expect(manager.save()).resolves.toBe(true);
    writeFromElsewhere({ [GLOBAL_KEY]: folderData('From another tab') });
    await vi.advanceTimersByTimeAsync(0);
    writeFromElsewhere({ [GLOBAL_KEY]: folderData('Mine') });
    await vi.advanceTimersByTimeAsync(0);

    expect(bucketReads(GLOBAL_KEY)).toBe(readsAfterMount + 2);
    expect(manager.data).toEqual(folderData('Mine'));
  });

  it('ignores other buckets, other areas and a disabled folder feature', async () => {
    local[GLOBAL_KEY] = folderData('Mine');
    const manager = await mount();
    const readsAfterMount = bucketReads(GLOBAL_KEY);

    writeFromElsewhere({ [StorageKeys.FOLDER_DATA]: folderData('Gemini') });
    emitStorageChange({ [GLOBAL_KEY]: folderData('Sync area') }, 'sync');
    emitStorageChange({ geminiFolderEnabled: false }, 'sync');
    writeFromElsewhere({ [GLOBAL_KEY]: folderData('While disabled') });
    await vi.advanceTimersByTimeAsync(0);

    expect(bucketReads(GLOBAL_KEY)).toBe(readsAfterMount);
    expect(manager.data).toEqual(folderData('Mine'));
  });
});

describe('AI Studio account scope retry', () => {
  it('binds before the next poll and later polls keep the bound account', async () => {
    sync[StorageKeys.GV_ACCOUNT_ISOLATION_ENABLED] = true;
    const key = await scopedKey('a');
    local[key] = folderData('Private a');
    const resolve = accountIsolationService.resolveAccountScope.bind(accountIsolationService);
    vi.spyOn(accountIsolationService, 'resolveAccountScope')
      .mockRejectedValueOnce(new Error('background not listening'))
      .mockImplementation(resolve);
    const manager = await mount();
    expect(manager.activeStorageKey).toBe('');

    await vi.advanceTimersByTimeAsync(400);
    expect(manager.activeStorageKey).toBe(key);
    expect(panelText()).toContain('Private a');

    const dialog = document.createElement('div');
    dialog.className = 'gv-folder-confirm-dialog gv-aistudio-confirm';
    document.body.appendChild(dialog);
    await vi.advanceTimersByTimeAsync(3600);

    expect(dialog.isConnected).toBe(true);
    expect(manager.activeStorageKey).toBe(key);
  });
});
