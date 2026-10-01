import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { StorageKeys } from '@/core/types/common';
import { ROOT_CONVERSATIONS_ID } from '@/features/folder/constants';
import type { FolderData } from '@/pages/content/folder/types';

import { ChatGptFolderStore } from '../ChatGptFolderStore';
import { CHATGPT_FOLDER_CONFIG } from '../config';
import { type MemoryStorage, createMemoryStorage, settle } from './memoryStorage';

vi.mock('webextension-polyfill', () => ({
  default: {
    get storage() {
      return globalThis.chrome.storage;
    },
    runtime: { id: 'test-extension-id' },
  },
}));

const GEMINI_DATA: FolderData = {
  folders: [
    { id: 'g1', name: 'Gemini', parentId: null, isExpanded: true, createdAt: 1, updatedAt: 1 },
  ],
  folderContents: { g1: [], [ROOT_CONVERSATIONS_ID]: [] },
};

function conversation(id: string, title = id) {
  return {
    conversationId: `chatgpt:conv:${id}`,
    title,
    url: `https://chatgpt.com/c/${id}`,
    addedAt: 1,
  };
}

let memory: MemoryStorage;
let originalStorage: typeof chrome.storage;
let store: ChatGptFolderStore | null = null;

beforeEach(() => {
  memory = createMemoryStorage();
  originalStorage = globalThis.chrome.storage;
  globalThis.chrome.storage = memory.api;
  localStorage.clear();
  // Everything that could pull ChatGPT into Gemini's buckets is switched on.
  memory.values.local.set(StorageKeys.FOLDER_DATA, structuredClone(GEMINI_DATA));
  memory.values.local.set(StorageKeys.FOLDER_DATA_AISTUDIO, structuredClone(GEMINI_DATA));
  memory.values.sync.set(StorageKeys.GV_ACCOUNT_ISOLATION_ENABLED, true);
  memory.values.sync.set(StorageKeys.GV_ACCOUNT_ISOLATION_ENABLED_GEMINI, true);
});

afterEach(() => {
  store?.destroy();
  store = null;
  globalThis.chrome.storage = originalStorage;
  vi.restoreAllMocks();
});

async function ready(): Promise<ChatGptFolderStore> {
  store = new ChatGptFolderStore();
  await store.init();
  await settle();
  return store;
}

describe('ChatGptFolderStore', () => {
  it('writes only the ChatGPT bucket, whatever Gemini and the legacy switch hold', async () => {
    const migrate = vi.spyOn(CHATGPT_FOLDER_CONFIG, 'migrateLegacyData');
    const pageWrites = vi.spyOn(localStorage, 'setItem');
    const s = await ready();

    s.createFolder('Work', null);
    const folderId = s.data.folders[0].id;
    s.addConversation(folderId, conversation('a'));
    s.addConversation(ROOT_CONVERSATIONS_ID, conversation('b'));
    s.renameFolder(folderId, 'Projects');
    s.toggleStar(folderId, 'chatgpt:conv:a');
    s.setFolderColor(folderId, 'blue');
    s.toggleFolderPinned(folderId);
    s.toggleFolderExpanded(folderId);
    s.moveConversation('chatgpt:conv:b', ROOT_CONVERSATIONS_ID, folderId);
    s.removeConversation(folderId, 'chatgpt:conv:a');
    await settle();
    await s.replaceData({ folders: [], folderContents: {} });
    await settle();

    expect(migrate).not.toHaveBeenCalled();
    expect(new Set(memory.writes.map((w) => `${w.area}:${w.key}`))).toEqual(
      new Set([`local:${StorageKeys.FOLDER_DATA_CHATGPT}`]),
    );
    expect(memory.values.local.get(StorageKeys.FOLDER_DATA)).toEqual(GEMINI_DATA);
    expect(memory.values.local.get(StorageKeys.FOLDER_DATA_AISTUDIO)).toEqual(GEMINI_DATA);
    // The repository's recovery slots live in this page's localStorage, under the
    // ChatGPT namespace only.
    const pageKeys = new Set(pageWrites.mock.calls.map(([key]) => key));
    expect(pageKeys.size).toBeGreaterThan(0);
    for (const key of pageKeys) expect(key).toMatch(/^gvBackup_chatgpt-folders_/);
  });

  it('files edits in the stored bucket', async () => {
    const s = await ready();
    s.createFolder('Work', null);
    const folderId = s.data.folders[0].id;
    expect(s.addConversation(folderId, conversation('a', 'Trip plan'))).toBe(true);
    expect(s.addConversation(folderId, conversation('a', 'Again'))).toBe(false);
    await settle();

    const stored = memory.values.local.get(StorageKeys.FOLDER_DATA_CHATGPT) as FolderData;
    expect(stored.folders.map((f) => f.name)).toEqual(['Work']);
    expect(stored.folderContents[folderId].map((c) => c.title)).toEqual(['Trip plan']);
  });

  it('reloads a write from another tab', async () => {
    const s = await ready();
    const seen = vi.fn();
    s.subscribe(seen);
    memory.external('local', StorageKeys.FOLDER_DATA_CHATGPT, {
      folders: [
        {
          id: 'f',
          name: 'Other tab',
          parentId: null,
          isExpanded: true,
          createdAt: 1,
          updatedAt: 1,
        },
      ],
      folderContents: { f: [] },
    });
    await settle(30);

    expect(s.data.folders.map((f) => f.name)).toEqual(['Other tab']);
    expect(seen).toHaveBeenCalled();
  });

  it('ignores edits until its bucket has loaded', () => {
    store = new ChatGptFolderStore();
    store.createFolder('Too early', null);
    expect(store.data.folders).toEqual([]);
    expect(memory.writes).toEqual([]);
  });

  it('stops listening for storage changes on destroy', async () => {
    const before = memory.listeners.size;
    const s = await ready();
    expect(memory.listeners.size).toBe(before + 1);
    s.destroy();
    store = null;
    expect(memory.listeners.size).toBe(before);
  });
});
