import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { accountIsolationService } from '@/core/services/AccountIsolationService';
import { isSaved } from '@/features/folder/commands/folderCommands';

import { FolderStore } from './FolderStore';
import { createFolderDialogs } from './folderDialogs';
import { createLegacyFolderCommands } from './legacyFolderCommands';
import type { IFolderStorageAdapter } from './storage/FolderStorageAdapter';
import type { FolderData } from './types';

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

const sample = (): FolderData => ({
  folders: [
    { id: 'a', name: 'A', parentId: null, isExpanded: true, createdAt: 1, updatedAt: 1 },
    { id: 'b', name: 'B', parentId: null, isExpanded: true, createdAt: 1, updatedAt: 1 },
  ],
  folderContents: {
    a: [{ conversationId: 'c_1', title: 'One', url: '/app/1', addedAt: 1 }],
    b: [],
  },
});

describe('Gemini legacy FolderCommands', () => {
  let saveResult: boolean;
  let stored: FolderData | null;
  let store: FolderStore;

  beforeEach(async () => {
    vi.spyOn(accountIsolationService, 'isIsolationEnabled').mockResolvedValue(false);
    saveResult = true;
    stored = sample();
    const adapter: IFolderStorageAdapter = {
      init: vi.fn(async () => {}),
      loadData: vi.fn(async () => structuredClone(stored)),
      saveData: vi.fn(async (_key, data) => {
        if (saveResult) stored = structuredClone(data);
        return saveResult;
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
    document.body.innerHTML = '';
    vi.restoreAllMocks();
  });

  // T6e on the legacy backend: the awaiting dialog keeps its draft until the command is saved.
  it('keeps the instructions dialog open with its draft when the save fails', async () => {
    const commands = createLegacyFolderCommands(store);
    const dialogs = createFolderDialogs();
    dialogs.openInstructions(undefined, async (instructions) =>
      isSaved(
        await commands.run({
          kind: 'setFolderInstructions',
          folderId: 'a',
          instructions: instructions ?? null,
        }),
      ),
    );
    const input = document.querySelector<HTMLTextAreaElement>('.gv-fi-textarea')!;
    const save = document.querySelector<HTMLButtonElement>('.gv-fi-btn-save')!;
    input.value = 'Draft';
    saveResult = false;

    save.click();
    await vi.waitFor(() => expect(save.disabled).toBe(false));
    expect(input.isConnected).toBe(true);
    expect(stored?.folders[0].instructions).toBeUndefined();

    saveResult = true;
    save.click();
    await vi.waitFor(() => expect(document.querySelector('.gv-fi-overlay')).toBeNull());
    expect(stored?.folders[0].instructions).toBe('Draft');
  });

  it('applies the value a set op names, so a repeated click changes nothing', async () => {
    const commands = createLegacyFolderCommands(store);

    const first = await commands.run({ kind: 'setFolderPinned', folderId: 'a', pinned: true });
    const second = await commands.run({ kind: 'setFolderPinned', folderId: 'a', pinned: true });

    expect(first).toEqual({ kind: 'unconfirmed' });
    expect(second).toEqual({ kind: 'unchanged', reason: 'noop' });
    expect(store.data.folders[0].pinned).toBe(true);
  });

  it('rejects a panel move whose conversation already left the source, writing nothing', async () => {
    const commands = createLegacyFolderCommands(store);
    store.data.folderContents.a = [];

    const outcome = await commands.run({
      kind: 'moveConversations',
      ids: ['c_1'],
      from: 'a',
      target: 'b',
      via: 'panel-menu',
    });

    expect(outcome).toMatchObject({ kind: 'rejected', reason: 'source_missing' });
    expect(store.data.folderContents.b).toEqual([]);
  });

  it('reports a read-only store as failed instead of unconfirmed', async () => {
    const readOnly = new FolderStore({
      getContext: () => ({ sidebar: null, sortMode: 'manual', enabled: true }),
      onChange: vi.fn(),
      onArchive: vi.fn(),
      onRecovery: vi.fn(),
    });
    const commands = createLegacyFolderCommands(readOnly);

    const outcome = await commands.run({ kind: 'renameFolder', folderId: 'a', name: 'X' });

    expect(outcome).toMatchObject({ kind: 'failed', reason: 'read_only' });
    expect(isSaved(outcome)).toBe(false);
    readOnly.destroy();
  });
});
