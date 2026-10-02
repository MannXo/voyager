import browser from 'webextension-polyfill';

import {
  type AccountScope,
  accountIsolationService,
  detectAccountContextFromDocument,
} from '@/core/services/AccountIsolationService';
import type { PromptItem, SyncAccountScope } from '@/core/types/sync';
import { cloneFolderData } from '@/features/folder/model/folderData';
import { getTranslationSyncUnsafe as t } from '@/utils/i18n';
import { mergeFolderData, mergePrompts, mergeTimelineHierarchy } from '@/utils/merge';

import {
  getTimelineHierarchyStorageKey,
  getTimelineHierarchyStorageKeysToRead,
  resolveTimelineHierarchyDataForStorageScope,
} from '../timeline/hierarchyStorage';
import type { TimelineHierarchyData } from '../timeline/hierarchyTypes';
import { type FolderTransferHost, debugTransfer, isCurrentTransfer } from './folderTransferHost';
import type { FolderData } from './types';

type StarredData = { messages: Record<string, unknown[]> };

type SyncDownloadResponse =
  | {
      ok?: boolean;
      error?: string;
      highlights?: { synced?: boolean; count?: number; empty?: boolean };
      data?: {
        folders?: { data?: FolderData };
        prompts?: { items?: PromptItem[] };
        starred?: { data?: StarredData };
        timelineHierarchy?: { data?: TimelineHierarchyData };
      };
    }
  | undefined;

type SyncSnapshot = {
  prompts: PromptItem[];
  starred: StarredData;
  timelineHierarchy: TimelineHierarchyData;
};

type CloudSnapshot = { folders: FolderData } & SyncSnapshot;

function toSyncAccountScope(scope: AccountScope | null): SyncAccountScope | undefined {
  if (!scope) return undefined;
  return {
    accountKey: scope.accountKey,
    accountId: scope.accountId,
    routeUserId: scope.routeUserId,
  };
}

async function resolveTimelineHierarchySyncScope(): Promise<SyncAccountScope | undefined> {
  try {
    const context = detectAccountContextFromDocument(window.location.href, document);
    if (!context.routeUserId && !context.email) {
      return undefined;
    }

    const scope = await accountIsolationService.resolveAccountScope({
      pageUrl: window.location.href,
      routeUserId: context.routeUserId,
      email: context.email,
    });

    return toSyncAccountScope(scope);
  } catch (error) {
    console.warn('[FolderTransfer] Failed to resolve timeline hierarchy sync scope:', error);
    return undefined;
  }
}

function notifySyncError(host: FolderTransferHost, errorMsg: string): void {
  host.notify(
    t('syncError').replace('{error}', () => errorMsg),
    'error',
  );
}

/** Upload this account's folders and the local prompts; the background adds starred messages. */
export async function uploadFolders(host: FolderTransferHost): Promise<void> {
  const context = host.getContext();
  const { session } = context;
  if (!session?.ready) return;
  const accountScope = toSyncAccountScope(session.accountScope);
  const folders = cloneFolderData(session.data);
  try {
    host.notify(t('uploadInProgress'), 'info');
    const timelineHierarchyAccountScope = await resolveTimelineHierarchySyncScope();
    if (!isCurrentTransfer(host, context)) return;

    // Get prompts from storage
    let prompts: PromptItem[] = [];
    try {
      const storageResult = await chrome.storage.local.get(['gvPromptItems']);
      if (storageResult.gvPromptItems) {
        prompts = storageResult.gvPromptItems as PromptItem[];
      }
    } catch (err) {
      console.warn('[FolderTransfer] Could not get prompts for upload:', err);
    }
    if (!isCurrentTransfer(host, context)) return;

    debugTransfer(
      `Uploading - folders: ${folders.folders?.length || 0}, prompts: ${prompts.length}`,
    );

    // Send upload request to background script
    // Background script will also fetch starred messages for Gemini platform
    const response = (await browser.runtime.sendMessage({
      type: 'gv.sync.upload',
      payload: {
        folders,
        prompts,
        platform: 'gemini',
        accountScope,
        timelineHierarchyAccountScope,
      },
    })) as { ok?: boolean; error?: string } | undefined;

    if (response?.ok) {
      host.notify(t('uploadSuccess'), 'success');
    } else {
      notifySyncError(host, response?.error || 'Unknown error');
    }
  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : 'Unknown error';
    console.error('[FolderTransfer] Cloud upload failed:', error);
    notifySyncError(host, errorMsg);
  }
}

/** Read the local prompts, starred messages and timeline hierarchy the cloud copy merges into. */
async function readLocalSyncSnapshot(scope: SyncAccountScope | undefined): Promise<SyncSnapshot> {
  let prompts: PromptItem[] = [];
  try {
    const storageResult = await chrome.storage.local.get(['gvPromptItems']);
    if (storageResult.gvPromptItems) {
      prompts = storageResult.gvPromptItems as PromptItem[];
    }
  } catch (err) {
    console.warn('[FolderTransfer] Could not get local prompts for merge:', err);
  }

  let starred: StarredData = { messages: {} };
  try {
    const starredResult = await chrome.storage.local.get(['geminiTimelineStarredMessages']);
    const starredData = starredResult.geminiTimelineStarredMessages;
    if (
      typeof starredData === 'object' &&
      starredData !== null &&
      'messages' in starredData &&
      typeof starredData.messages === 'object' &&
      starredData.messages !== null
    ) {
      starred = { messages: starredData.messages as Record<string, unknown[]> };
    }
  } catch (err) {
    console.warn('[FolderTransfer] Could not get local starred messages for merge:', err);
  }

  let timelineHierarchy: TimelineHierarchyData = { conversations: {} };
  try {
    const hierarchyResult = (await chrome.storage.local.get(
      getTimelineHierarchyStorageKeysToRead(scope?.accountKey),
    )) as Record<string, unknown>;
    timelineHierarchy = resolveTimelineHierarchyDataForStorageScope(
      hierarchyResult,
      scope?.accountKey,
      scope?.routeUserId ?? null,
    );
  } catch (err) {
    console.warn('[FolderTransfer] Could not get local timeline hierarchy for merge:', err);
  }
  return { prompts, starred, timelineHierarchy };
}

function mergeStarredMessages(local: StarredData, cloud: StarredData): StarredData {
  const localMessages = local?.messages || {};
  const cloudMessages = cloud?.messages || {};

  const allConversationIds = new Set([
    ...Object.keys(localMessages),
    ...Object.keys(cloudMessages),
  ]);

  const mergedMessages: Record<string, unknown[]> = {};

  allConversationIds.forEach((conversationId) => {
    const localConvoMessages = localMessages[conversationId] || [];
    const cloudConvoMessages = cloudMessages[conversationId] || [];

    type StarredMsg = { turnId?: string; starredAt?: number };
    const messageMap = new Map<string, unknown>();

    // Add cloud messages first
    cloudConvoMessages.forEach((m) => {
      const msg = m as StarredMsg;
      if (msg?.turnId) messageMap.set(msg.turnId, m);
    });

    // Merge local messages - prefer newer starredAt
    localConvoMessages.forEach((m) => {
      const localMsg = m as StarredMsg;
      if (!localMsg?.turnId) return;
      const existingMsg = messageMap.get(localMsg.turnId) as StarredMsg | undefined;
      if (!existingMsg) {
        messageMap.set(localMsg.turnId, m);
      } else if ((localMsg.starredAt || 0) >= (existingMsg.starredAt || 0)) {
        messageMap.set(localMsg.turnId, m);
      }
    });

    const mergedArray = Array.from(messageMap.values());
    if (mergedArray.length > 0) {
      mergedMessages[conversationId] = mergedArray;
    }
  });

  return { messages: mergedMessages };
}

/** The downloaded payload with an empty value standing in for each missing part. */
function readCloudSnapshot(
  data: NonNullable<NonNullable<SyncDownloadResponse>['data']>,
): CloudSnapshot {
  const cloud = {
    folders: data.folders?.data || { folders: [], folderContents: {} },
    prompts: data.prompts?.items || [],
    starred: data.starred?.data || { messages: {} },
    timelineHierarchy: data.timelineHierarchy?.data || { conversations: {} },
  };
  debugTransfer(
    `Downloaded - folders: ${cloud.folders.folders?.length || 0}, prompts: ${cloud.prompts.length}, starred conversations: ${Object.keys(cloud.starred.messages || {}).length}`,
  );
  return cloud;
}

/** Merge the cloud copy with local data; folders are merged against `localFolders`. */
function mergeCloudSnapshot(
  cloud: CloudSnapshot,
  localFolders: FolderData,
  local: SyncSnapshot,
): CloudSnapshot {
  const merged = {
    folders: mergeFolderData(localFolders, cloud.folders),
    // Simple ID-based merge
    prompts: mergePrompts(local.prompts, cloud.prompts),
    starred: mergeStarredMessages(local.starred, cloud.starred),
    timelineHierarchy: mergeTimelineHierarchy(local.timelineHierarchy, cloud.timelineHierarchy),
  };

  debugTransfer(
    `Merged - folders: ${merged.folders.folders?.length || 0}, prompts: ${merged.prompts.length}, starred conversations: ${Object.keys(merged.starred.messages || {}).length}, hierarchy conversations: ${Object.keys(merged.timelineHierarchy.conversations || {}).length}`,
  );
  return merged;
}

/**
 * Download the cloud copy and merge it into local data. Folders save through the host first,
 * then prompts, starred messages and the timeline hierarchy land in one storage write.
 */
export async function syncFolders(host: FolderTransferHost): Promise<void> {
  const context = host.getContext();
  const { session } = context;
  if (!session?.ready) return;
  const accountScope = toSyncAccountScope(session.accountScope);
  try {
    host.notify(t('downloadInProgress'), 'info');
    const timelineHierarchyAccountScope = await resolveTimelineHierarchySyncScope();
    if (!isCurrentTransfer(host, context)) return;
    const timelineHierarchyStorageKey = getTimelineHierarchyStorageKey(
      timelineHierarchyAccountScope?.accountKey,
    );

    // Send download request to background script
    const response = (await browser.runtime.sendMessage({
      type: 'gv.sync.download',
      payload: {
        platform: 'gemini',
        accountScope,
        timelineHierarchyAccountScope,
      },
    })) as SyncDownloadResponse;

    if (!isCurrentTransfer(host, context)) return;
    if (!response?.ok) {
      notifySyncError(host, response?.error || 'Download failed');
      return;
    }

    if (!response.data) {
      if (response.highlights?.synced) {
        host.notify(t('syncSuccess'), 'success');
        return;
      }
      host.notify(t('syncNoData') || 'No data in cloud', 'info');
      return;
    }

    const cloud = readCloudSnapshot(response.data);
    const local = await readLocalSyncSnapshot(timelineHierarchyAccountScope);
    if (!isCurrentTransfer(host, context)) return;

    // Merge against the folders as they are now, not as they were when the sync started.
    const merged = mergeCloudSnapshot(cloud, host.getContext().data, local);

    const saved = await host.applyData(merged.folders);
    if (!isCurrentTransfer(host, context)) return;
    if (!saved) {
      host.notify(t('folder_save_error'), 'error');
      return;
    }

    // Save merged prompts and starred to storage
    await chrome.storage.local.set({
      gvPromptItems: merged.prompts,
      geminiTimelineStarredMessages: merged.starred,
      [timelineHierarchyStorageKey]: merged.timelineHierarchy,
    });
    if (!isCurrentTransfer(host, context)) return;

    host.refresh();
    host.notify(t('downloadMergeSuccess'), 'success');
  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : 'Unknown error';
    console.error('[FolderTransfer] Cloud sync failed:', error);
    if (isCurrentTransfer(host, context)) notifySyncError(host, errorMsg);
  }
}

function formatRelativeTime(timestamp: number | null): string {
  if (!timestamp) return '';
  const now = Date.now();
  const diffMs = now - timestamp;
  const diffMins = Math.floor(diffMs / 60000);
  const diffHours = Math.floor(diffMs / 3600000);
  const diffDays = Math.floor(diffMs / 86400000);

  if (diffMins < 1) {
    return t('justNow');
  } else if (diffMins < 60) {
    return `${diffMins} ${t('minutesAgo')}`;
  } else if (diffHours < 24) {
    return `${diffHours} ${t('hoursAgo')}`;
  } else if (diffDays === 1) {
    return t('yesterday');
  } else {
    return new Date(timestamp).toLocaleDateString();
  }
}

const TOOLTIPS = {
  upload: {
    field: 'lastUploadTime',
    base: 'folder_cloud_upload',
    last: 'lastUploaded',
    never: 'neverUploaded',
  },
  sync: {
    field: 'lastSyncTime',
    base: 'folder_cloud_sync',
    last: 'lastSynced',
    never: 'neverSynced',
  },
} as const;

/** The upload/sync button tooltip, with the last run time when the background knows it. */
export async function readSyncTooltip(kind: keyof typeof TOOLTIPS): Promise<string> {
  const keys = TOOLTIPS[kind];
  try {
    const response = (await browser.runtime.sendMessage({ type: 'gv.sync.getState' })) as
      | { ok?: boolean; state?: { lastUploadTime?: number | null; lastSyncTime?: number | null } }
      | undefined;
    if (response?.ok && response.state) {
      const lastTime = response.state[keys.field];
      const timeStr = formatRelativeTime(lastTime ?? null);
      const baseTooltip = t(keys.base);
      return lastTime
        ? `${baseTooltip}\n${t(keys.last).replace('{time}', timeStr)}`
        : `${baseTooltip}\n${t(keys.never)}`;
    }
  } catch (e) {
    console.warn('[FolderTransfer] Failed to get sync state for tooltip:', e);
  }
  return t(keys.base);
}
