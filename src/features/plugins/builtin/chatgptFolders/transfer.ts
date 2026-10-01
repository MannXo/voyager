import type { FolderData } from '@/core/types/folder';
import { FolderImportExportService } from '@/features/folder/services/FolderImportExportService';
import type { FolderExportPayload, ImportResult } from '@/features/folder/types/import-export';

import { readChatGptConversation } from './chatgptIdentity';

export const CHATGPT_EXPORT_PLATFORM = 'chatgpt';

/** The shared folder file format, marked with the site it came from. */
export type ChatGptFolderExportPayload = FolderExportPayload & {
  platform: typeof CHATGPT_EXPORT_PLATFORM;
};

export type ChatGptImportOutcome =
  | { ok: true; data: FolderData; stats: ImportResult }
  | { ok: false; reason: 'invalid' | 'wrong-site' | 'failed'; message?: string };

export function exportChatGptFolders(data: FolderData): ChatGptFolderExportPayload {
  return { ...FolderImportExportService.exportToPayload(data), platform: CHATGPT_EXPORT_PLATFORM };
}

export function chatgptFolderExportFilename(now: Date = new Date()): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  const date = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}`;
  const time = `${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
  return `voyager-chatgpt-folders-${date}-${time}.json`;
}

/**
 * Whether every entry in `data` is a ChatGPT conversation keyed by its own URL.
 * One foreign entry (a Gemini or AI Studio export) rejects the whole file: a
 * partial import would silently drop the user's folders' contents.
 */
function holdsOnlyChatGptConversations(data: FolderData): boolean {
  return Object.values(data.folderContents).every((bucket) =>
    bucket.every(
      (entry) =>
        typeof entry.url === 'string' &&
        readChatGptConversation(entry.url)?.conversationId === entry.conversationId,
    ),
  );
}

/** Merges a folder file into `current`. Nothing is written here; the caller persists `data`. */
export async function importChatGptFolders(
  raw: unknown,
  current: FolderData,
): Promise<ChatGptImportOutcome> {
  const platform = raw && typeof raw === 'object' ? (raw as { platform?: unknown }).platform : null;
  if (platform !== undefined && platform !== null && platform !== CHATGPT_EXPORT_PLATFORM) {
    return { ok: false, reason: 'wrong-site' };
  }
  const validated = FolderImportExportService.validatePayload(raw);
  if (!validated.success) {
    return { ok: false, reason: 'invalid', message: validated.error.message };
  }
  if (!holdsOnlyChatGptConversations(validated.data.data)) {
    return { ok: false, reason: 'wrong-site' };
  }
  // Merge only, and no sessionStorage backup: the repository keeps its own
  // recovery copies, and a merge never removes an existing folder or entry.
  const imported = await FolderImportExportService.importFromPayload(validated.data, current, {
    strategy: 'merge',
    createBackup: false,
  });
  if (!imported.success) {
    return { ok: false, reason: 'failed', message: imported.error.message };
  }
  return { ok: true, data: imported.data.data, stats: imported.data.stats };
}
