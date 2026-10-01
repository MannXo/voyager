import type { ExportPlatformAdapter } from './adapter/platformAdapters';
import type { ExportSelectionOptions } from './adapter/type';
import { throwIfExportCancelled } from './exportCancellation';

export interface PreparedExportSteps {
  /** The fallback when the adapter does not read the conversation itself. */
  readonly scrollToTop: () => Promise<void>;
  /** Selection mode through to its end: exported, cancelled or torn down. */
  readonly exportSelection: () => Promise<void>;
}

/**
 * The export on a platform that does not preload history: prepare the
 * conversation, then run the selection session. Whatever the preparation keeps
 * for the session (ChatGPT's crawl and its thread watch) is released once the
 * session ends, however it ends.
 */
export async function runPreparedExport(
  adapter: Pick<ExportPlatformAdapter, 'prepareConversation' | 'releaseConversation'>,
  options: ExportSelectionOptions,
  steps: PreparedExportSteps,
): Promise<void> {
  try {
    if (!(await adapter.prepareConversation?.(options))) await steps.scrollToTop();
    throwIfExportCancelled(options.signal);
    await steps.exportSelection();
  } finally {
    adapter.releaseConversation?.();
  }
}
