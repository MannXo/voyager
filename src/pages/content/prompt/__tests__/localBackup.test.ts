import { describe, expect, it, vi } from 'vitest';

import { buildScopedStorageKey } from '@/core/services/AccountIsolationService';
import { StorageKeys } from '@/core/types/common';

import type { FolderData } from '../../folder/types';
import {
  getFolderBackupBaseStorageKey,
  loadFolderDataForLocalBackup,
  resolveFolderBackupStorageKey,
} from '../localBackup';

describe('local backup folder data', () => {
  it('uses the Gemini folder key on Gemini pages', () => {
    expect(getFolderBackupBaseStorageKey('https://gemini.google.com/app/abc')).toBe(
      StorageKeys.FOLDER_DATA,
    );
  });

  it('uses the AI Studio folder key on AI Studio pages', () => {
    expect(getFolderBackupBaseStorageKey('https://aistudio.google.com/prompts')).toBe(
      StorageKeys.FOLDER_DATA_AISTUDIO,
    );
    expect(getFolderBackupBaseStorageKey('https://aistudio.google.cn/library')).toBe(
      StorageKeys.FOLDER_DATA_AISTUDIO,
    );
  });

  it('has no folder key on sites without a folder bucket', () => {
    for (const url of [
      'https://chatgpt.com/c/123',
      'https://claude.ai/chat/123',
      'https://chat.deepseek.com/a/chat/s/123',
    ]) {
      expect(getFolderBackupBaseStorageKey(url), url).toBeNull();
    }
  });

  it('never reads Gemini folders when backing up from ChatGPT, Claude or DeepSeek', async () => {
    document.body.innerHTML = '<div aria-label="user@example.com"></div>';
    const loadData = vi.fn(async (_key: string): Promise<FolderData | null> => ({
      folders: [
        { id: 'g', name: 'Gemini', parentId: null, isExpanded: true, createdAt: 1, updatedAt: 1 },
      ],
      folderContents: {},
    }));
    const isIsolationEnabled = vi.fn().mockResolvedValue(true);
    const resolveAccountScope = vi.fn();

    for (const url of [
      'https://chatgpt.com/c/123',
      'https://claude.ai/chat/123',
      'https://chat.deepseek.com/a/chat/s/123',
    ]) {
      await expect(
        resolveFolderBackupStorageKey({
          pageUrl: url,
          doc: document,
          isIsolationEnabled,
          resolveAccountScope,
        }),
      ).resolves.toBeNull();
      await expect(
        loadFolderDataForLocalBackup({ loadData }, url, document, {
          isIsolationEnabled,
          resolveAccountScope,
        }),
      ).resolves.toEqual({ folders: [], folderContents: {} });
    }

    expect(loadData).not.toHaveBeenCalled();
    expect(isIsolationEnabled).not.toHaveBeenCalled();
    expect(resolveAccountScope).not.toHaveBeenCalled();
  });

  it('scopes the AI Studio key when account isolation is enabled', async () => {
    document.body.innerHTML = '<div class="account-switcher-text">User@Example.com</div>';
    const isIsolationEnabled = vi.fn().mockResolvedValue(true);
    const resolveAccountScope = vi.fn().mockResolvedValue({
      accountKey: 'email:test-account',
      accountId: 1,
      routeUserId: null,
      emailHash: 'test-account',
    });

    const key = await resolveFolderBackupStorageKey({
      pageUrl: 'https://aistudio.google.com/prompts',
      doc: document,
      isIsolationEnabled,
      resolveAccountScope,
    });

    expect(isIsolationEnabled).toHaveBeenCalledWith({
      platform: 'aistudio',
      pageUrl: 'https://aistudio.google.com/prompts',
    });
    expect(resolveAccountScope).toHaveBeenCalledWith({
      pageUrl: 'https://aistudio.google.com/prompts',
      routeUserId: null,
      email: 'user@example.com',
    });
    expect(key).toBe(buildScopedStorageKey(StorageKeys.FOLDER_DATA_AISTUDIO, 'email:test-account'));
  });

  it('loads AI Studio folder data instead of Gemini folder data on AI Studio pages', async () => {
    const geminiData: FolderData = {
      folders: [
        {
          id: 'gemini-folder',
          name: 'Gemini',
          parentId: null,
          isExpanded: true,
          createdAt: 1,
          updatedAt: 1,
        },
      ],
      folderContents: {
        'gemini-folder': [
          {
            conversationId: 'gemini-conversation',
            title: 'Gemini chat',
            url: 'https://gemini.google.com/app/gemini-conversation',
            addedAt: 1,
          },
        ],
      },
    };
    const aiStudioData: FolderData = {
      folders: [
        {
          id: 'aistudio-folder',
          name: 'AI Studio',
          parentId: null,
          isExpanded: true,
          createdAt: 2,
          updatedAt: 2,
        },
      ],
      folderContents: {
        'aistudio-folder': [
          {
            conversationId: 'aistudio-conversation',
            title: 'AI Studio prompt',
            url: 'https://aistudio.google.com/prompts/aistudio-conversation',
            addedAt: 2,
          },
        ],
      },
    };
    const loadData = vi.fn(async (key: string) => {
      if (key === StorageKeys.FOLDER_DATA_AISTUDIO) return aiStudioData;
      if (key === StorageKeys.FOLDER_DATA) return geminiData;
      return null;
    });

    const data = await loadFolderDataForLocalBackup(
      { loadData },
      'https://aistudio.google.com/prompts',
      document,
      { isIsolationEnabled: vi.fn().mockResolvedValue(false) },
    );

    expect(loadData).toHaveBeenCalledWith(StorageKeys.FOLDER_DATA_AISTUDIO);
    expect(data).toBe(aiStudioData);
  });
});
