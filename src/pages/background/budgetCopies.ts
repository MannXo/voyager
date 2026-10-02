/**
 * Writes the pages' legacy backup copies inside the background's storage budget
 * (addendum P3P4 R6.1). A page never holds a permit: the budget measures, admits
 * and writes in one step, and replies `saved` or `skipped`.
 */
import { isWriteCopyMessage, type WriteCopyReply } from '@/features/storage/budgetCopyMessage';
import { type StorageBudget, storageBudget } from '@/features/storage/storageBudget';

const encoder = new TextEncoder();

/** Bytes chrome.storage counts for a string item: the key plus the JSON-encoded value. */
const storedBytes = (key: string, value: string): number =>
  encoder.encode(key).byteLength + encoder.encode(JSON.stringify(value)).byteLength;

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
      { kind: 'copy', keys: [key], bytes: storedBytes(key, value) },
      () => deps.write({ [key]: value }),
    );
    return { status: admission.admitted ? 'saved' : 'skipped' };
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
