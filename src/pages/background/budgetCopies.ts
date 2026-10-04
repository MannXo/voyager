/**
 * Writes the pages' legacy backup copies inside the background's storage budget
 * (addendum P3P4 R6.1). A page never holds a permit: the budget measures, admits
 * and writes in one step, and replies `saved` or `skipped`.
 */
import { AUTHORITY_FENCE_KEY } from '@/features/folder/owner/authorityFence';
import { siteOfFolderKey } from '@/features/folder/owner/folderOwnerPolicy';
import { FOLDER_PLATFORMS, isFolderPlatform } from '@/features/folder/platforms';
import { isWriteCopyMessage, type WriteCopyReply } from '@/features/storage/budgetCopyMessage';
import {
  type StorageBudget,
  storageBudget,
  storedItemBytes,
} from '@/features/storage/storageBudget';

const AUTHORITY_READ_TIMEOUT_MS = 1000;
const FOLDER_BACKUP_KEY =
  /^gvBackup_([a-z]+)-folders(?::acct:[0-9a-z]{1,7})?_(primary|emergency|beforeUnload|metadata)$/;

export interface BudgetCopyDeps {
  budget: StorageBudget;
  write(items: Record<string, string>): Promise<void>;
}

const defaultDeps = (): BudgetCopyDeps => ({
  budget: storageBudget,
  write: (items) => chrome.storage.local.set(items),
});

export async function writeBudgetCopy(
  key: string,
  value: string,
  deps: BudgetCopyDeps = defaultDeps(),
): Promise<WriteCopyReply> {
  try {
    const admission = await deps.budget.run(
      { kind: 'copy', keys: [key], bytes: storedItemBytes(key, value) },
      async () => {
        const platform = FOLDER_BACKUP_KEY.exec(key)?.[1];
        const site = isFolderPlatform(platform)
          ? siteOfFolderKey(FOLDER_PLATFORMS[platform].folderStorageKey)
          : null;
        if (site) {
          let deadline: ReturnType<typeof setTimeout> | undefined;
          try {
            // Admission may wait behind newer owner writes; authorize the eventual physical copy.
            const stored = await Promise.race([
              chrome.storage.local.get(AUTHORITY_FENCE_KEY),
              new Promise<never>((_, reject) => {
                deadline = setTimeout(
                  () => reject(new Error('Folder authority read timed out')),
                  AUTHORITY_READ_TIMEOUT_MS,
                );
              }),
            ]);
            const authority = stored[AUTHORITY_FENCE_KEY] as
              | { sites?: Record<string, unknown> }
              | undefined;
            if (authority !== undefined && authority?.sites?.[site] !== 'legacy') return false;
          } finally {
            clearTimeout(deadline);
          }
        }
        await deps.write({ [key]: value });
        return true;
      },
    );
    return { status: admission.admitted && admission.value ? 'saved' : 'skipped' };
  } catch {
    return { status: 'skipped' };
  }
}

export function startBudgetCopies(deps?: BudgetCopyDeps): void {
  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (!isWriteCopyMessage(message)) return undefined;
    if (sender.id !== chrome.runtime.id) {
      sendResponse({ status: 'skipped' } satisfies WriteCopyReply);
      return undefined;
    }
    void writeBudgetCopy(message.key, message.value, deps).then(sendResponse);
    return true;
  });
}
