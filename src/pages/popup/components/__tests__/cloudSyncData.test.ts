import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  accountIsolationService,
  buildScopedStorageKey,
} from '@/core/services/AccountIsolationService';
import { StorageKeys } from '@/core/types/common';
import type { FolderData } from '@/core/types/folder';
import type { SyncAccountScope } from '@/core/types/sync';
import { getTimelineHierarchyStorageKey } from '@/pages/content/timeline/hierarchyStorage';

import {
  prepareCloudUpload,
  resolveCloudSyncContext,
  restoreCloudDownload,
} from '../cloudSyncData';

const pageScope: SyncAccountScope = { accountKey: 'page', accountId: 1, routeUserId: '1' };
const tabScope: SyncAccountScope = { accountKey: 'tab', accountId: 2, routeUserId: '2' };
const getTargetTab = async () =>
  ({ id: 7, url: 'https://gemini.google.com/u/1/app' }) as chrome.tabs.Tab;
const emptyFolders: FolderData = { folders: [], folderContents: {} };
const folders: FolderData = {
  folders: [
    { id: 'local', name: 'Local', parentId: null, isExpanded: true, createdAt: 1, updatedAt: 1 },
  ],
  folderContents: {},
};

describe('popup cloud sync data operations', () => {
  beforeEach(() => {
    vi.spyOn(accountIsolationService, 'isIsolationEnabled').mockResolvedValue(true);
    vi.spyOn(accountIsolationService, 'resolveAccountScope').mockResolvedValue({
      ...pageScope,
      emailHash: null,
    });
    (chrome.tabs.sendMessage as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: true,
      context: { routeUserId: '1' },
      data: emptyFolders,
    });
    (chrome.storage.local.get as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({});
    (chrome.storage.sync.get as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({});
    vi.mocked(chrome.storage.local.set).mockResolvedValue();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    vi.clearAllMocks();
  });

  it('keeps hierarchy and highlights scoped when folder isolation is off', async () => {
    vi.mocked(accountIsolationService.isIsolationEnabled).mockResolvedValue(false);
    const context = await resolveCloudSyncContext('gemini', true, getTargetTab);
    expect(context.payload).toEqual({
      platform: 'gemini',
      accountScope: null,
      timelineHierarchyAccountScope: pageScope,
      highlightAccountScope: pageScope,
      includeHighlights: true,
    });
    expect(context.folderStorageKey).toBe(StorageKeys.FOLDER_DATA);
    expect(context.timelineHierarchyStorageKey).toBe(getTimelineHierarchyStorageKey('page'));
  });

  it('uses fresh nonempty tab folders and only overrides the folder scope', async () => {
    const context = await resolveCloudSyncContext('gemini', true, getTargetTab);
    (chrome.tabs.sendMessage as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: true,
      data: folders,
      accountScope: tabScope,
    });
    (chrome.storage.local.get as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({
      [buildScopedStorageKey(StorageKeys.FOLDER_DATA, 'tab')]: emptyFolders,
    });
    const payload = await prepareCloudUpload(context, getTargetTab);
    expect(payload.folders).toEqual(folders);
    expect(payload.accountScope).toEqual(tabScope);
    expect(payload.timelineHierarchyAccountScope).toEqual(pageScope);
    expect(payload.highlightAccountScope).toEqual(pageScope);
    expect(chrome.storage.local.set).not.toHaveBeenCalled();
  });

  it('restores into the tab folder scope but the captured hierarchy scope in one write', async () => {
    const context = await resolveCloudSyncContext('gemini', false, getTargetTab);
    (chrome.tabs.sendMessage as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: true,
      data: emptyFolders,
      accountScope: tabScope,
    });
    await restoreCloudDownload(
      context,
      getTargetTab,
      { folders: { data: folders } },
      'overwrite',
      false,
    );
    expect(chrome.storage.local.set).toHaveBeenCalledExactlyOnceWith({
      [buildScopedStorageKey(StorageKeys.FOLDER_DATA, 'tab')]: folders,
      [StorageKeys.PROMPT_ITEMS]: [],
      geminiTimelineStarredMessages: { messages: {} },
      [getTimelineHierarchyStorageKey('page')]: { conversations: {} },
    });
    expect(chrome.tabs.sendMessage).toHaveBeenLastCalledWith(7, { type: 'gv.folders.reload' });
  });

  it('falls back to scoped legacy folders after the upload tab timeout', async () => {
    const context = await resolveCloudSyncContext('gemini', false, getTargetTab);
    vi.useFakeTimers();
    (chrome.tabs.sendMessage as unknown as ReturnType<typeof vi.fn>).mockImplementation(
      () => new Promise(() => {}),
    );
    (chrome.storage.local.get as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({
      [context.folderStorageKey]: JSON.stringify(folders),
      [StorageKeys.PROMPT_ITEMS]: [{ id: 'p', text: 'Prompt', tags: [], createdAt: 1 }],
    });
    const upload = prepareCloudUpload(context, getTargetTab);
    await vi.advanceTimersByTimeAsync(499);
    expect(chrome.storage.local.get).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect((await upload).folders).toEqual(folders);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('keeps AI Studio restore writes limited to its folder bucket', async () => {
    vi.mocked(accountIsolationService.isIsolationEnabled).mockResolvedValue(false);
    const context = await resolveCloudSyncContext('aistudio', true, getTargetTab);
    await restoreCloudDownload(
      context,
      getTargetTab,
      {
        folders: { data: folders },
        prompts: { items: [{ id: 'p', text: 'Prompt', tags: [], createdAt: 1 }] },
      },
      'overwrite',
      false,
    );
    expect(chrome.storage.local.set).toHaveBeenCalledExactlyOnceWith({
      [StorageKeys.FOLDER_DATA_AISTUDIO]: folders,
    });
    expect(context.payload).toEqual({
      platform: 'aistudio',
      accountScope: null,
      timelineHierarchyAccountScope: null,
      highlightAccountScope: null,
      includeHighlights: false,
    });
  });
});
