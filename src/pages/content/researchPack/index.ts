/**
 * Research Pack (Gemini).
 *
 * Users pick answers (or a selected part) into a pack, add an instruction,
 * and carry the assembled Markdown to another model by copying, downloading,
 * or inserting it into a composer. Everything is user-initiated: answers are
 * read only on an "Add to pack" click, and insertion fills the composer
 * without sending.
 */
import { accountIsolationService } from '@/core/services/AccountIsolationService';
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
} from '@/features/researchPack/services/packStore';
import type { AddItemOutcome, ResearchPack } from '@/features/researchPack/services/types';
import { getTranslationSync } from '@/utils/i18n';

import { findChatInput, insertTextIntoChatInput } from '../chatInput';
import type { StopNativeFeature } from '../featureLifecycle';
import { createResearchPackPanel } from './panel';
import {
  type ResearchPackScopeContext,
  createResearchPackKeyResolver,
  isDifferentAccount,
  isIsolationSettingChange,
  readScopeContext,
} from './scope';
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

function createChromeKeyResolver(): (context: ResearchPackScopeContext) => Promise<string> {
  return createResearchPackKeyResolver({
    getSync: (keys) => chrome.storage.sync.get(keys),
    resolveAccountScope: (hints) => accountIsolationService.resolveAccountScope(hints),
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
  /** Storage key for an account context; rejects when the scope cannot be known. */
  resolveKey?: (context: ResearchPackScopeContext) => Promise<string>;
}

/**
 * The pack scope an action is bound to. The key is resolved from the context
 * captured at bind time, so later account switches cannot redirect it.
 */
interface BoundScope {
  readonly context: ResearchPackScopeContext;
  readonly key: Promise<string>;
}

export function startResearchPack(options: StartResearchPackOptions = {}): StopNativeFeature {
  const store = options.store ?? createChromeClient();
  const resolveKey = options.resolveKey ?? createChromeKeyResolver();
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

  const bind = (context: ResearchPackScopeContext): BoundScope => {
    const key = resolveKey(context);
    key.catch(() => undefined);
    return { context, key };
  };
  let scope = bind(readScopeContext());
  // Results for a scope that is no longer shown are dropped, not rendered.
  const isCurrent = (bound: BoundScope): boolean => !stopped && bound === scope;

  const show = (next: ResearchPack, replaceInstruction = false): void => {
    pack = next;
    panel.render(pack, markdown(), { replaceInstruction });
  };

  /** Apply `op` to the pack of `bound`, whichever scope is on screen by the time it lands. */
  const applyIn = async (
    bound: BoundScope,
    op: ResearchPackOp,
  ): Promise<{ outcome: AddItemOutcome | null } | null> => {
    try {
      const update = await store.apply(await bound.key, op);
      if (isCurrent(bound)) show(update.pack);
      return { outcome: update.outcome };
    } catch (error) {
      reportError(error);
      return null;
    }
  };

  /** Load the pack for `bound`. An unresolvable scope stays empty: no read, no write. */
  const loadScope = async (bound: BoundScope, replaceInstruction: boolean): Promise<void> => {
    try {
      const loaded = await store.load(await bound.key);
      if (isCurrent(bound)) show(loaded, replaceInstruction);
    } catch {
      // Fail closed and quietly: the panel stays empty, and the next user
      // action on this scope reports the failure.
    }
  };

  /**
   * Rebind to the page's current account or isolation setting. Unsaved typing
   * goes to the scope it was typed in, the old content is hidden at once, and
   * the new scope's pack loads in its place.
   */
  const switchScope = (): void => {
    const previous = scope;
    const pending = panel.takePendingInstruction();
    if (pending !== null) void applyIn(previous, { kind: 'setInstruction', instruction: pending });
    scope = bind(readScopeContext());
    show(createEmptyPack(), true);
    void loadScope(scope, true);
  };

  /** The scope for something the user does now; rebinds first if the page changed accounts. */
  const scopeForAction = (): { bound: BoundScope; switched: boolean } => {
    if (!isDifferentAccount(scope.context, readScopeContext())) {
      return { bound: scope, switched: false };
    }
    switchScope();
    return { bound: scope, switched: true };
  };

  /** Panel edits and exports act on what is on screen; after a switch they stop and say so. */
  const panelScope = (): BoundScope | null => {
    const { bound, switched } = scopeForAction();
    if (!switched) return bound;
    panel.notify(t('researchPackScopeChanged'), 'error');
    return null;
  };

  const applyFromPanel = (op: ResearchPackOp): void => {
    const bound = panelScope();
    if (bound) void applyIn(bound, op);
  };

  const panel = createResearchPackPanel(t, {
    onMove: (id, delta) => applyFromPanel({ kind: 'move', id, delta }),
    onRemove: (id) => applyFromPanel({ kind: 'remove', id }),
    // The text belongs to the pack on screen, so it is saved there.
    onInstructionChange: (instruction) => applyIn(scope, { kind: 'setInstruction', instruction }),
    onClear: () => applyFromPanel({ kind: 'clear' }),
    onCopy: () => {
      if (!panelScope()) return;
      void navigator.clipboard
        .writeText(exportMarkdown())
        .then(() => panel.notify(t('researchPackCopied')))
        .catch(() => panel.notify(t('researchPackCopyFailed'), 'error'));
    },
    onDownload: () => {
      if (!panelScope()) return;
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
      if (!panelScope()) return;
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
    // The answer belongs to the page as it is now, so a switched scope is the right one.
    const outcome = (await applyIn(scopeForAction().bound, { kind: 'add', draft }))?.outcome;
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
    // In-app navigation can move the page to another /u/<index>/ account.
    if (isDifferentAccount(scope.context, readScopeContext())) switchScope();
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
      void loadScope(scope, false);
    }
    if (isIsolationSettingChange(changes, areaName, window.location.href)) {
      switchScope();
    }
    if ((areaName === 'sync' || areaName === 'local') && changes[StorageKeys.LANGUAGE]) {
      addButtonOptions.label = t('researchPackAdd');
      updateAddButtonLabels(document, addButtonOptions.label);
      panel.relabel();
    }
  };

  document.body.appendChild(panel.root);
  show(pack, true);
  scan();
  observer.observe(document.body, { childList: true, subtree: true });
  chrome.storage.onChanged.addListener(onStorageChanged);
  void loadScope(scope, true);

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
