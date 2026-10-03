import { useCallback } from 'react';

import {
  accountIsolationService,
  buildScopedStorageKey,
  extractRouteUserIdFromUrl,
} from '@/core/services/AccountIsolationService';
import { StorageKeys } from '@/core/types/common';
import type { FolderData } from '@/core/types/folder';
import type {
  PluginStateExportPayload,
  PromptItem,
  SettingsExportPayload,
  SyncAccountScope,
  SyncPlatform,
} from '@/core/types/sync';
import { getPromptNameConflictIds } from '@/core/utils/promptName';
import { FOLDER_PLATFORMS } from '@/features/folder/platforms';
import {
  getTimelineHierarchyStorageKey,
  getTimelineHierarchyStorageKeysToRead,
  resolveTimelineHierarchyDataForStorageScope,
} from '@/pages/content/timeline/hierarchyStorage';
import type { TimelineHierarchyData } from '@/pages/content/timeline/hierarchyTypes';
import type { StarredMessagesData } from '@/pages/content/timeline/starredTypes';

import {
  mergeFolderData,
  mergePromptsWithStats,
  mergeStarredMessages,
  mergeTimelineHierarchy,
} from '../../../utils/merge';
import { applyCloudRestore, type CloudRestoreMode } from './cloudRestore';

function isFolderData(value: unknown): value is FolderData {
  if (typeof value !== 'object' || value === null) return false;
  const data = value as { folders?: unknown; folderContents?: unknown };
  return (
    Array.isArray(data.folders) &&
    typeof data.folderContents === 'object' &&
    data.folderContents !== null
  );
}

function parseStoredFolderData(value: unknown): FolderData | null {
  if (isFolderData(value)) return value;
  if (typeof value !== 'string') return null;

  try {
    const parsed: unknown = JSON.parse(value);
    return isFolderData(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function isPromptItemArray(value: unknown): value is PromptItem[] {
  return (
    Array.isArray(value) &&
    value.every((item) => {
      if (typeof item !== 'object' || item === null) return false;
      const prompt = item as Record<string, unknown>;
      return (
        typeof prompt.id === 'string' &&
        typeof prompt.text === 'string' &&
        Array.isArray(prompt.tags) &&
        prompt.tags.every((tag) => typeof tag === 'string') &&
        typeof prompt.createdAt === 'number'
      );
    })
  );
}

function isStarredMessagesData(value: unknown): value is StarredMessagesData {
  if (typeof value !== 'object' || value === null) return false;
  if (!('messages' in value)) return false;
  const messages = (value as { messages: unknown }).messages;
  return typeof messages === 'object' && messages !== null;
}

function isTimelineHierarchyData(value: unknown): value is TimelineHierarchyData {
  if (typeof value !== 'object' || value === null) return false;
  if (!('conversations' in value)) return false;
  const conversations = (value as { conversations: unknown }).conversations;
  return typeof conversations === 'object' && conversations !== null;
}

type TargetTab = () => Promise<chrome.tabs.Tab | undefined>;

export interface CloudDownloadData {
  folders?: { data?: FolderData };
  prompts?: { items?: PromptItem[] };
  settings?: SettingsExportPayload;
  plugins?: PluginStateExportPayload;
  starred?: { data?: StarredMessagesData };
  timelineHierarchy?: { data?: TimelineHierarchyData };
}

interface CloudSyncContext {
  payload: {
    platform: SyncPlatform;
    accountScope: SyncAccountScope | null;
    timelineHierarchyAccountScope: SyncAccountScope | null;
    highlightAccountScope: SyncAccountScope | null;
    includeHighlights: boolean;
  };
  folderStorageKey: string;
  timelineHierarchyStorageKey: string;
}

// The timeout belongs to the lookup, including when the tab replies first.
async function requestTabData<T>(
  getTargetTab: TargetTab,
  type: string,
  timeout: number,
): Promise<T | undefined> {
  const tab = await getTargetTab();
  if (!tab?.id) return undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return (await Promise.race([
      chrome.tabs.sendMessage(tab.id, { type }),
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error('timeout')), timeout);
      }),
    ])) as T;
  } finally {
    clearTimeout(timer);
  }
}

async function resolvePageScope(
  platform: SyncPlatform,
  respectIsolationSetting: boolean,
  getTargetTab: TargetTab,
): Promise<SyncAccountScope | null> {
  if (respectIsolationSetting) {
    const isolationEnabled = await accountIsolationService.isIsolationEnabled({ platform });
    if (!isolationEnabled) return null;
  }

  let pageUrl = '';
  let routeUserId: string | null = null;
  let email: string | null = null;
  let pageContextAvailable = false;
  try {
    const tab = await getTargetTab();
    pageUrl = tab?.url || '';
    routeUserId = platform === 'gemini' ? extractRouteUserIdFromUrl(pageUrl) : null;
    if (tab?.id) {
      try {
        // Keep context and URL from the same tab lookup.
        const response = await requestTabData<{
          ok?: boolean;
          context?: { routeUserId?: string | null; email?: string | null };
        }>(async () => tab, 'gv.account.getContext', 400);
        if (response?.ok && response.context) {
          pageContextAvailable = true;
          routeUserId = response.context.routeUserId ?? routeUserId;
          email = response.context.email ?? null;
        }
      } catch {
        // A missing content script falls back to the URL.
      }
    }
  } catch {
    // A failed tab query leaves no page context.
  }
  if (!routeUserId && !email && !pageContextAvailable) return null;

  const resolved = await accountIsolationService.resolveAccountScope({
    pageUrl,
    routeUserId,
    email,
  });
  return {
    accountKey: resolved.accountKey,
    accountId: resolved.accountId,
    routeUserId: resolved.routeUserId,
  };
}

/** Capture the independently scoped folders, hierarchy and highlights before sync. */
async function resolveCloudSyncContext(
  platform: SyncPlatform,
  includeHighlights: boolean,
  getTargetTab: TargetTab,
): Promise<CloudSyncContext> {
  const accountScope = await resolvePageScope(platform, true, getTargetTab);
  const timelineHierarchyAccountScope =
    platform === 'gemini' ? await resolvePageScope(platform, false, getTargetTab) : null;
  const highlightAccountScope =
    platform === 'gemini' && includeHighlights
      ? await resolvePageScope(platform, false, getTargetTab)
      : null;
  const baseFolderStorageKey = FOLDER_PLATFORMS[platform].folderStorageKey;
  return {
    payload: {
      platform,
      accountScope,
      timelineHierarchyAccountScope,
      highlightAccountScope,
      includeHighlights: platform === 'gemini' && includeHighlights,
    },
    folderStorageKey: accountScope
      ? buildScopedStorageKey(baseFolderStorageKey, accountScope.accountKey)
      : baseFolderStorageKey,
    timelineHierarchyStorageKey:
      platform === 'gemini'
        ? getTimelineHierarchyStorageKey(timelineHierarchyAccountScope?.accountKey)
        : StorageKeys.TIMELINE_HIERARCHY,
  };
}

/** Read fresh tab folders, then legacy/object storage, keeping the tab's scope override. */
async function readLocalSyncData(
  context: CloudSyncContext,
  getTargetTab: TargetTab,
  purpose: 'upload' | 'restore',
) {
  const { platform, timelineHierarchyAccountScope } = context.payload;
  let accountScope = context.payload.accountScope;
  let folderStorageKey = context.folderStorageKey;
  let folders: FolderData = { folders: [], folderContents: {} };
  let prompts: PromptItem[] = [];
  let timelineHierarchy: TimelineHierarchyData = { conversations: {} };
  try {
    const response = await requestTabData<{
      ok?: boolean;
      data?: FolderData;
      accountScope?: SyncAccountScope;
    } | null>(getTargetTab, 'gv.sync.requestData', purpose === 'upload' ? 500 : 2000);
    if (response?.ok && response.data) {
      folders = response.data;
      if (response.accountScope) {
        accountScope = response.accountScope;
        folderStorageKey = buildScopedStorageKey(
          FOLDER_PLATFORMS[platform].folderStorageKey,
          accountScope.accountKey,
        );
      }
    }
  } catch (error) {
    console.warn('[CloudSyncSettings] Tab fetch failed/skipped:', error);
  }

  try {
    const storageResult = await chrome.storage.local.get([
      folderStorageKey,
      StorageKeys.PROMPT_ITEMS,
      ...(purpose === 'restore'
        ? getTimelineHierarchyStorageKeysToRead(timelineHierarchyAccountScope?.accountKey)
        : []),
    ]);
    const storedFolders = parseStoredFolderData(storageResult[folderStorageKey]);
    if ((!folders.folders || folders.folders.length === 0) && storedFolders)
      folders = storedFolders;
    const storedPrompts = storageResult[StorageKeys.PROMPT_ITEMS];
    if (platform === 'gemini' && isPromptItemArray(storedPrompts)) prompts = storedPrompts;
    if (platform === 'gemini' && purpose === 'restore') {
      const resolvedHierarchy = resolveTimelineHierarchyDataForStorageScope(
        storageResult as Record<string, unknown>,
        timelineHierarchyAccountScope?.accountKey,
        timelineHierarchyAccountScope?.routeUserId ?? null,
      );
      if (isTimelineHierarchyData(resolvedHierarchy)) timelineHierarchy = resolvedHierarchy;
    }
  } catch (error) {
    console.error('[CloudSyncSettings] Error loading local data:', error);
  }
  return { folders, prompts, timelineHierarchy, accountScope, folderStorageKey };
}

/** Merge/overwrite, apply the ordered restore, then notify the page only after success. */
async function restoreCloudDownload(
  context: CloudSyncContext,
  getTargetTab: TargetTab,
  data: CloudDownloadData,
  mode: CloudRestoreMode,
  highlightsRestored: boolean,
): Promise<{ foldersMissing: boolean; nameConflicts: number }> {
  const local = await readLocalSyncData(context, getTargetTab, 'restore');
  const rawFolders = data.folders?.data;
  const hasCloudFolderData = isFolderData(rawFolders);
  const cloudFolders = hasCloudFolderData ? rawFolders : { folders: [], folderContents: {} };
  const cloudPrompts = data.prompts?.items || [];
  const cloudStarred = data.starred?.data || { messages: {} };
  const cloudHierarchy = data.timelineHierarchy?.data || { conversations: {} };
  let localStarred: StarredMessagesData = { messages: {} };
  try {
    const starredResult = await chrome.storage.local.get(['geminiTimelineStarredMessages']);
    if (isStarredMessagesData(starredResult.geminiTimelineStarredMessages)) {
      localStarred = starredResult.geminiTimelineStarredMessages;
    }
  } catch (error) {
    console.warn('[CloudSyncSettings] Could not get local starred messages:', error);
  }

  const shouldOverwrite = mode === 'overwrite';
  const nextFolders = shouldOverwrite ? cloudFolders : mergeFolderData(local.folders, cloudFolders);
  const promptMerge = shouldOverwrite
    ? { items: cloudPrompts, nameConflicts: getPromptNameConflictIds(cloudPrompts).size }
    : mergePromptsWithStats(local.prompts, cloudPrompts);
  const nextStarred = shouldOverwrite
    ? cloudStarred
    : mergeStarredMessages(localStarred, cloudStarred);
  const nextHierarchy = shouldOverwrite
    ? cloudHierarchy
    : mergeTimelineHierarchy(local.timelineHierarchy, cloudHierarchy);
  const storageUpdate: Record<string, unknown> = { [local.folderStorageKey]: nextFolders };
  if (context.payload.platform === 'gemini') {
    storageUpdate[StorageKeys.PROMPT_ITEMS] = promptMerge.items;
    storageUpdate.geminiTimelineStarredMessages = nextStarred;
    storageUpdate[context.timelineHierarchyStorageKey] = nextHierarchy;
  }
  await applyCloudRestore({
    mode,
    highlightsRestored,
    plugins: data.plugins?.format === 'gemini-voyager.plugins.v1' ? data.plugins.data : undefined,
    settings: data.settings?.data,
    storageUpdate,
    includesPrompts: context.payload.platform === 'gemini',
    foldersMissing: !hasCloudFolderData,
  });
  try {
    const tab = await getTargetTab();
    if (tab?.id) await chrome.tabs.sendMessage(tab.id, { type: 'gv.folders.reload' });
  } catch (error) {
    console.warn('[CloudSyncSettings] Could not notify content script:', error);
  }
  return { foldersMissing: !hasCloudFolderData, nameConflicts: promptMerge.nameConflicts };
}

/** Capture each operation's scope; the download's restore keeps that captured context. */
export function useCloudSyncTransfer(
  platform: SyncPlatform,
  includeHighlights: boolean,
  getTargetTab: TargetTab,
) {
  const prepareUpload = useCallback(async () => {
    const context = await resolveCloudSyncContext(platform, includeHighlights, getTargetTab);
    const local = await readLocalSyncData(context, getTargetTab, 'upload');
    // The background re-reads authoritative storage; retain the popup message contract.
    return {
      ...context.payload,
      accountScope: local.accountScope,
      folders: local.folders,
      prompts: local.prompts,
    };
  }, [platform, includeHighlights, getTargetTab]);

  const prepareDownload = useCallback(async () => {
    const context = await resolveCloudSyncContext(platform, includeHighlights, getTargetTab);
    return {
      payload: context.payload,
      restore: (data: CloudDownloadData, mode: CloudRestoreMode, highlightsRestored: boolean) =>
        restoreCloudDownload(context, getTargetTab, data, mode, highlightsRestored),
    };
  }, [platform, includeHighlights, getTargetTab]);

  return { prepareUpload, prepareDownload };
}
