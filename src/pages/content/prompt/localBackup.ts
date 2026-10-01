import {
  type AccountPlatform,
  type AccountScope,
  type AccountScopeHints,
  accountIsolationService,
  buildScopedStorageKey,
  detectAccountContextFromDocument,
  detectAccountPlatformFromUrl,
} from '@/core/services/AccountIsolationService';
import { FOLDER_PLATFORMS } from '@/features/folder/platforms';

import type { FolderData } from '../folder/types';

interface FolderBackupStorage {
  loadData(key: string): Promise<FolderData | null>;
}

type IsIsolationEnabled = (options: {
  platform?: AccountPlatform;
  pageUrl?: string | null;
}) => Promise<boolean>;

type ResolveAccountScope = (hints?: AccountScopeHints) => Promise<AccountScope>;

export interface ResolveFolderBackupStorageKeyOptions {
  pageUrl: string;
  doc: Document;
  isIsolationEnabled?: IsIsolationEnabled;
  resolveAccountScope?: ResolveAccountScope;
}

/** `null` on sites without a folder bucket (ChatGPT, Claude, DeepSeek, custom websites). */
export function getFolderBackupBaseStorageKey(pageUrl: string): string | null {
  const platform = detectAccountPlatformFromUrl(pageUrl);
  return platform ? FOLDER_PLATFORMS[platform].folderStorageKey : null;
}

export async function resolveFolderBackupStorageKey({
  pageUrl,
  doc,
  isIsolationEnabled = (options) => accountIsolationService.isIsolationEnabled(options),
  resolveAccountScope = (hints) => accountIsolationService.resolveAccountScope(hints),
}: ResolveFolderBackupStorageKeyOptions): Promise<string | null> {
  const platform = detectAccountPlatformFromUrl(pageUrl);
  if (!platform) return null;
  const baseKey = FOLDER_PLATFORMS[platform].folderStorageKey;

  try {
    const enabled = await isIsolationEnabled({ platform, pageUrl });
    if (!enabled) return baseKey;

    const context = detectAccountContextFromDocument(pageUrl, doc);
    const scope = await resolveAccountScope({
      pageUrl,
      routeUserId: context.routeUserId,
      email: context.email,
    });
    return buildScopedStorageKey(baseKey, scope.accountKey);
  } catch (error) {
    console.warn('[PromptManager] Failed to resolve folder backup storage key:', error);
    return baseKey;
  }
}

export async function loadFolderDataForLocalBackup(
  storage: FolderBackupStorage,
  pageUrl: string,
  doc: Document,
  options: Partial<
    Pick<ResolveFolderBackupStorageKeyOptions, 'isIsolationEnabled' | 'resolveAccountScope'>
  > = {},
): Promise<FolderData> {
  const storageKey = await resolveFolderBackupStorageKey({
    pageUrl,
    doc,
    ...options,
  });

  // Sites without a folder bucket back up no folders rather than another platform's.
  return (
    (storageKey ? await storage.loadData(storageKey) : null) || {
      folders: [],
      folderContents: {},
    }
  );
}
