/**
 * One-time guide that points at the folder section in ChatGPT's sidebar, on the
 * shared coachmark (`src/pages/content/coachmark`). It is checked after every
 * sidebar change, never on a timer. It shows only once the section is in the
 * page and the folders have loaded, and never over an open menu or dialog; until
 * then it waits for the next sidebar change. Seen state is the shared coachmark
 * list, so it shows once per user. Turning the plugin off closes an open guide
 * without marking it seen.
 */
import { detectRTL } from '@/core/utils/rtl';
import type { PluginScope } from '@/features/plugins/runtime/pluginScope';
import { type CoachmarkResult, hasSeenCoachmark, showCoachmark } from '@/pages/content/coachmark';
import { getTranslationSyncUnsafe as t } from '@/utils/i18n';

import { FOLDER_PICKER_CLASS } from './chatgptFolderPicker';

export const CHATGPT_FOLDERS_GUIDE_ID = 'chatgpt-folders-sidebar-intro-v1';
/** `document.dispatchEvent(new Event(...))` shows the guide again, seen or not. */
export const CHATGPT_FOLDERS_GUIDE_DEBUG_EVENT = 'gv:debug:chatgptFoldersCoachmark';

const FOLDER_ICON =
  '<svg viewBox="0 -960 960 960" fill="currentColor" aria-hidden="true"><path d="M160-160q-33 0-56.5-23.5T80-240v-480q0-33 23.5-56.5T160-800h240l80 80h320q33 0 56.5 23.5T880-640v400q0 33-23.5 56.5T800-160H160Z"/></svg>';

/** ChatGPT's Radix menus and dialogs, plus this plugin's picker and Gemini's confirm. */
const OVERLAY_SELECTOR = [
  '[role="menu"]',
  '[role="dialog"]',
  '[role="alertdialog"]',
  `.${FOLDER_PICKER_CLASS}`,
  '.gv-folder-confirm-dialog',
].join(',');

/** Whether a menu or dialog is open on the page. Reads only. */
export function hasOpenOverlay(doc: Document = document): boolean {
  for (const element of doc.querySelectorAll<HTMLElement>(OVERLAY_SELECTOR)) {
    if (element.closest('.gv-coach')) continue;
    if (element.hidden || element.closest('[aria-hidden="true"], [data-state="closed"]')) continue;
    return true;
  }
  return false;
}

export interface FolderGuideTarget {
  /** The element the bubble points at, or null while the section is out of the page. */
  anchor(): HTMLElement | null;
  /** True once the folders have loaded. */
  ready(): boolean;
  /** True while the section's own menu or name field is open. */
  busy(): boolean;
}

type GuideState = 'idle' | 'pending' | 'showing' | 'done';

export class ChatGptFolderGuide {
  private state: GuideState = 'idle';
  private readonly open = new Set<AbortController>();

  constructor(
    private readonly scope: PluginScope,
    private readonly target: FolderGuideTarget,
  ) {
    scope.effect(
      () => () => {
        this.state = 'done';
        for (const controller of this.open) controller.abort();
        this.open.clear();
      },
      'chatgpt-folders:guide',
    );
    scope.on(document, CHATGPT_FOLDERS_GUIDE_DEBUG_EVENT, () => void this.present(false));
  }

  /** Whether the guide could show now. Reads only. */
  isEligible(): boolean {
    if (this.scope.isDisposed || !this.target.ready() || this.target.busy()) return false;
    return !!this.target.anchor()?.isConnected && !hasOpenOverlay();
  }

  /** Called after every sidebar change. */
  check(): void {
    if (this.state === 'showing') {
      // ChatGPT dropped the section: close without marking it seen and wait for it.
      if (!this.target.anchor()?.isConnected)
        for (const controller of this.open) controller.abort();
      return;
    }
    if (this.state !== 'idle' || !this.isEligible()) return;
    this.state = 'pending';
    void this.run();
  }

  private async run(): Promise<void> {
    const seen = await hasSeenCoachmark(CHATGPT_FOLDERS_GUIDE_ID);
    if (this.state !== 'pending') return;
    if (seen) {
      this.state = 'done';
      return;
    }
    // A menu may have opened while the seen list loaded.
    if (!this.isEligible()) {
      this.state = 'idle';
      return;
    }
    this.state = 'showing';
    const result = await this.present(true);
    if (this.state !== 'showing') return;
    // Skipped means it never showed or was interrupted: try again on a later change.
    this.state = result === 'skipped' ? 'idle' : 'done';
  }

  private async present(once: boolean): Promise<CoachmarkResult> {
    if (this.scope.isDisposed) return 'skipped';
    const controller = new AbortController();
    this.open.add(controller);
    try {
      return await showCoachmark({
        id: CHATGPT_FOLDERS_GUIDE_ID,
        once,
        icon: FOLDER_ICON,
        title: t('chatgptFoldersCoachmarkTitle'),
        body: t('chatgptFoldersCoachmarkBody'),
        anchor: () => this.target.anchor(),
        dismissLabel: t('coachmarkDismiss'),
        closeLabel: t('coachmarkClose'),
        placement: 'top',
        rtl: detectRTL(),
        signal: controller.signal,
      });
    } finally {
      this.open.delete(controller);
    }
  }
}
