/**
 * Cloud upload and sync for ChatGPT folders from the page, through the same
 * background messages the popup sends. The background picks the provider the
 * user chose (Google Drive, or iCloud on Safari) and re-reads the folders from
 * storage itself, so the page never decides what lands in the cloud.
 */
import browser from 'webextension-polyfill';

import type { FolderData } from '@/core/types/folder';
import type { ToastTone } from '@/core/ui/toast/types';
import { getTranslationSyncUnsafe as t } from '@/utils/i18n';
import { mergeFolderData } from '@/utils/merge';

import { readChatGptFolderExport } from './transfer';

const PLATFORM = 'chatgpt';

type SyncResponse = { ok?: boolean; error?: string; data?: { folders?: unknown } | null };

export type ChatGptCloudSyncHost = {
  /** The folders as they are now; a sync merges into these. */
  data: () => FolderData;
  ready: () => boolean;
  replaceData: (data: FolderData) => Promise<boolean>;
  notify: (message: string, tone: ToastTone) => void;
  /** The plugin was turned off meanwhile: report nothing further. */
  isDisposed: () => boolean;
};

function errorText(error: unknown, fallback: string): string {
  return error instanceof Error ? error.message : fallback;
}

function notifyError(host: ChatGptCloudSyncHost, message: string): void {
  host.notify(
    t('syncError').replace('{error}', () => message),
    'error',
  );
}

/** Uploads the ChatGPT folders to the chosen cloud. */
export async function uploadChatGptFolders(host: ChatGptCloudSyncHost): Promise<void> {
  if (!host.ready()) return;
  host.notify(t('uploadInProgress'), 'info');
  try {
    const response = (await browser.runtime.sendMessage({
      type: 'gv.sync.upload',
      payload: { platform: PLATFORM, folders: host.data(), prompts: [] },
    })) as SyncResponse | undefined;
    if (host.isDisposed()) return;
    if (response?.ok) host.notify(t('uploadSuccess'), 'success');
    else notifyError(host, response?.error || 'Unknown error');
  } catch (error) {
    if (!host.isDisposed()) notifyError(host, errorText(error, 'Unknown error'));
  }
}

/**
 * Downloads the cloud copy and merges it into the local folders, as the popup's
 * restore does. A copy holding another site's conversations is refused whole.
 */
export async function syncChatGptFolders(host: ChatGptCloudSyncHost): Promise<void> {
  if (!host.ready()) return;
  host.notify(t('downloadInProgress'), 'info');
  try {
    const response = (await browser.runtime.sendMessage({
      type: 'gv.sync.download',
      payload: { platform: PLATFORM },
    })) as SyncResponse | undefined;
    if (host.isDisposed()) return;
    if (!response?.ok) {
      notifyError(host, response?.error || 'Download failed');
      return;
    }
    if (!response.data?.folders) {
      host.notify(t('syncNoData'), 'info');
      return;
    }
    const validated = readChatGptFolderExport(response.data.folders, 'merge');
    if (!validated.ok) {
      host.notify(
        t(
          validated.reason === 'wrong-site'
            ? 'folder_import_wrong_site'
            : 'folder_import_invalid_format',
        ),
        'error',
      );
      return;
    }
    if (!host.ready()) return;
    // Merge against the folders as they are now, not as they were when the sync started.
    const saved = await host.replaceData(mergeFolderData(host.data(), validated.payload.data));
    if (host.isDisposed()) return;
    host.notify(
      t(saved ? 'downloadMergeSuccess' : 'folder_save_error'),
      saved ? 'success' : 'error',
    );
  } catch (error) {
    if (!host.isDisposed()) notifyError(host, errorText(error, 'Unknown error'));
  }
}
