import browser from 'webextension-polyfill';

import { logger } from '@/core/services/LoggerService';
import { StorageKeys } from '@/core/types/common';

import { isGeminiSlashPromptSurface } from './slashMatch';
import { type SlashPromptController, startStoredPromptSlashCommand } from './slashPrompt';

const slashPromptFeatureLogger = logger.createChild('SlashPromptFeature');

export interface SlashPromptFeatureOptions {
  pageUrl?: string;
  start?: () => Promise<SlashPromptController>;
}

export interface SlashPromptLifecycle {
  setEnabled: (enabled: boolean) => Promise<void>;
  destroy: () => void;
}

/** Keeps one slash controller alive while enabled and safely absorbs async enable/disable races. */
export function createSlashPromptLifecycle(
  start: () => Promise<SlashPromptController>,
): SlashPromptLifecycle {
  let enabled = false;
  let controller: SlashPromptController | null = null;
  let pendingStart: Promise<void> | null = null;

  const stopController = (): void => {
    controller?.destroy();
    controller = null;
  };

  const setEnabled = async (nextEnabled: boolean): Promise<void> => {
    enabled = nextEnabled;
    if (!enabled) {
      stopController();
      return;
    }
    if (controller) return;
    if (pendingStart) return pendingStart;

    const startAttempt = (async () => {
      const nextController = await start();
      if (enabled && !controller) controller = nextController;
      else nextController.destroy();
    })();
    pendingStart = startAttempt;
    try {
      await startAttempt;
    } finally {
      if (pendingStart === startAttempt) pendingStart = null;
    }
  };

  return {
    setEnabled,
    destroy: () => {
      enabled = false;
      stopController();
    },
  };
}

/**
 * Owns slash completion independently from the Prompt Manager UI.
 *
 * Unsupported surfaces return an inert controller without touching storage.
 */
export async function startSlashPromptFeature(
  options: SlashPromptFeatureOptions = {},
): Promise<SlashPromptController> {
  if (!isGeminiSlashPromptSurface(options.pageUrl)) {
    return { destroy: () => {} };
  }

  const lifecycle = createSlashPromptLifecycle(options.start ?? startStoredPromptSlashCommand);
  let destroyed = false;
  let receivedRuntimeSetting = false;
  let latestReconciliation = Promise.resolve();

  const reconcile = (enabled: boolean): Promise<void> => {
    const reconciliation = lifecycle.setEnabled(enabled).catch((error: unknown) => {
      slashPromptFeatureLogger.warn('Failed to update slash prompt completion state', {
        enabled,
        error,
      });
    });
    latestReconciliation = reconciliation;
    return reconciliation;
  };

  const onStorageChanged = (
    changes: Record<string, browser.Storage.StorageChange>,
    areaName: string,
  ): void => {
    if (destroyed || areaName !== 'sync') return;
    const settingChange = changes[StorageKeys.SLASH_PROMPT_ENABLED];
    if (!settingChange) return;

    receivedRuntimeSetting = true;
    void reconcile(settingChange.newValue !== false);
  };

  browser.storage.onChanged.addListener(onStorageChanged);

  let initiallyEnabled = true;
  try {
    const stored = await browser.storage.sync.get({
      [StorageKeys.SLASH_PROMPT_ENABLED]: true,
    });
    initiallyEnabled = stored[StorageKeys.SLASH_PROMPT_ENABLED] !== false;
  } catch (error) {
    slashPromptFeatureLogger.warn(
      'Failed to read slash prompt setting, continuing with the enabled default',
      { error },
    );
  }

  if (!receivedRuntimeSetting) {
    await reconcile(initiallyEnabled);
  } else {
    // A live change that arrived during the initial read is authoritative.
    await latestReconciliation;
  }

  return {
    destroy: () => {
      if (destroyed) return;
      destroyed = true;
      browser.storage.onChanged.removeListener(onStorageChanged);
      lifecycle.destroy();
    },
  };
}
