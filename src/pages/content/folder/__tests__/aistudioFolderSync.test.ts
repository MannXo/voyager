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
  createFolder(parentId?: string | null): void;
  renameFolder(folderId: string): void;
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

  it('applies another tab write that lands while its own write is pending', async () => {
    local[GLOBAL_KEY] = folderData('Mine');
    const manager = await mount();
    const write = Promise.withResolvers<void>();
    const commit = mockBrowser.storage.local.set.getMockImplementation()!;
    mockBrowser.storage.local.set.mockImplementationOnce(
      async (values: Record<string, unknown>) => {
        await commit(values); // committed and echoed; the storage promise is still pending
        return write.promise;
      },
    );

    manager.data.folders[0].name = 'Edited here';
    const saving = manager.save();
    await vi.advanceTimersByTimeAsync(0);
    writeFromElsewhere({ [GLOBAL_KEY]: folderData('From another tab') });
    write.resolve();
    await expect(saving).resolves.toBe(true);
    await vi.advanceTimersByTimeAsync(0);
    expect(manager.data).toEqual(folderData('From another tab'));

    manager.data.folders[0].isExpanded = false;
    await expect(manager.save()).resolves.toBe(true);
    expect(local[GLOBAL_KEY]).toEqual({
      ...folderData('From another tab'),
      folders: [{ ...folderData('From another tab').folders[0], isExpanded: false }],
    });
  });

  it('does not reload for an unchanged save that the browser still reports', async () => {
    local[GLOBAL_KEY] = folderData('Mine');
    const manager = await mount();
    // Like Firefox: every write is reported, even one that leaves the value unchanged.
    mockBrowser.storage.local.set.mockImplementation(async (values: Record<string, unknown>) => {
      Object.assign(local, structuredClone(values));
      setTimeout(() => emitStorageChange(sortedClone(values) as Record<string, unknown>, 'local'));
    });
    const readsAfterMount = bucketReads(GLOBAL_KEY);

    manager.data.folders[0].name = 'Edited here';
    await expect(manager.save()).resolves.toBe(true);
    await vi.advanceTimersByTimeAsync(0);
    await expect(manager.save()).resolves.toBe(true);
    await vi.advanceTimersByTimeAsync(0);

    expect(bucketReads(GLOBAL_KEY)).toBe(readsAfterMount);
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

describe('AI Studio inline folder drafts across reloads', () => {
  function twoFolders(first: string, second: string): FolderData {
    return {
      folders: [...folderData(first).folders, ...folderData(second).folders],
      folderContents: { [first]: [], [second]: [] },
    };
  }

  function press(input: HTMLInputElement, key: string): void {
    input.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true }));
  }

  it('keeps an unfinished new-folder name and creates it on top of the reloaded data', async () => {
    local[GLOBAL_KEY] = folderData('Mine');
    const manager = await mount();
    manager.createFolder();
    const input = document.querySelector<HTMLInputElement>('.gv-folder-inline-input input')!;
    input.value = 'Draft';

    writeFromElsewhere({ [GLOBAL_KEY]: folderData('From another tab') });
    await vi.advanceTimersByTimeAsync(0);
    expect(panelText()).toContain('From another tab');
    expect(document.querySelector('.gv-folder-inline-input input')).toBe(input);
    expect(input.value).toBe('Draft');
    expect(document.activeElement).toBe(input);

    press(input, 'Enter');
    await vi.advanceTimersByTimeAsync(0);
    expect((local[GLOBAL_KEY] as FolderData).folders.map((folder) => folder.name)).toEqual([
      'From another tab',
      'Draft',
    ]);
    expect(document.querySelector('.gv-folder-inline-input')).toBeNull();
  });

  it('keeps an unfinished rename and applies it to the reloaded folder', async () => {
    local[GLOBAL_KEY] = folderData('Mine');
    const manager = await mount();
    manager.renameFolder('Mine');
    const input = document.querySelector<HTMLInputElement>('.gv-folder-rename-inline input')!;
    input.value = 'Renamed';
    input.setSelectionRange(2, 4);

    writeFromElsewhere({ [GLOBAL_KEY]: twoFolders('Mine', 'From another tab') });
    await vi.advanceTimersByTimeAsync(0);
    const header = document.querySelector('[data-folder-id="Mine"] .gv-folder-item-header');
    expect(header?.contains(input)).toBe(true);
    expect(header?.classList.contains('gv-folder-editing')).toBe(true);
    expect(input.value).toBe('Renamed');
    expect(document.activeElement).toBe(input);
    expect([input.selectionStart, input.selectionEnd]).toEqual([2, 4]);

    press(input, 'Enter');
    await vi.advanceTimersByTimeAsync(0);
    expect((local[GLOBAL_KEY] as FolderData).folders.map((folder) => folder.name)).toEqual([
      'Renamed',
      'From another tab',
    ]);
    expect(document.querySelector('.gv-folder-rename-inline')).toBeNull();
    expect(document.querySelector('.gv-folder-editing, .gv-folder-name.gv-hidden')).toBeNull();
  });

  it('drops a rename whose folder another tab deleted', async () => {
    local[GLOBAL_KEY] = folderData('Mine');
    const manager = await mount();
    manager.renameFolder('Mine');

    writeFromElsewhere({ [GLOBAL_KEY]: folderData('From another tab') });
    await vi.advanceTimersByTimeAsync(0);

    expect(document.querySelector('.gv-folder-rename-inline')).toBeNull();
    expect(panelText()).toContain('From another tab');
  });

  it('drops a new-subfolder draft whose parent another tab deleted', async () => {
    local[GLOBAL_KEY] = folderData('Mine');
    const manager = await mount();
    manager.createFolder('Mine');
    expect(
      document.querySelector('[data-folder-id="Mine"] .gv-folder-inline-input'),
    ).not.toBeNull();

    writeFromElsewhere({ [GLOBAL_KEY]: folderData('From another tab') });
    await vi.advanceTimersByTimeAsync(0);

    expect(document.querySelector('.gv-folder-inline-input')).toBeNull();
  });

  it('keeps a new-subfolder draft beside its collapsed parent, and drops it with the parent', async () => {
    const collapsed = twoFolders('Mine', 'Other');
    collapsed.folders[0].isExpanded = false;
    local[GLOBAL_KEY] = collapsed;
    const manager = await mount();
    manager.createFolder('Mine');
    const draft = document.querySelector('.gv-folder-inline-input');

    writeFromElsewhere({ [GLOBAL_KEY]: { ...collapsed, folders: [...collapsed.folders] } });
    await vi.advanceTimersByTimeAsync(0);
    expect(document.querySelector('[data-folder-id="Mine"]')?.nextElementSibling).toBe(draft);

    writeFromElsewhere({ [GLOBAL_KEY]: folderData('Other') });
    await vi.advanceTimersByTimeAsync(0);
    expect(document.querySelector('.gv-folder-inline-input')).toBeNull();
  });

  it('keeps a new-folder draft and a rename open at the same time', async () => {
    local[GLOBAL_KEY] = folderData('Mine');
    const manager = await mount();
    manager.renameFolder('Mine');
    const rename = document.querySelector<HTMLInputElement>('.gv-folder-rename-inline input')!;
    manager.createFolder();
    const create = document.querySelector<HTMLInputElement>('.gv-folder-inline-input input')!;
    create.value = 'Draft';

    writeFromElsewhere({ [GLOBAL_KEY]: twoFolders('Mine', 'From another tab') });
    await vi.advanceTimersByTimeAsync(0);

    expect(rename.isConnected).toBe(true);
    expect(create.isConnected).toBe(true);
    expect(create.value).toBe('Draft');
    expect(document.activeElement).toBe(create);
  });

  it('does not carry a new-folder draft into another account', async () => {
    sync[StorageKeys.GV_ACCOUNT_ISOLATION_ENABLED] = true;
    local[await scopedKey('a')] = folderData('Private a');
    const manager = await mount();
    manager.createFolder();

    document.querySelector('.account-switcher-text')!.textContent = 'b@example.com';
    document.querySelector('.account-switcher-text')!.setAttribute('data-email', 'b@example.com');
    await vi.advanceTimersByTimeAsync(4000);

    expect(manager.activeStorageKey).toBe(await scopedKey('b'));
    expect(document.querySelector('.gv-folder-inline-input')).toBeNull();
  });
});

describe('AI Studio library archive visibility across contexts', () => {
  function libraryRow(id: string): HTMLElement {
    const row = document.createElement('tr');
    row.className = 'mat-mdc-row';
    row.innerHTML = `<td><a class="name-btn" href="/prompts/${id}">${id}</a></td>`;
    document.body.appendChild(row);
    return row;
  }

  function filed(id: string): FolderData {
    const data = folderData('Mine');
    data.folderContents.Mine = [
      { conversationId: id, title: id, url: `/prompts/${id}`, addedAt: 1 },
    ];
    return data;
  }

  it('archives and unarchives existing rows when another tab moves prompts', async () => {
    (
      globalThis as unknown as { jsdom: { reconfigure(options: { url: string }): void } }
    ).jsdom.reconfigure({ url: 'https://aistudio.google.com/library' });
    sync[StorageKeys.FOLDER_HIDE_ARCHIVED_CONVERSATIONS_AISTUDIO] = true;
    local[GLOBAL_KEY] = filed('p1');
    const first = libraryRow('p1');
    const second = libraryRow('p2');
    await mount();
    expect(first.classList.contains('gv-conversation-archived')).toBe(true);
    expect(second.classList.contains('gv-conversation-archived')).toBe(false);

    writeFromElsewhere({ [GLOBAL_KEY]: filed('p2') });
    await vi.advanceTimersByTimeAsync(0);

    expect(first.classList.contains('gv-conversation-archived')).toBe(false);
    expect(second.classList.contains('gv-conversation-archived')).toBe(true);
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
