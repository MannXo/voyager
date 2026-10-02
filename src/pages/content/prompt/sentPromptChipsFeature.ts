import browser from 'webextension-polyfill';

import { logger } from '@/core/services/LoggerService';
import { promptStorageService } from '@/core/services/StorageService';
import { StorageKeys } from '@/core/types/common';
import type { PromptIdentity } from '@/features/prompt/model/promptTextMatch';

import { type SentPromptChipsController, startSentPromptChips } from './SentPromptChips';
import { isGeminiSlashPromptSurface } from './slashMatch';

const sentPromptChipsLogger = logger.createChild('SentPromptChips');

function toIdentities(value: unknown): PromptIdentity[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => {
    if (!item || typeof item !== 'object') return [];
    const { id, name, text } = item as Record<string, unknown>;
    if (typeof id !== 'string' || typeof name !== 'string' || typeof text !== 'string') return [];
    return [{ id, name, text }];
  });
}

/**
 * Owns the collapse of sent prompts, on the same surfaces that can insert one
 * through slash completion. Anywhere else there is no token to restore, so the
 * observer is never attached.
 */
export async function startSentPromptChipsFeature(
  options: { pageUrl?: string } = {},
): Promise<SentPromptChipsController> {
  const inert: SentPromptChipsController = {
    setPrompts: () => {},
    refresh: () => {},
    destroy: () => {},
  };
  if (!isGeminiSlashPromptSurface(options.pageUrl)) return inert;

  let prompts: PromptIdentity[] = [];
  try {
    const stored = await promptStorageService.get<unknown>(StorageKeys.PROMPT_ITEMS);
    if (stored.success) prompts = toIdentities(stored.data);
  } catch (error) {
    sentPromptChipsLogger.warn('Failed to read saved prompts; sent prompts stay expanded', {
      error,
    });
  }

  const controller = startSentPromptChips({ prompts });
  let destroyed = false;

  const onStorageChanged = (
    changes: Record<string, browser.Storage.StorageChange>,
    areaName: string,
  ): void => {
    if (destroyed || areaName !== 'local') return;
    const change = changes[StorageKeys.PROMPT_ITEMS];
    if (!change) return;
    // A renamed or deleted prompt must stop labelling turns it no longer
    // explains, so the whole list is replaced rather than merged.
    controller.setPrompts(toIdentities(change.newValue));
  };

  browser.storage.onChanged.addListener(onStorageChanged);

  return {
    setPrompts: controller.setPrompts,
    refresh: controller.refresh,
    destroy: () => {
      if (destroyed) return;
      destroyed = true;
      browser.storage.onChanged.removeListener(onStorageChanged);
      controller.destroy();
    },
  };
}
