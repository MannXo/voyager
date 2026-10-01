/**
 * The popup's writes for a Drive restore, in order: plugin state, synced
 * settings, then folders (plus prompts, starred messages and the timeline
 * hierarchy on Gemini) in one storage write. There is no transaction across
 * them, and the background has already restored highlights by the time they
 * run, so a failure partway reports which parts were restored and which were
 * not instead of a bare "sync failed".
 */
import { restoreBackupableSyncSettings } from '@/core/services/SettingsBackupService';
import { restorePluginState } from '@/features/plugins/storage/pluginState';
import type { TranslationKey } from '@/utils/translations';

export type CloudRestorePart = 'highlights' | 'plugins' | 'settings' | 'folders' | 'prompts';
export type CloudRestoreMode = 'merge' | 'overwrite';

const PART_LABELS: Readonly<Record<CloudRestorePart, TranslationKey>> = {
  highlights: 'storageQuotaHighlights',
  plugins: 'pluginsTitle',
  settings: 'storageQuotaSync',
  folders: 'folder_title',
  prompts: 'promptDataMigration',
};

/** A restore that stopped partway: `restored` landed, `failed` did not. */
export class CloudRestoreError extends Error {
  constructor(
    readonly restored: readonly CloudRestorePart[],
    readonly failed: readonly CloudRestorePart[],
    cause: unknown,
  ) {
    super(cause instanceof Error ? cause.message : String(cause));
    this.name = 'CloudRestoreError';
  }
}

export interface CloudRestoreInput {
  readonly mode: CloudRestoreMode;
  /** The background pulled highlights before the popup's writes. */
  readonly highlightsRestored: boolean;
  /** The Drive plugin-state payload, or undefined when absent or another format. */
  readonly plugins: unknown;
  readonly settings: unknown;
  /** Folders, plus prompts, starred and hierarchy on Gemini: one storage write. */
  readonly storageUpdate: Record<string, unknown>;
  readonly includesPrompts: boolean;
}

interface RestoreStep {
  readonly parts: readonly CloudRestorePart[];
  readonly run: () => Promise<unknown>;
}

/** Run the restore writes in order; on a failure throw `CloudRestoreError`. */
export async function applyCloudRestore(input: CloudRestoreInput): Promise<void> {
  const steps: RestoreStep[] = [];
  if (input.plugins !== undefined) {
    steps.push({ parts: ['plugins'], run: () => restorePluginState(input.plugins, input.mode) });
  }
  steps.push({
    parts: ['settings'],
    run: () => restoreBackupableSyncSettings(input.settings, undefined, input.mode),
  });
  steps.push({
    parts: input.includesPrompts ? ['folders', 'prompts'] : ['folders'],
    run: () => chrome.storage.local.set(input.storageUpdate),
  });

  const restored: CloudRestorePart[] = input.highlightsRestored ? ['highlights'] : [];
  for (const [index, step] of steps.entries()) {
    try {
      await step.run();
    } catch (error) {
      const failed = steps.slice(index).flatMap((pending) => pending.parts);
      throw new CloudRestoreError(restored, failed, error);
    }
    restored.push(...step.parts);
  }
}

/**
 * The status text for a failed restore: which parts landed and which did not
 * when anything was restored, else the plain sync error.
 */
export function cloudRestoreFailureText(
  t: (key: TranslationKey) => string,
  error: unknown,
): string {
  const message = error instanceof Error ? error.message : 'Download failed';
  if (!(error instanceof CloudRestoreError) || error.restored.length === 0) {
    return t('syncError').replace('{error}', message);
  }
  const list = (parts: readonly CloudRestorePart[]) =>
    parts.map((part) => t(PART_LABELS[part])).join(', ');
  return t('syncRestorePartial')
    .replace('{restored}', list(error.restored))
    .replace('{failed}', list(error.failed))
    .replace('{error}', message);
}
