import { StorageKeys } from '@/core/types/common';

/**
 * Sites that own a Voyager folder bucket. Every per-platform storage key, Drive file, sync
 * timestamp and host list is looked up here, so adding a platform does not compile until each
 * one is defined. Any other site (Claude, DeepSeek, custom websites) has no folder
 * bucket: helpers return `null` and callers must skip folder storage, backup and sync.
 */
export type FolderPlatform = 'gemini' | 'aistudio' | 'chatgpt';

export interface FolderPlatformDefinition {
  /** Page hosts whose content scripts own this bucket. */
  hosts: readonly string[];
  /** `chrome.storage.local` base key; account isolation appends `:acct:<hash>`. */
  folderStorageKey: string;
  /** `chrome.storage.sync` per-platform account isolation switch. */
  accountIsolationStorageKey: string | null;
  driveFoldersFileName: string;
  driveFoldersFileType: 'folders' | 'aistudio-folders' | 'chatgpt-folders';
  lastUploadTimeField: 'lastUploadTime' | 'lastUploadTimeAIStudio' | 'lastUploadTimeChatGPT';
  lastSyncTimeField: 'lastSyncTime' | 'lastSyncTimeAIStudio' | 'lastSyncTimeChatGPT';
}

export const FOLDER_PLATFORMS = {
  gemini: {
    hosts: ['gemini.google.com', 'business.gemini.google'],
    folderStorageKey: StorageKeys.FOLDER_DATA,
    accountIsolationStorageKey: StorageKeys.GV_ACCOUNT_ISOLATION_ENABLED_GEMINI,
    driveFoldersFileName: 'gemini-voyager-folders.json',
    driveFoldersFileType: 'folders',
    lastUploadTimeField: 'lastUploadTime',
    lastSyncTimeField: 'lastSyncTime',
  },
  aistudio: {
    hosts: ['aistudio.google.com', 'aistudio.google.cn'],
    folderStorageKey: StorageKeys.FOLDER_DATA_AISTUDIO,
    accountIsolationStorageKey: StorageKeys.GV_ACCOUNT_ISOLATION_ENABLED_AISTUDIO,
    driveFoldersFileName: 'gemini-voyager-aistudio-folders.json',
    driveFoldersFileType: 'aistudio-folders',
    lastUploadTimeField: 'lastUploadTimeAIStudio',
    lastSyncTimeField: 'lastSyncTimeAIStudio',
  },
  chatgpt: {
    hosts: ['chatgpt.com'],
    folderStorageKey: StorageKeys.FOLDER_DATA_CHATGPT,
    accountIsolationStorageKey: null,
    driveFoldersFileName: 'gemini-voyager-chatgpt-folders.json',
    driveFoldersFileType: 'chatgpt-folders',
    lastUploadTimeField: 'lastUploadTimeChatGPT',
    lastSyncTimeField: 'lastSyncTimeChatGPT',
  },
} as const satisfies Readonly<Record<FolderPlatform, FolderPlatformDefinition>>;

export const FOLDER_PLATFORM_IDS = Object.keys(FOLDER_PLATFORMS) as FolderPlatform[];

export function isFolderPlatform(value: unknown): value is FolderPlatform {
  return typeof value === 'string' && Object.prototype.hasOwnProperty.call(FOLDER_PLATFORMS, value);
}

/** The folder platform that owns `hostname`, or `null` for every other site. */
export function getFolderPlatformForHost(
  hostname: string | null | undefined,
): FolderPlatform | null {
  if (!hostname) return null;
  const normalized = hostname.toLowerCase();
  return (
    FOLDER_PLATFORM_IDS.find((platform) =>
      FOLDER_PLATFORMS[platform].hosts.some((host) => host === normalized),
    ) ?? null
  );
}
