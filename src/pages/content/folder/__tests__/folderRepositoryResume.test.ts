import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { FolderData } from '@/core/types/folder';
import {
  type MemoryStorage,
  createMemoryStorage,
  settle,
} from '@/features/plugins/builtin/chatgptFolders/__tests__/memoryStorage';
import { CHATGPT_FOLDER_CONFIG } from '@/features/plugins/builtin/chatgptFolders/config';

import { FolderRepository } from '../FolderRepository';
import {
  AISTUDIO_FOLDER_CONFIG,
  GEMINI_FOLDER_CONFIG,
  type PlatformFolderConfig,
} from '../platformFolderConfig';
import { AIStudioFolderStorageAdapter } from '../storage/AIStudioFolderStorageAdapter';
import { LocalStorageFolderAdapter } from '../storage/FolderStorageAdapter';

vi.mock('webextension-polyfill', () => ({
  default: {
    get storage() {
      return chrome.storage;
    },
  },
}));

function data(name: string): FolderData {
  return {
    folders: [
      {
        id: 'folder',
        name,
        parentId: null,
        isExpanded: true,
        sortIndex: 0,
        createdAt: 1,
        updatedAt: 1,
      },
    ],
    folderContents: { folder: [] },
  };
}

let memory: MemoryStorage;
let originalStorage: typeof chrome.storage;
let repository: FolderRepository;
let enabled: boolean;

beforeEach(() => {
  vi.useFakeTimers();
  memory = createMemoryStorage();
  originalStorage = chrome.storage;
  chrome.storage = memory.api;
  localStorage.clear();
  enabled = true;
});

afterEach(async () => {
  repository?.destroy();
  await settle(30);
  chrome.storage = originalStorage;
  localStorage.clear();
  localStorage.clear();
  vi.restoreAllMocks();
  vi.clearAllTimers();
  vi.useRealTimers();
});

async function ready(config: PlatformFolderConfig) {
  memory.values.local.set(config.storageKey, data('Initial'));
  repository = new FolderRepository(
    config,
    config.platform === 'gemini'
      ? new LocalStorageFolderAdapter()
      : new AIStudioFolderStorageAdapter(),
    {
      onChange: () => {},
      onRecovery: () => {},
      onExternalChange: () => {
        if (enabled) void repository.loadData();
      },
      onAccountReleased: () => {},
      isEnabled: () => enabled,
    },
  );
  await repository.init();
  await settle(30);
  expect(repository.canEdit).toBe(true);
}

async function resume() {
  enabled = true;
  await repository.refreshAccountScope();
  await repository.loadData();
  await settle(30);
}

describe.each([
  { site: 'Gemini', config: GEMINI_FOLDER_CONFIG },
  { site: 'AI Studio', config: AISTUDIO_FOLDER_CONFIG },
  { site: 'ChatGPT', config: CHATGPT_FOLDER_CONFIG },
])('$site repository resumption', ({ config }) => {
  it('drains accepted active and trailing saves before refreshing the resumed memory', async () => {
    await ready(config);
    const set = memory.api.local.set.bind(memory.api.local);
    const releaseWrites: Array<() => void> = [];
    vi.spyOn(memory.api.local, 'set').mockImplementation(async (items) => {
      if (config.storageKey in items) {
        await new Promise<void>((resolve) => releaseWrites.push(resolve));
      }
      await set(items);
    });

    repository.data = data('Active edit');
    const active = repository.saveData();
    repository.data = data('Trailing edit');
    const trailing = repository.saveData();
    enabled = false;
    repository.suspend();
    expect(repository.canEdit).toBe(false);
    await resume();
    expect(repository.canEdit).toBe(false);
    expect(repository.data).toEqual(data('Trailing edit'));
    expect(memory.values.local.get(config.storageKey)).toEqual(data('Initial'));

    releaseWrites.shift()!();
    await expect(active).resolves.toBe(true);
    await settle(30);
    expect(repository.canEdit).toBe(false);
    expect(repository.data).toEqual(data('Trailing edit'));
    expect(memory.values.local.get(config.storageKey)).toEqual(data('Active edit'));

    releaseWrites.shift()!();
    await expect(trailing).resolves.toBe(true);
    await settle(60);
    expect(repository.canEdit).toBe(true);
    expect(repository.data).toEqual(data('Trailing edit'));
    expect(memory.values.local.get(config.storageKey)).toEqual(data('Trailing edit'));
  });

  it('persists an accepted debounce when suspension outlasts its timer', async () => {
    await ready(config);
    repository.data.folders[0].isExpanded = false;
    repository.scheduleSaveData();
    enabled = false;
    repository.suspend();
    await settle(30);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(repository.canEdit).toBe(false);
    expect((memory.values.local.get(config.storageKey) as FolderData).folders[0].isExpanded).toBe(
      false,
    );

    await resume();
    expect(repository.canEdit).toBe(true);
    expect(repository.data.folders[0].isExpanded).toBe(false);
    expect(memory.values.local.get(config.storageKey)).toEqual(repository.data);
  });

  it.each([
    { scenario: 'unchanged storage', replacedElsewhere: false, legacyMetadata: false },
    { scenario: 'new external storage', replacedElsewhere: true, legacyMetadata: false },
    {
      scenario: 'unchanged storage with legacy metadata',
      replacedElsewhere: false,
      legacyMetadata: true,
    },
  ])(
    'keeps failed trailing edits after resumption unless $scenario contains a replacement',
    async ({ replacedElsewhere, legacyMetadata }) => {
      await ready(config);
      if (legacyMetadata) {
        memory.values.local.set(config.storageKey, { ...data('Initial'), version: 2 });
        await repository.loadData();
      }
      const set = memory.api.local.set.bind(memory.api.local);
      let release!: () => void;
      const writeFailure = new Promise<void>((resolve) => {
        release = resolve;
      });
      vi.spyOn(memory.api.local, 'set').mockImplementation(async (items) => {
        if (config.storageKey in items) {
          await writeFailure;
          throw new Error('Accepted write failed after resumption');
        }
        await set(items);
      });

      repository.data = data('Active edit');
      const active = repository.saveData();
      repository.data = data('Unsaved trailing edit');
      const trailing = repository.saveData();
      enabled = false;
      repository.suspend();
      await resume();
      expect(repository.canEdit).toBe(false);
      expect(repository.data).toEqual(data('Unsaved trailing edit'));

      if (replacedElsewhere)
        memory.external('local', config.storageKey, data('Restored elsewhere'));
      release();
      await expect(active).resolves.toBe(false);
      await expect(trailing).resolves.toBe(false);
      await settle(60);
      expect(repository.canEdit).toBe(true);
      expect(repository.data).toEqual(
        data(replacedElsewhere ? 'Restored elsewhere' : 'Unsaved trailing edit'),
      );
      expect(memory.values.local.get(config.storageKey)).toEqual(
        replacedElsewhere
          ? data('Restored elsewhere')
          : legacyMetadata
            ? { ...data('Initial'), version: 2 }
            : data('Initial'),
      );
    },
  );

  it.each(['rename', 'last-folder deletion'])(
    'recovers an unsaved %s after suspension instead of restoring an older backup',
    async (edit) => {
      await ready(config);
      const edited =
        edit === 'rename' ? data('Unsaved rename') : { folders: [], folderContents: {} };
      const set = memory.api.local.set.bind(memory.api.local);
      let failFolderWrites = true;
      vi.spyOn(memory.api.local, 'set').mockImplementation(async (items) => {
        if (config.storageKey in items && failFolderWrites) throw new Error('Folder write failed');
        await set(items);
      });
      repository.data = edited;
      await expect(repository.saveData()).resolves.toBe(false);
      expect(repository.data).toEqual(edited);
      expect(memory.values.local.get(config.storageKey)).toEqual(data('Initial'));
      enabled = false;
      repository.suspend();
      failFolderWrites = false;
      memory.external('local', config.storageKey, { corrupted: true });
      await settle(30);
      expect(repository.canEdit).toBe(false);

      await resume();
      expect(repository.canEdit).toBe(true);
      expect(repository.data).toEqual(edited);
      expect(memory.values.local.get(config.storageKey)).toEqual(edited);
    },
  );
});
