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
import { createResearchPackClient } from '@/features/researchPack/services/packMessages';
import { createEmptyPack, setInstruction } from '@/features/researchPack/services/packModel';
import type { ResearchPackOp } from '@/features/researchPack/services/packOps';
import {
  type ResearchPackStore,
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

function resolveCurrentKey(): Promise<string> {
  return resolveResearchPackStorageKey({
    isIsolationEnabled: () =>
      accountIsolationService.isIsolationEnabled({ pageUrl: window.location.href }),
    resolveAccountKey,
  });
}

/** Reads come straight from storage; every edit goes to the background owner. */
function createChromeClient(): ResearchPackStore {
  return createResearchPackClient({
    area: {
      get: (key) => chrome.storage.local.get(key),
      set: (items) => chrome.storage.local.set(items),
    },
    send: (request) => chrome.runtime.sendMessage(request),
  });
}

const ADD_OUTCOME_MESSAGES = {
  added: 'researchPackAdded',
  duplicate: 'researchPackDuplicate',
  full: 'researchPackFull',
  empty: 'researchPackCaptureFailed',
} as const satisfies Record<AddItemOutcome, Parameters<typeof getTranslationSync>[0]>;

export interface StartResearchPackOptions {
  store?: ResearchPackStore;
  resolveKey?: () => Promise<string>;
}

export function startResearchPack(options: StartResearchPackOptions = {}): StopNativeFeature {
  const store = options.store ?? createChromeClient();
  const resolveKey = options.resolveKey ?? resolveCurrentKey;
  const t = getTranslationSync;
  let stopped = false;
  let pack: ResearchPack = createEmptyPack();
  let observerTimer: ReturnType<typeof setTimeout> | null = null;
  const flashTimers = new Set<ReturnType<typeof setTimeout>>();
  const pendingDownloads = new Map<ReturnType<typeof setTimeout>, string>();

  const markdown = (): string => buildResearchPackMarkdown(pack, Date.now());
  /** What Copy, Download and Insert hand over: the stored items plus the typed instruction. */
  const exportMarkdown = (): string => {
    const now = Date.now();
    return buildResearchPackMarkdown(setInstruction(pack, panel.instructionDraft(), now), now);
  };

  const reportError = (error: unknown): void => {
    if (stopped || isExtensionContextInvalidatedError(error)) return;
    panel.notify(t('researchPackSaveFailed'), 'error');
  };

  const apply = async (op: ResearchPackOp): Promise<{ outcome: AddItemOutcome | null } | null> => {
    try {
      const update = await store.apply(await resolveKey(), op);
      if (stopped) return null;
      pack = update.pack;
      panel.render(pack, markdown());
      return { outcome: update.outcome };
    } catch (error) {
      reportError(error);
      return null;
    }
  };

  const refresh = async (): Promise<void> => {
    const next = await store.load(await resolveKey());
    if (stopped) return;
    pack = next;
    panel.render(pack, markdown());
  };

  const panel = createResearchPackPanel(t, {
    onMove: (id, delta) => void apply({ kind: 'move', id, delta }),
    onRemove: (id) => void apply({ kind: 'remove', id }),
    onInstructionChange: (instruction) => apply({ kind: 'setInstruction', instruction }),
    onClear: () => void apply({ kind: 'clear' }),
    onCopy: () => {
      void navigator.clipboard
        .writeText(exportMarkdown())
        .then(() => panel.notify(t('researchPackCopied')))
        .catch(() => panel.notify(t('researchPackCopyFailed'), 'error'));
    },
    onDownload: () => {
      const url = URL.createObjectURL(
        new Blob([exportMarkdown()], { type: 'text/markdown;charset=utf-8' }),
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
      if (!input || !insertTextIntoChatInput(exportMarkdown(), input)) {
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
    const outcome = (await apply({ kind: 'add', draft }))?.outcome;
    if (!outcome || stopped) return;
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
