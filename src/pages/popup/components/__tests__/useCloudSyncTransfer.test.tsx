import React, { act, useEffect } from 'react';
import { type Root, createRoot } from 'react-dom/client';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  accountIsolationService,
  buildScopedStorageKey,
} from '@/core/services/AccountIsolationService';
import { StorageKeys } from '@/core/types/common';
import type { FolderData } from '@/core/types/folder';
import type { SyncAccountScope, SyncPlatform } from '@/core/types/sync';
import { createStarStore, type StarStore } from '@/features/savedLibrary/starStore';
import { getTimelineHierarchyStorageKey } from '@/pages/content/timeline/hierarchyStorage';

import { useCloudSyncTransfer } from '../useCloudSyncTransfer';

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

type Transfer = ReturnType<typeof useCloudSyncTransfer>;
function Harness({
  platform,
  includeHighlights,
  capture,
}: {
  platform: SyncPlatform;
  includeHighlights: boolean;
  capture: (transfer: Transfer) => void;
}) {
  const transfer = useCloudSyncTransfer(platform, includeHighlights, getTargetTab);
  useEffect(() => {
    capture(transfer);
  }, [transfer, capture]);
  return null;
}

describe('popup cloud sync transfer operations', () => {
  let root: Root;
  let container: HTMLDivElement;
  let transfer: Transfer;
  let stored: Record<string, unknown>;
  let starStore: StarStore;
  const tabMessage = vi.fn<(tabId: number, message: { type: string }) => Promise<unknown>>();
  const localGet = vi.fn<(keys: unknown) => Promise<Record<string, unknown>>>();
  const localSet = vi.fn<(items: Record<string, unknown>) => Promise<void>>();

  const render = async (platform: SyncPlatform = 'gemini', includeHighlights = true) => {
    await act(async () =>
      root.render(
        <Harness
          platform={platform}
          includeHighlights={includeHighlights}
          capture={(next) => (transfer = next)}
        />,
      ),
    );
  };

  beforeEach(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    vi.spyOn(accountIsolationService, 'isIsolationEnabled').mockResolvedValue(true);
    vi.spyOn(accountIsolationService, 'resolveAccountScope').mockResolvedValue({
      ...pageScope,
      emailHash: null,
    });
    tabMessage.mockImplementation(async (_tabId, message) =>
      message.type === 'gv.account.getContext'
        ? { ok: true, context: { routeUserId: '1' } }
        : { ok: false },
    );
    stored = {};
    localGet.mockImplementation(async (keys) => {
      const names = Array.isArray(keys) ? keys : [keys];
      return Object.fromEntries(names.map((name) => [String(name), stored[String(name)]]));
    });
    localSet.mockImplementation(async (items) => {
      Object.assign(stored, structuredClone(items));
    });
    starStore = createStarStore({ get: localGet, set: localSet });
    vi.stubGlobal('chrome', {
      runtime: {
        id: 'test',
        sendMessage: (_message: { payload?: unknown }, reply: (response: unknown) => void) => {
          void starStore.mergeCloud(_message.payload).then(
            (result) => reply({ ok: true, ...result }),
            (error: Error) => reply({ ok: false, error: error.message }),
          );
        },
      },
      tabs: { sendMessage: tabMessage },
      storage: {
        local: { get: localGet, set: localSet },
        sync: { get: vi.fn().mockResolvedValue({}) },
      },
    });
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    vi.clearAllMocks();
  });

  it('keeps hierarchy and highlights scoped when folder isolation is off', async () => {
    vi.mocked(accountIsolationService.isIsolationEnabled).mockResolvedValue(false);
    localGet.mockResolvedValue({ [StorageKeys.FOLDER_DATA]: folders });
    await render();
    const payload = await transfer.prepareUpload();
    expect(payload).toEqual({
      platform: 'gemini',
      accountScope: null,
      timelineHierarchyAccountScope: pageScope,
      highlightAccountScope: pageScope,
      includeHighlights: true,
      folders,
      prompts: [],
    });
  });

  it('uses fresh nonempty tab folders and only overrides the folder scope', async () => {
    tabMessage.mockImplementation(async (_tabId, message) =>
      message.type === 'gv.account.getContext'
        ? { ok: true, context: { routeUserId: '1' } }
        : { ok: true, data: folders, accountScope: tabScope },
    );
    localGet.mockResolvedValue({
      [buildScopedStorageKey(StorageKeys.FOLDER_DATA, 'tab')]: emptyFolders,
    });
    await render();
    const payload = await transfer.prepareUpload();
    expect(payload.folders).toEqual(folders);
    expect(payload.accountScope).toEqual(tabScope);
    expect(payload.timelineHierarchyAccountScope).toEqual(pageScope);
    expect(payload.highlightAccountScope).toEqual(pageScope);
    expect(localSet).not.toHaveBeenCalled();
  });

  it('restores into the tab folder scope but the captured hierarchy scope without clearing absent stars', async () => {
    await render('gemini', false);
    const download = await transfer.prepareDownload();
    // Changes after preparation must not redirect the hierarchy restore.
    vi.mocked(accountIsolationService.resolveAccountScope).mockResolvedValue({
      ...tabScope,
      emailHash: null,
    });
    tabMessage.mockResolvedValue({ ok: true, data: emptyFolders, accountScope: tabScope });
    await download.restore({ folders: { data: folders } }, 'overwrite', false);
    expect(localSet).toHaveBeenCalledExactlyOnceWith({
      [buildScopedStorageKey(StorageKeys.FOLDER_DATA, 'tab')]: folders,
      [StorageKeys.PROMPT_ITEMS]: [],
      [getTimelineHierarchyStorageKey('page')]: { conversations: {} },
    });
    expect(tabMessage).toHaveBeenLastCalledWith(7, { type: 'gv.folders.reload' });
  });

  it.each(['merge', 'overwrite'] as const)(
    'keeps other sites and Gemini accounts when %s restores stars',
    async (mode) => {
      const makeStar = (id: string, url: string) => ({
        conversationId: id,
        turnId: 't',
        content: id,
        conversationUrl: url,
        starredAt: 1,
      });
      const claude = makeStar('claude:conv:one', 'https://claude.ai/chat/one');
      const otherAccount = makeStar('gemini:conv:other', 'https://gemini.google.com/u/2/app/other');
      const cloud = makeStar('gemini:conv:cloud', 'https://gemini.google.com/u/1/app/cloud');
      stored[StorageKeys.TIMELINE_STARRED_MESSAGES] = {
        messages: {
          [claude.conversationId]: [claude],
          [otherAccount.conversationId]: [otherAccount],
        },
      };
      await render('gemini', false);
      const download = await transfer.prepareDownload();
      await download.restore(
        {
          folders: { data: folders },
          starred: {
            format: 'gemini-voyager.starred.v1',
            data: { messages: { [cloud.conversationId]: [cloud] } },
          },
        },
        mode,
        false,
      );
      expect((await starStore.getAll()).messages).toEqual({
        [claude.conversationId]: [claude],
        [otherAccount.conversationId]: [otherAccount],
        [cloud.conversationId]: [cloud],
      });
      await download.restore(
        {
          folders: { data: folders },
          starred: {
            format: 'gemini-voyager.starred.v1',
            data: { messages: {} },
          },
        },
        mode,
        false,
      );
      expect(Object.keys((await starStore.getAll()).messages)).toHaveLength(3);
    },
  );

  it.each([undefined, null, 42])(
    'leaves stars untouched when the cloud star file is %s',
    async (starred) => {
      const existing = {
        turnId: 't',
        content: 'Keep',
        conversationId: 'one',
        conversationUrl: '',
        starredAt: 1,
      };
      stored[StorageKeys.TIMELINE_STARRED_MESSAGES] = { messages: { one: [existing] } };
      await render('gemini', false);
      const download = await transfer.prepareDownload();
      await download.restore({ folders: { data: folders }, starred }, 'overwrite', false);
      expect((await starStore.getAll()).messages).toEqual({ one: [existing] });
    },
  );

  it('falls back to scoped legacy folders after the upload tab timeout', async () => {
    await render('gemini', false);
    vi.useFakeTimers();
    tabMessage.mockImplementation(async (_tabId, message) =>
      message.type === 'gv.account.getContext'
        ? { ok: true, context: { routeUserId: '1' } }
        : new Promise(() => {}),
    );
    localGet.mockResolvedValue({
      [buildScopedStorageKey(StorageKeys.FOLDER_DATA, 'page')]: JSON.stringify(folders),
      [StorageKeys.PROMPT_ITEMS]: [{ id: 'p', text: 'Prompt', tags: [], createdAt: 1 }],
    });
    const upload = transfer.prepareUpload();
    await vi.advanceTimersByTimeAsync(499);
    expect(localGet).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect((await upload).folders).toEqual(folders);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('keeps AI Studio restore writes limited to its folder bucket', async () => {
    vi.mocked(accountIsolationService.isIsolationEnabled).mockResolvedValue(false);
    await render('aistudio');
    const download = await transfer.prepareDownload();
    await download.restore(
      {
        folders: { data: folders },
        prompts: { items: [{ id: 'p', text: 'Prompt', tags: [], createdAt: 1 }] },
      },
      'overwrite',
      false,
    );
    expect(localSet).toHaveBeenCalledExactlyOnceWith({
      [StorageKeys.FOLDER_DATA_AISTUDIO]: folders,
    });
    expect(download.payload).toEqual({
      platform: 'aistudio',
      accountScope: null,
      timelineHierarchyAccountScope: null,
      highlightAccountScope: null,
      includeHighlights: false,
    });
  });
});
