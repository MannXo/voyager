/**
 * Characterization of AI Studio folder persistence before it moves onto the
 * shared FolderRepository. It pins, through the manager's persistence surface,
 * DOM and storage, what reaches chrome.storage, the recovery slots and the
 * screen: AI Studio never normalizes or prunes, keeps `__uncategorized__`,
 * copies the legacy bucket raw and recovers a missing key from backups.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  type AccountScope,
  accountIsolationService,
  buildScopedStorageKey,
} from '@/core/services/AccountIsolationService';
import { DataBackupService } from '@/core/services/DataBackupService';
import { StorageKeys } from '@/core/types/common';
import { validateFolderData } from '@/features/folder/model/folderData';

import { AIStudioFolderManager } from '../aistudio';
import type { ConversationReference, FolderData } from '../types';

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
  accountScope: AccountScope | null;
  activeStorageKey: string;
  handleAccountIsolationToggle(enabled: boolean): Promise<void>;
  refreshScopedDataOnAccountContextChange(): Promise<void>;
  load(): Promise<void>;
  save(): Promise<boolean>;
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

function prompt(id: string, extra: Partial<ConversationReference> & Record<string, unknown> = {}) {
  return {
    conversationId: id,
    title: `Prompt ${id}`,
    url: `https://aistudio.google.com/prompts/${id}`,
    addedAt: 100,
    ...extra,
  };
}

/** Real-shaped AI Studio data: no sortIndex anywhere, createdAt order differs from name order. */
function fixture(): FolderData & { version: number } {
  return structuredClone({
    folders: [
      {
        id: 'f-late',
        name: 'Alpha late',
        parentId: null,
        isExpanded: true,
        createdAt: 30,
        updatedAt: 30,
      },
      {
        id: 'f-early',
        name: 'Zulu early',
        parentId: null,
        isExpanded: true,
        createdAt: 10,
        updatedAt: 10,
      },
      {
        id: 'f-child',
        name: 'Child',
        parentId: 'f-early',
        isExpanded: true,
        createdAt: 20,
        updatedAt: 20,
      },
      // No folderContents entry at all.
      {
        id: 'f-nokey',
        name: 'Middle no key',
        parentId: null,
        isExpanded: true,
        createdAt: 40,
        updatedAt: 40,
      },
    ],
    folderContents: {
      'f-late': [prompt('p1'), prompt('p2', { addedAt: 300 }), prompt('p1')],
      'f-early': [],
      'f-child': [prompt('p3', { starred: true, importedExtra: 'kept' })],
      __uncategorized__: [prompt('p4'), prompt('p5', { url: '/prompts/p5' })],
      'ghost-folder': [prompt('p6')],
    },
    version: 2,
  });
}

/** What the old save path writes: cloneFolderData drops the extra top-level key only. */
function expectedWrite(source: FolderData = fixture()): FolderData {
  return { folders: source.folders, folderContents: source.folderContents };
}

function bytes(value: unknown): string {
  return JSON.stringify(value);
}

function folderData(name: string): FolderData {
  return {
    folders: [{ id: name, name, parentId: null, isExpanded: true, createdAt: 1, updatedAt: 1 }],
    folderContents: { [name]: [] },
  };
}

async function scopedKey(account: string): Promise<string> {
  const scope = await accountIsolationService.resolveAccountScope({
    pageUrl: window.location.href,
    email: `${account}@example.com`,
  });
  return buildScopedStorageKey(GLOBAL_KEY, scope.accountKey);
}

async function scopedBackupNamespace(account: string): Promise<string> {
  const scope = await accountIsolationService.resolveAccountScope({
    pageUrl: window.location.href,
    email: `${account}@example.com`,
  });
  return buildScopedStorageKey('aistudio-folders', scope.accountKey);
}

function selectAccount(account: string): void {
  const indicator = document.querySelector('.account-switcher-text')!;
  indicator.setAttribute('data-email', `${account}@example.com`);
  indicator.textContent = `${account}@example.com`;
}

function useIsolation(enabled: boolean): void {
  sync[StorageKeys.GV_ACCOUNT_ISOLATION_ENABLED] = enabled;
}

async function mount(): Promise<Manager> {
  const instance = new AIStudioFolderManager();
  const manager = instance as unknown as Manager;
  managers.push(manager);
  await instance.init();
  return manager;
}

function emitStorageChange(changes: Record<string, { newValue?: unknown }>, area: string): void {
  for (const [listener] of mockBrowser.storage.onChanged.addListener.mock.calls) {
    (listener as StorageListener)(changes, area);
  }
}

function folderWrites(key: string): unknown[] {
  return mockBrowser.storage.local.set.mock.calls
    .map(([values]) => (values as Record<string, unknown>)[key])
    .filter((value) => value !== undefined);
}

function rootFolderOrder(): string[] {
  return Array.from(
    document.querySelectorAll<HTMLElement>('.gv-folder-list > .gv-folder-item'),
    (item) => item.dataset.folderId ?? '',
  );
}

function notificationText(): string {
  return Array.from(document.querySelectorAll('.gv-notification'), (node) => node.textContent).join(
    '\n',
  );
}

function backupSlot(namespace: string, slot: 'primary' | 'emergency'): FolderData | null {
  const raw = localStorage.getItem(`gvBackup_${namespace}_${slot}`);
  return raw ? (JSON.parse(raw).data as FolderData) : null;
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
  mockBrowser.storage.local.set.mockImplementation(async (values: Record<string, unknown>) => {
    Object.assign(local, structuredClone(values));
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

describe('AI Studio persistence characterization', () => {
  describe('global bucket', () => {
    it('loads stored data raw, without normalizing, pruning or writing back', async () => {
      local[GLOBAL_KEY] = fixture();
      const manager = await mount();

      expect(manager.activeStorageKey).toBe(GLOBAL_KEY);
      expect(bytes(manager.data)).toBe(bytes(fixture()));
      expect(folderWrites(GLOBAL_KEY)).toEqual([]);
      // Root folders render by createdAt, not by name or sortIndex.
      expect(rootFolderOrder()).toEqual(['f-early', 'f-late', 'f-nokey']);
      // The duplicate reference stays visible; root conversations live in __uncategorized__.
      expect(
        document.querySelectorAll(
          '.gv-folder-item[data-folder-id="f-late"] .gv-folder-conversation',
        ),
      ).toHaveLength(3);
      expect(
        Array.from(
          document.querySelectorAll<HTMLElement>(
            '.gv-folder-uncategorized .gv-folder-conversation',
          ),
          (row) => row.dataset.conversationId,
        ),
      ).toEqual(['p4', 'p5']);
      expect(bytes(backupSlot('aistudio-folders', 'primary'))).toBe(bytes(fixture()));
      // Folder data never lands in page localStorage.
      expect(localStorage.getItem(GLOBAL_KEY)).toBeNull();
    });

    it('saves exactly the loaded content, keeping orphan, root and duplicate buckets', async () => {
      local[GLOBAL_KEY] = fixture();
      const manager = await mount();

      await expect(manager.save()).resolves.toBe(true);

      expect(folderWrites(GLOBAL_KEY).map(bytes)).toEqual([bytes(expectedWrite())]);
      expect(bytes(local[GLOBAL_KEY])).toBe(bytes(expectedWrite()));
      expect(bytes(backupSlot('aistudio-folders', 'primary'))).toBe(bytes(expectedWrite()));
      expect(bytes(backupSlot('aistudio-folders', 'emergency'))).toBe(bytes(expectedWrite()));
      expect(localStorage.getItem(GLOBAL_KEY)).toBeNull();
    });

    it('reports a failed write once without retrying it', async () => {
      local[GLOBAL_KEY] = fixture();
      const manager = await mount();
      const writesBefore = mockBrowser.storage.local.set.mock.calls.length;
      mockBrowser.storage.local.set.mockRejectedValueOnce(new Error('quota'));

      await expect(manager.save()).resolves.toBe(false);

      expect(mockBrowser.storage.local.set.mock.calls.length - writesBefore).toBe(1);
      expect(notificationText()).toContain('Failed to save folder data');
      expect(bytes(local[GLOBAL_KEY])).toBe(bytes(fixture()));
    });
  });

  describe('sync to local migration', () => {
    it('copies sync data into an empty local bucket as is', async () => {
      sync[GLOBAL_KEY] = fixture();
      const manager = await mount();

      expect(bytes(folderWrites(GLOBAL_KEY)[0])).toBe(bytes(fixture()));
      expect(bytes(manager.data)).toBe(bytes(fixture()));
    });

    it('merges sync into existing local data, local first', async () => {
      local[GLOBAL_KEY] = {
        folders: [folderData('Local').folders[0]],
        folderContents: { Local: [prompt('l1')], shared: [prompt('s1')] },
      };
      sync[GLOBAL_KEY] = {
        folders: [folderData('Local').folders[0], folderData('Synced').folders[0]],
        folderContents: { Synced: [prompt('y1')], shared: [prompt('s1'), prompt('s2')] },
      };
      await mount();

      expect(bytes(folderWrites(GLOBAL_KEY)[0])).toBe(
        bytes({
          folders: [folderData('Local').folders[0], folderData('Synced').folders[0]],
          folderContents: {
            Local: [prompt('l1')],
            shared: [prompt('s1'), prompt('s2')],
            Synced: [prompt('y1')],
          },
        }),
      );
    });
  });

  describe('recovery', () => {
    function seedPrimaryBackup(namespace: string, data: FolderData): void {
      new DataBackupService<FolderData>(namespace, validateFolderData).createPrimaryBackup(data);
    }

    it('restores a missing bucket from its backup and writes it back', async () => {
      seedPrimaryBackup('aistudio-folders', expectedWrite());
      const manager = await mount();

      expect(bytes(manager.data)).toBe(bytes(expectedWrite()));
      expect(notificationText()).toContain('Folder data recovered from backup');
      expect(folderWrites(GLOBAL_KEY).map(bytes)).toEqual([bytes(expectedWrite())]);
    });

    it('starts empty and says so when storage is corrupt and no backup exists', async () => {
      local[GLOBAL_KEY] = { folders: 'corrupt', folderContents: {} };
      const manager = await mount();

      expect(manager.data).toEqual({ folders: [], folderContents: {} });
      expect(notificationText()).toContain('All folders have been reset');
      expect(folderWrites(GLOBAL_KEY)).toEqual([]);
      expect(document.querySelector<HTMLButtonElement>('.gv-folder-add-btn')?.disabled).toBe(false);
    });

    it('keeps in-memory folders when a reload fails and no backup is left', async () => {
      local[GLOBAL_KEY] = fixture();
      const manager = await mount();
      localStorage.clear();
      mockBrowser.storage.local.get.mockRejectedValueOnce(new Error('storage unavailable'));

      await manager.load();

      expect(bytes(manager.data)).toBe(bytes(fixture()));
      expect(notificationText()).toContain('using cached version');
      expect(folderWrites(GLOBAL_KEY)).toEqual([]);
    });
  });

  describe('account scope', () => {
    it('copies the whole legacy bucket into a new account bucket and leaves it in place', async () => {
      useIsolation(true);
      local[GLOBAL_KEY] = fixture();
      const manager = await mount();
      const key = await scopedKey('a');

      expect(manager.activeStorageKey).toBe(key);
      expect(folderWrites(key).map(bytes)).toEqual([bytes(expectedWrite())]);
      expect(bytes(local[GLOBAL_KEY])).toBe(bytes(fixture()));
      expect(bytes(manager.data)).toBe(bytes(expectedWrite()));
      expect(bytes(backupSlot(await scopedBackupNamespace('a'), 'primary'))).toBe(
        bytes(expectedWrite()),
      );
      expect(backupSlot('aistudio-folders', 'primary')).toBeNull();
    });

    it('rebinds only when the account fingerprint changes', async () => {
      useIsolation(true);
      local[await scopedKey('a')] = folderData('Private a');
      local[await scopedKey('b')] = folderData('Private b');
      const manager = await mount();
      const dialog = document.createElement('div');
      dialog.className = 'gv-folder-confirm-dialog gv-aistudio-confirm';
      document.body.appendChild(dialog);

      await vi.advanceTimersByTimeAsync(2500);
      expect(dialog.isConnected).toBe(true);
      expect(document.querySelector('.gv-folder-list')?.textContent).toContain('Private a');

      selectAccount('b');
      await vi.advanceTimersByTimeAsync(1200);
      expect(dialog.isConnected).toBe(false);
      expect(manager.activeStorageKey).toBe(await scopedKey('b'));
      expect(document.querySelector('.gv-folder-list')?.textContent).toContain('Private b');
    });

    it('binds through the next poll after a failed scope resolution', async () => {
      useIsolation(true);
      local[await scopedKey('a')] = folderData('Private a');
      const resolve = accountIsolationService.resolveAccountScope.bind(accountIsolationService);
      vi.spyOn(accountIsolationService, 'resolveAccountScope')
        .mockRejectedValueOnce(new Error('background not listening'))
        .mockImplementation(resolve);
      const manager = await mount();

      expect(manager.data).toEqual({ folders: [], folderContents: {} });
      expect(folderWrites(await scopedKey('a'))).toEqual([]);

      await vi.advanceTimersByTimeAsync(1200);
      expect(manager.activeStorageKey).toBe(await scopedKey('a'));
      expect(document.querySelector('.gv-folder-list')?.textContent).toContain('Private a');
      expect(folderWrites(GLOBAL_KEY)).toEqual([]);
    });
  });

  describe('feature toggle', () => {
    it('can edit and save again after the folder feature is disabled and re-enabled', async () => {
      local[GLOBAL_KEY] = folderData('Kept');
      await mount();

      emitStorageChange({ geminiFolderEnabled: { newValue: false } }, 'sync');
      await vi.advanceTimersByTimeAsync(0);
      expect(document.querySelector('.gv-folder-list')).toBeNull();

      emitStorageChange({ geminiFolderEnabled: { newValue: true } }, 'sync');
      await vi.advanceTimersByTimeAsync(0);
      expect(document.querySelector('.gv-folder-list')?.textContent).toContain('Kept');

      document.querySelector<HTMLButtonElement>('.gv-folder-add-btn')!.click();
      const input = document.querySelector<HTMLInputElement>('.gv-folder-name-input')!;
      input.value = 'After re-enable';
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
      await vi.advanceTimersByTimeAsync(0);

      expect((local[GLOBAL_KEY] as FolderData).folders.map((folder) => folder.name)).toContain(
        'After re-enable',
      );
      expect(localStorage.getItem(GLOBAL_KEY)).toBeNull();
    });
  });
});
