// Static imports to avoid CSP issues with dynamic imports in content scripts
import { StorageKeys } from '@/core/types/common';
import type { AppLanguage } from '@/utils/language';
import type { TranslationKey } from '@/utils/translations';

import { ConversationExportService } from '../../../features/export/services/ConversationExportService';
import {
  getSavedImageExportWidth,
  saveImageExportWidth,
} from '../../../features/export/services/ImageExportPreferenceService';
import {
  SpeakerLabelPreferenceSaver,
  getSavedSpeakerLabelOverrides,
} from '../../../features/export/services/SpeakerLabelPreferenceService';
import { type ExportSpeakerLabels } from '../../../features/export/types/export';
import { ExportDialog } from '../../../features/export/ui/ExportDialog';
import { watchRouteChanges } from '../utils/routeWatcher';
import { ExportPlatformAdapter, resolveExportAdapter } from './adapter/platformAdapters';
import { createConversationCollector } from './conversationCollector';
import { watchConversationMenusForExport } from './conversationMenuExportObserver';
import { waitForElement } from './domWait';
import { startExportEntryGate } from './exportEntryGate';
import {
  languageFromStorageChanges,
  loadExportDictionaries,
  readExportLanguage,
  translateExportOr,
} from './exportLocale';
import { resolveExportLogoAnchor } from './exportLogoAnchor';
import { createExportRunner } from './exportRun';
import { ensureGeneratedUiScreenshotPermission } from './generatedUiScreenshots';
import { mountPersistentExportToolbar } from './persistentExportToolbar';
import { startResponseCopyImageActions } from './responseCopyImageAction';
import { openSidebarConversationForExport } from './sidebarConversationNavigation';

// Platform adapter — resolved once per page load
const exportAdapter: ExportPlatformAdapter = resolveExportAdapter();
ConversationExportService.setExportAdapter(exportAdapter);
const collector = createConversationCollector(exportAdapter);
const exportRunner = createExportRunner({ adapter: exportAdapter, collector });

let activeExportDialog: ExportDialog | null = null;

function ensureDropdownInjected(logoElement: Element): HTMLButtonElement | null {
  // Check if already injected
  const existingWrapper = document.querySelector('.gv-logo-dropdown-wrapper');
  if (existingWrapper) {
    return existingWrapper.querySelector('.gv-export-dropdown-btn') as HTMLButtonElement | null;
  }

  const logo = logoElement as HTMLElement;
  const parent = logo.parentElement;
  if (!parent) return null;

  // Create wrapper that will contain both logo and dropdown
  const wrapper = document.createElement('div');
  wrapper.className = 'gv-logo-dropdown-wrapper';

  // Move logo into wrapper
  parent.insertBefore(wrapper, logo);
  wrapper.appendChild(logo);

  // Create dropdown container
  const dropdown = document.createElement('div');
  dropdown.className = 'gv-logo-dropdown';

  // Create export button inside dropdown
  const btn = document.createElement('button');
  btn.className = 'gv-export-dropdown-btn';
  btn.type = 'button';
  btn.title = 'Export chat history';
  btn.setAttribute('aria-label', 'Export chat history');

  // Export icon
  const iconSpan = document.createElement('span');
  iconSpan.className = 'gv-export-dropdown-icon';
  btn.appendChild(iconSpan);

  // Export text label
  const labelSpan = document.createElement('span');
  labelSpan.className = 'gv-export-dropdown-label';
  labelSpan.textContent = 'Export';
  btn.appendChild(labelSpan);

  dropdown.appendChild(btn);
  wrapper.appendChild(dropdown);

  return btn;
}

/**
 * Mount the export entry point for the current platform.
 *
 * The returned cleanup is intentionally platform-agnostic. Native plugins own
 * their lifecycle and retain this callback; Gemini's native caller may ignore it
 * because its content script owns the page lifetime.
 */
export async function startExportButton(
  options: { signal?: AbortSignal } = {},
): Promise<() => void> {
  const noCleanup = () => {};
  if (options.signal?.aborted) return noCleanup;
  // Check for pending export immediately
  if (exportAdapter.shouldPreloadHistory()) {
    void exportRunner.resumePending();
  }

  const dict = await loadExportDictionaries();
  if (options.signal?.aborted) return noCleanup;
  let lang = await readExportLanguage();
  if (options.signal?.aborted) return noCleanup;
  const t = (key: TranslationKey) => dict[lang]?.[key] ?? dict.en?.[key] ?? key;

  // Platforms without Gemini's logo/menu UI: mount the persistent toolbar directly.
  if (!exportAdapter.shouldPreloadHistory()) {
    let toolbarHandle: ReturnType<typeof mountPersistentExportToolbar> | null = null;
    const mountToolbar = () => {
      toolbarHandle = mountPersistentExportToolbar({
        label: t('pm_export'),
        tooltip: t('exportChatJson'),
        onClick: () => void showExportDialog(dict, lang, { signal: options.signal }),
      });
      toolbarHandle.root.setAttribute('data-gv-platform', exportAdapter.site.id);
    };
    const unmountToolbar = () => {
      exportRunner.cancel();
      toolbarHandle?.remove();
      toolbarHandle = null;
      activeExportDialog?.hide();
      activeExportDialog = null;
    };
    // A host whose chat UI shares the origin with unrelated pages only gets
    // the entry point where a conversation can exist, and loses it again when
    // the SPA navigates away from one.
    const isConversationPage = exportAdapter.isConversationPage;
    let stopEntryGate: () => void;
    if (isConversationPage) {
      stopEntryGate = startExportEntryGate({
        isEligible: () => isConversationPage(document, location.href),
        mount: mountToolbar,
        unmount: unmountToolbar,
        watchRoute: watchRouteChanges,
        root: document.body,
      });
    } else {
      mountToolbar();
      stopEntryGate = unmountToolbar;
    }
    const onStorageChange = (
      changes: Record<string, chrome.storage.StorageChange>,
      area: string,
    ) => {
      if (area !== 'sync') return;
      const next = languageFromStorageChanges(changes);
      if (next) {
        lang = next;
        toolbarHandle?.setText(
          dict[next]?.['pm_export'] ?? dict.en?.['pm_export'] ?? 'Export',
          dict[next]?.['exportChatJson'] ?? dict.en?.['exportChatJson'] ?? 'Export chat history',
        );
      }
    };
    try {
      chrome.storage?.onChanged?.addListener(onStorageChange);
    } catch {}
    return () => {
      stopEntryGate();
      try {
        chrome.storage?.onChanged?.removeListener(onStorageChange);
      } catch {}
    };
  }

  // --- Gemini path: logo anchor + menu injection ---

  watchConversationMenusForExport({
    label: () => translateExportOr(dict, lang, 'exportChatJson', 'Export conversation history'),
    onExport: (context) => {
      if (context.menuType === 'sidebar' && context.trigger) {
        const trigger = context.trigger;
        void (async () => {
          if (
            !(await openSidebarConversationForExport(trigger, () =>
              exportAdapter.getUserSelectors(),
            ))
          )
            return;
          await showExportDialog(dict, lang);
        })();
        return;
      }
      if (context.menuType === 'message') {
        const initialSelectedMessageId = collector.assistantMessageIdFor(context.trigger);
        void showExportDialog(dict, lang, { initialSelectedMessageId });
        return;
      }
      void showExportDialog(dict, lang);
    },
  });
  const copyImageActions = startResponseCopyImageActions({
    dict,
    language: () => lang,
    collector,
    adapter: exportAdapter,
  });

  // The lr26 UI removed the logo entirely; resolveExportLogoAnchor short-circuits
  // there instead of waiting out the full timeout (which delayed this fallback
  // toolbar by several seconds on every conversation load).
  const logo = await resolveExportLogoAnchor(waitForElement);
  if (!logo) {
    // Fallback for lr26+ Gemini UI where the logo has been removed: mount a
    // persistent top-right toolbar so users still have an always-visible
    // export entry point. Menu injection (conversation ⋮ / response ⋮) still
    // runs in parallel via the observers above.
    let toolbarHandle: ReturnType<typeof mountPersistentExportToolbar> | null = null;

    const readToolbarEnabled = async (): Promise<boolean> => {
      try {
        const stored = await new Promise<Record<string, unknown>>((resolve) => {
          try {
            chrome.storage?.sync?.get([StorageKeys.PERSISTENT_EXPORT_TOOLBAR_ENABLED], (items) =>
              resolve(items || {}),
            );
          } catch {
            resolve({});
          }
        });
        const v = stored[StorageKeys.PERSISTENT_EXPORT_TOOLBAR_ENABLED];
        return v !== false;
      } catch {
        return true;
      }
    };

    const ensureToolbarVisibility = (enabled: boolean) => {
      if (enabled && !toolbarHandle) {
        toolbarHandle = mountPersistentExportToolbar({
          label: t('pm_export'),
          tooltip: t('exportChatJson'),
          onClick: () => showExportDialog(dict, lang),
        });
      } else if (!enabled && toolbarHandle) {
        toolbarHandle.remove();
        toolbarHandle = null;
      }
    };

    ensureToolbarVisibility(await readToolbarEnabled());

    const onStorageChange = (
      changes: Record<string, chrome.storage.StorageChange>,
      area: string,
    ) => {
      if (area !== 'sync') return;
      const next = languageFromStorageChanges(changes);
      if (next) {
        lang = next;
        const lbl = dict[next]?.['pm_export'] ?? dict.en?.['pm_export'] ?? 'Export';
        const ttl =
          dict[next]?.['exportChatJson'] ?? dict.en?.['exportChatJson'] ?? 'Export chat history';
        toolbarHandle?.setText(lbl, ttl);
        copyImageActions.relabel();
      }
      const toolbarChange = changes[StorageKeys.PERSISTENT_EXPORT_TOOLBAR_ENABLED];
      if (toolbarChange && 'newValue' in toolbarChange) {
        ensureToolbarVisibility(toolbarChange.newValue !== false);
      }
    };
    try {
      chrome.storage?.onChanged?.addListener(onStorageChange);
      window.addEventListener(
        'beforeunload',
        () => {
          try {
            chrome.storage?.onChanged?.removeListener(onStorageChange);
          } catch {}
        },
        { once: true },
      );
    } catch {}
    return () => {};
  }
  const btn = ensureDropdownInjected(logo);
  if (!btn) return () => {};
  if ((btn as Element & { _gvBound?: boolean })._gvBound) return () => {};
  (btn as Element & { _gvBound?: boolean })._gvBound = true;

  // Swallow events on the button to avoid parent navigation (logo click -> /app)
  const swallow = (e: Event) => {
    try {
      e.preventDefault();
    } catch {}
    try {
      e.stopPropagation();
    } catch {}
  };
  // Capture low-level press events to avoid parent logo navigation, but do NOT capture 'click'
  ['pointerdown', 'mousedown', 'pointerup', 'mouseup'].forEach((type) => {
    try {
      btn.addEventListener(type, swallow, true);
    } catch {}
  });

  const title = t('exportChatJson');
  const labelText = t('pm_export');
  btn.title = title;
  btn.setAttribute('aria-label', title);

  // Update label text
  const labelEl = btn.querySelector('.gv-export-dropdown-label');
  if (labelEl) labelEl.textContent = labelText;

  // listen for runtime language changes
  const storageChangeHandler = (
    changes: Record<string, chrome.storage.StorageChange>,
    area: string,
  ) => {
    if (area !== 'sync') return;
    const next = languageFromStorageChanges(changes);
    if (next) {
      lang = next;
      const ttl =
        dict[next]?.['exportChatJson'] ?? dict.en?.['exportChatJson'] ?? 'Export chat history';
      btn.title = ttl;
      btn.setAttribute('aria-label', ttl);

      // Update visible label text
      const lbl = btn.querySelector('.gv-export-dropdown-label');
      if (lbl) lbl.textContent = dict[next]?.['pm_export'] ?? dict.en?.['pm_export'] ?? 'Export';

      copyImageActions.relabel();
    }
  };

  try {
    chrome.storage?.onChanged?.addListener(storageChangeHandler);

    // Cleanup listener on page unload to prevent memory leaks
    window.addEventListener(
      'beforeunload',
      () => {
        try {
          chrome.storage?.onChanged?.removeListener(storageChangeHandler);
        } catch (e) {
          console.error('[Gemini Voyager] Failed to remove storage listener on unload:', e);
        }
      },
      { once: true },
    );
  } catch {}

  btn.addEventListener('click', (ev) => {
    // Stop parent navigation, but allow this handler to run
    swallow(ev);
    try {
      // Show export dialog instead of directly exporting
      showExportDialog(dict, lang);
    } catch (err) {
      try {
        console.error('Gemini Voyager export failed', err);
      } catch {}
    }
  });

  // ─── DOM recovery (resize / print) ─────────────────────────────────────
  // Gemini may re-render the logo/header area (and thus destroy the wrapper
  // + export button) during window resize or window.print().  We use a
  // single debounced handler that fires on resize, afterprint, and our own
  // gv-print-cleanup event.  It checks whether the button is still attached
  // and re-injects if not.
  let currentBtn: HTMLButtonElement = btn;
  let reinjectTimer: ReturnType<typeof setTimeout> | null = null;

  const reinjectExportButtonIfNeeded = () => {
    // Debounce: Gemini fires many mutations during resize; wait until it
    // settles before we attempt re-injection.
    if (reinjectTimer !== null) clearTimeout(reinjectTimer);
    reinjectTimer = setTimeout(() => {
      reinjectTimer = null;
      try {
        // If the button is still in the document, nothing to do.
        if (document.body.contains(currentBtn)) return;

        // Remove stale wrapper if it somehow survived but lost the button.
        const staleWrapper = document.querySelector('.gv-logo-dropdown-wrapper');
        if (staleWrapper) staleWrapper.remove();

        // Re-find the logo element (Gemini may have created a fresh one).
        const newLogo =
          document.querySelector('[data-test-id="logo"]') ?? document.querySelector('.logo');
        if (!newLogo) return;

        const newBtn = ensureDropdownInjected(newLogo);
        if (!newBtn) return;
        if ((newBtn as Element & { _gvBound?: boolean })._gvBound) return;
        (newBtn as Element & { _gvBound?: boolean })._gvBound = true;

        // Re-bind all event listeners on the fresh button.
        ['pointerdown', 'mousedown', 'pointerup', 'mouseup'].forEach((type) => {
          try {
            newBtn.addEventListener(type, swallow, true);
          } catch {}
        });

        const freshT = (key: TranslationKey) => dict[lang]?.[key] ?? dict.en?.[key] ?? key;
        const ttl = freshT('exportChatJson');
        const lbl = freshT('pm_export');
        newBtn.title = ttl;
        newBtn.setAttribute('aria-label', ttl);
        const labelEl = newBtn.querySelector('.gv-export-dropdown-label');
        if (labelEl) labelEl.textContent = lbl;

        newBtn.addEventListener('click', (ev) => {
          swallow(ev);
          try {
            showExportDialog(dict, lang);
          } catch (err) {
            try {
              console.error('Gemini Voyager export failed', err);
            } catch {}
          }
        });

        // Update our tracking reference so the next check uses the new element.
        currentBtn = newBtn;
      } catch (e) {
        try {
          console.debug('[Gemini Voyager] Export button re-injection failed:', e);
        } catch {}
      }
    }, 800);
  };

  window.addEventListener('resize', reinjectExportButtonIfNeeded);
  window.addEventListener('gv-print-cleanup', reinjectExportButtonIfNeeded);
  window.addEventListener('afterprint', reinjectExportButtonIfNeeded);

  return () => {
    if (reinjectTimer !== null) clearTimeout(reinjectTimer);
    window.removeEventListener('resize', reinjectExportButtonIfNeeded);
    window.removeEventListener('gv-print-cleanup', reinjectExportButtonIfNeeded);
    window.removeEventListener('afterprint', reinjectExportButtonIfNeeded);
    try {
      chrome.storage?.onChanged?.removeListener(storageChangeHandler);
    } catch {}
  };
}

async function showExportDialog(
  dict: Record<AppLanguage, Record<string, string>>,
  lang: AppLanguage,
  options?: {
    initialSelectedMessageId?: string | null;
    signal?: AbortSignal;
  },
): Promise<void> {
  if (options?.signal?.aborted) return;
  const t = (key: TranslationKey) => dict[lang]?.[key] ?? dict.en?.[key] ?? key;
  const speakerDefaults: ExportSpeakerLabels = {
    user: t('export_speaker_user_default'),
    assistant: t('export_speaker_assistant_default'),
  };
  const [initialImageWidth, savedSpeakerLabelOverrides] = await Promise.all([
    getSavedImageExportWidth(),
    getSavedSpeakerLabelOverrides(),
  ]);
  if (options?.signal?.aborted) return;

  // We defer collection until after the export sequence (scrolling/refresh checks)

  const dialog = new ExportDialog();
  const speakerLabelPreferenceSaver = new SpeakerLabelPreferenceSaver();
  activeExportDialog = dialog;

  dialog.show({
    onExport: (format, fontSize, imageWidth, usePromptAsTurnHeading, speakerLabels) =>
      exportRunner.run(
        {
          format,
          fontSize,
          imageWidth,
          usePromptAsTurnHeading,
          speakerLabels,
          initialSelectedMessageId: options?.initialSelectedMessageId || undefined,
        },
        { dict, lang },
        async (signal) => {
          await speakerLabelPreferenceSaver.flush();
          if (signal.aborted) throw new DOMException('Export cancelled', 'AbortError');
          await ensureGeneratedUiScreenshotPermission();
          if (format === 'image') {
            await saveImageExportWidth(imageWidth);
          }
        },
      ),

    onCancel: () => {
      void speakerLabelPreferenceSaver.flush();
      if (activeExportDialog === dialog) activeExportDialog = null;
    },
    onSpeakerLabelOverridesChange: (speakerLabelOverrides) => {
      speakerLabelPreferenceSaver.schedule(speakerLabelOverrides);
    },
    initialImageWidth,
    showPromptHeadingOption: true,
    initialSpeakerLabelOverrides: savedSpeakerLabelOverrides,
    speakerNames: {
      title: t('export_speaker_names'),
      userLabel: t('export_speaker_user_label'),
      assistantLabel: t('export_speaker_ai_label'),
      userDefault: speakerDefaults.user,
      assistantDefault: speakerDefaults.assistant,
    },
    translations: {
      title: t('export_dialog_title'),
      selectFormat: t('export_dialog_select'),
      warning: t('export_dialog_warning'),
      safariCmdpHint: t('export_dialog_safari_cmdp_hint'),
      safariMarkdownHint: t('export_dialog_safari_markdown_hint'),
      cancel: t('pm_cancel'),
      export: t('pm_export'),
      fontSizeLabel: t('export_fontsize_label'),
      fontSizePreview: t('export_fontsize_preview'),
      imageWidthLabel: t('export_image_width_label'),
      imageWidthNarrow: t('export_image_width_narrow'),
      imageWidthMedium: t('export_image_width_medium'),
      imageWidthWide: t('export_image_width_wide'),
      promptHeadingLabel: t('export_markdown_prompt_heading'),
      promptHeadingHint: t('export_markdown_prompt_heading_hint'),
      formatDescriptions: {
        json: t('export_format_json_description'),
        markdown: t('export_format_markdown_description'),
        pdf: t('export_format_pdf_description'),
        image: t('export_format_image_description'),
      },
    },
  });
}

export default { startExportButton };
