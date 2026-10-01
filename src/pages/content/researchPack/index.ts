/**
 * Research Pack (Gemini).
 *
 * Users pick answers (or a selected part) into a pack, add an instruction,
 * and carry the assembled Markdown to another model by copying, downloading,
 * or inserting it into a composer. Everything is user-initiated: answers are
 * read only on an "Add to pack" click, and insertion fills the composer
 * without sending.
 */
import {
  accountIsolationService,
  detectAccountContextFromDocument,
} from '@/core/services/AccountIsolationService';
import { StorageKeys } from '@/core/types/common';
import { isExtensionContextInvalidatedError } from '@/core/utils/extensionContext';
import {
  buildResearchPackFilename,
  buildResearchPackMarkdown,
} from '@/features/researchPack/services/markdown';
import {
  addItem,
  clearItems,
  createEmptyPack,
  moveItem,
  removeItem,
  setInstruction,
} from '@/features/researchPack/services/packModel';
import {
  type ResearchPackStore,
  type ResearchPackUpdate,
  createResearchPackStore,
  isResearchPackStorageKey,
  resolveResearchPackStorageKey,
} from '@/features/researchPack/services/packStore';
import type { AddItemOutcome, ResearchPack } from '@/features/researchPack/services/types';
import { getTranslationSync } from '@/utils/i18n';

import { findChatInput, insertTextIntoChatInput } from '../chatInput';
import type { StopNativeFeature } from '../featureLifecycle';
import { createResearchPackPanel } from './panel';
import {
  ADD_BUTTON_CLASS,
  ensureAddButtons,
  removeAddButtons,
  updateAddButtonLabels,
} from './turnButtons';
import { captureAnswer } from './turnCapture';

const OBSERVER_DEBOUNCE_MS = 300;
const ADDED_FLASH_MS = 1500;
const DOWNLOAD_URL_REVOKE_MS = 1000;

export function isResearchPackEnabledValue(value: unknown): boolean {
  return value === true;
}

async function resolveAccountKey(): Promise<string> {
  const context = detectAccountContextFromDocument(window.location.href, document);
  const scope = await accountIsolationService.resolveAccountScope({
    pageUrl: window.location.href,
    routeUserId: context.routeUserId,
    email: context.email,
  });
  return scope.accountKey;
}

function createChromeLocalStore(): ResearchPackStore {
  return createResearchPackStore({
    area: {
      get: (key) => chrome.storage.local.get(key),
      set: (items) => chrome.storage.local.set(items),
    },
    resolveKey: () =>
      resolveResearchPackStorageKey({
        isIsolationEnabled: () =>
          accountIsolationService.isIsolationEnabled({ pageUrl: window.location.href }),
        resolveAccountKey,
      }),
  });
}

const ADD_OUTCOME_MESSAGES = {
  added: 'researchPackAdded',
  duplicate: 'researchPackDuplicate',
  full: 'researchPackFull',
  empty: 'researchPackCaptureFailed',
} as const satisfies Record<AddItemOutcome, Parameters<typeof getTranslationSync>[0]>;

export function startResearchPack(options: { store?: ResearchPackStore } = {}): StopNativeFeature {
  const store = options.store ?? createChromeLocalStore();
  const t = getTranslationSync;
  let stopped = false;
  let pack: ResearchPack = createEmptyPack();
  let observerTimer: ReturnType<typeof setTimeout> | null = null;
  const flashTimers = new Set<ReturnType<typeof setTimeout>>();
  const pendingDownloads = new Map<ReturnType<typeof setTimeout>, string>();

  const markdown = (): string => buildResearchPackMarkdown(pack, Date.now());

  const reportError = (error: unknown): void => {
    if (stopped || isExtensionContextInvalidatedError(error)) return;
    panel.notify(t('researchPackSaveFailed'), 'error');
  };

  const apply = async <T>(
    transform: (current: ResearchPack) => ResearchPackUpdate<T>,
  ): Promise<T | null> => {
    try {
      const update = await store.update(transform);
      if (stopped) return null;
      pack = update.pack;
      panel.render(pack, markdown());
      return update.result;
    } catch (error) {
      reportError(error);
      return null;
    }
  };

  const refresh = async (): Promise<void> => {
    const next = await store.load();
    if (stopped) return;
    pack = next;
    panel.render(pack, markdown());
  };

  const panel = createResearchPackPanel(t, {
    onMove: (id, delta) =>
      void apply((current) => ({ pack: moveItem(current, id, delta, Date.now()), result: null })),
    onRemove: (id) =>
      void apply((current) => ({ pack: removeItem(current, id, Date.now()), result: null })),
    onInstructionChange: (instruction) =>
      void apply((current) => ({
        pack: setInstruction(current, instruction, Date.now()),
        result: null,
      })),
    onClear: () =>
      void apply((current) => ({ pack: clearItems(current, Date.now()), result: null })),
    onCopy: () => {
      void navigator.clipboard
        .writeText(markdown())
        .then(() => panel.notify(t('researchPackCopied')))
        .catch(() => panel.notify(t('researchPackCopyFailed'), 'error'));
    },
    onDownload: () => {
      const url = URL.createObjectURL(
        new Blob([markdown()], { type: 'text/markdown;charset=utf-8' }),
      );
      const anchor = document.createElement('a');
      anchor.href = url;
      anchor.download = buildResearchPackFilename(Date.now());
      // Firefox only downloads from an anchor that is in the document.
      anchor.hidden = true;
      document.body.appendChild(anchor);
      anchor.click();
      anchor.remove();
      const timer = setTimeout(() => {
        pendingDownloads.delete(timer);
        URL.revokeObjectURL(url);
      }, DOWNLOAD_URL_REVOKE_MS);
      pendingDownloads.set(timer, url);
    },
    onInsert: () => {
      // Fill the composer only. The user reviews the pack and sends it.
      const input = findChatInput();
      if (!input || !insertTextIntoChatInput(markdown(), input)) {
        panel.notify(t('researchPackNoComposer'), 'error');
        return;
      }
      panel.close();
      panel.notify(t('researchPackInserted'));
    },
  });

  const onAdd = async (
    host: HTMLElement,
    selectedText: string,
    button: HTMLButtonElement,
  ): Promise<void> => {
    let draft;
    try {
      draft = captureAnswer(host, selectedText);
    } catch {
      panel.notify(t('researchPackCaptureFailed'), 'error');
      return;
    }
    const outcome = await apply((current) => {
      const next = addItem(current, draft, Date.now());
      return { pack: next.pack, result: next.outcome };
    });
    if (outcome === null || stopped) return;
    panel.notify(t(ADD_OUTCOME_MESSAGES[outcome]), outcome === 'added' ? 'ok' : 'error');
    if (outcome === 'added') {
      button.dataset.state = 'added';
      const timer = setTimeout(() => {
        flashTimers.delete(timer);
        delete button.dataset.state;
      }, ADDED_FLASH_MS);
      flashTimers.add(timer);
    }
  };

  const addButtonOptions = {
    label: t('researchPackAdd'),
    onAdd: (host: HTMLElement, selectedText: string, button: HTMLButtonElement) =>
      void onAdd(host, selectedText, button),
  };

  const scan = (): void => {
    if (stopped) return;
    ensureAddButtons(document, addButtonOptions);
  };

  const observer = new MutationObserver((mutations) => {
    // Our own button insertions and panel re-renders need no rescan.
    const relevant = mutations.some(
      (mutation) =>
        !(mutation.target instanceof Element) ||
        !(
          mutation.target.closest('.gv-rp-root') ||
          mutation.target.classList.contains(ADD_BUTTON_CLASS)
        ),
    );
    if (!relevant) return;
    if (observerTimer !== null) clearTimeout(observerTimer);
    observerTimer = setTimeout(() => {
      observerTimer = null;
      scan();
    }, OBSERVER_DEBOUNCE_MS);
  });

  const onStorageChanged = (
    changes: Record<string, chrome.storage.StorageChange>,
    areaName: string,
  ): void => {
    if (areaName === 'local' && Object.keys(changes).some(isResearchPackStorageKey)) {
      void refresh().catch(reportError);
    }
    if ((areaName === 'sync' || areaName === 'local') && changes[StorageKeys.LANGUAGE]) {
      addButtonOptions.label = t('researchPackAdd');
      updateAddButtonLabels(document, addButtonOptions.label);
      panel.relabel();
    }
  };

  document.body.appendChild(panel.root);
  panel.render(pack, markdown());
  scan();
  observer.observe(document.body, { childList: true, subtree: true });
  chrome.storage.onChanged.addListener(onStorageChanged);
  void refresh().catch(reportError);

  return () => {
    if (stopped) return;
    stopped = true;
    observer.disconnect();
    if (observerTimer !== null) clearTimeout(observerTimer);
    observerTimer = null;
    for (const timer of flashTimers) clearTimeout(timer);
    flashTimers.clear();
    for (const [timer, url] of pendingDownloads) {
      clearTimeout(timer);
      URL.revokeObjectURL(url);
    }
    pendingDownloads.clear();
    try {
      chrome.storage.onChanged.removeListener(onStorageChanged);
    } catch {
      // The extension may have been reloaded while the page stayed open.
    }
    panel.destroy();
    removeAddButtons(document);
  };
}
