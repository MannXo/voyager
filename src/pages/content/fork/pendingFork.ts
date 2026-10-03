import browser from 'webextension-polyfill';

import { isExtensionContextInvalidatedError } from '@/core/utils/extensionContext';

import { getTranslationSync } from '../../../utils/i18n';
import { setInputText } from '../utils/inputHelper';
import { ForkNodesService } from './ForkNodesService';
import { PENDING_FORK_KEY, type PendingForkData, type PendingForkMode } from './forkLaunch';
import type { ForkNode } from './forkTypes';

const FORK_MANUAL_UPLOAD_HINT_CLASS = 'gv-fork-manual-upload-hint';
const FORK_MANUAL_UPLOAD_TIMER_CLASS = 'gv-fork-manual-upload-timer';

function formatTranslation(template: string, values: Record<string, string>): string {
  return Object.entries(values).reduce((result, [key, value]) => {
    return result.split(`{${key}}`).join(value);
  }, template);
}

// Pending reads can finish after restart, so upload feedback keeps its shared cleanup owner.
let manualUploadHintTimer: ReturnType<typeof setTimeout> | null = null;
let manualUploadCountdownTimer: ReturnType<typeof setInterval> | null = null;

export function startPendingFork({
  getConversationId,
  getConversationTitle,
  onLinked,
}: {
  getConversationId: () => string | null;
  getConversationTitle: () => string;
  onLinked: () => Promise<void>;
}): () => void {
  function clearManualUploadHint(): void {
    if (manualUploadHintTimer) {
      clearTimeout(manualUploadHintTimer);
      manualUploadHintTimer = null;
    }
    if (manualUploadCountdownTimer) {
      clearInterval(manualUploadCountdownTimer);
      manualUploadCountdownTimer = null;
    }
    document.querySelectorAll(`.${FORK_MANUAL_UPLOAD_HINT_CLASS}`).forEach((el) => el.remove());
  }

  const PENDING_FORK_PASTE_STALE_MS = 60000;
  const PENDING_FORK_FILE_UPLOAD_STALE_MS = 120000;

  function getPendingForkTtl(mode: PendingForkMode): number {
    return mode === 'fileUpload' ? PENDING_FORK_FILE_UPLOAD_STALE_MS : PENDING_FORK_PASTE_STALE_MS;
  }

  function getPendingForkRemainingMs(pendingFork: PendingForkData): number {
    const createdAt = pendingFork.createdAt ?? Date.now();
    return Math.max(0, createdAt + getPendingForkTtl(pendingFork.mode) - Date.now());
  }

  function formatCountdown(remainingMs: number): string {
    const totalSeconds = Math.max(0, Math.ceil(remainingMs / 1000));
    const minutes = Math.floor(totalSeconds / 60);
    const seconds = totalSeconds % 60;
    return `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
  }

  function getInputText(input: HTMLElement): string {
    return input instanceof HTMLTextAreaElement ? input.value : (input.textContent ?? '');
  }

  function buildManualUploadPrompt(pendingFork: PendingForkData): string {
    return formatTranslation(getTranslationSync('forkManualUploadPrompt'), {
      filename: pendingFork.filename || 'MD',
    });
  }

  async function readPendingFork(): Promise<PendingForkData | null> {
    try {
      const result = await browser.storage.local.get(PENDING_FORK_KEY);
      const parsed = result[PENDING_FORK_KEY] as Partial<PendingForkData> | undefined;
      if (!parsed) return null;
      const mode: PendingForkMode = parsed.mode === 'fileUpload' ? 'fileUpload' : 'paste';

      // Discard stale data (e.g. from a previous failed fork)
      if (parsed.createdAt && Date.now() - parsed.createdAt > getPendingForkTtl(mode)) {
        await browser.storage.local.remove(PENDING_FORK_KEY);
        return null;
      }

      const pendingFork: PendingForkData = {
        sourceConversationId: parsed.sourceConversationId || '',
        sourceTurnId: parsed.sourceTurnId || '',
        sourceUrl: parsed.sourceUrl || '',
        sourceTitle: parsed.sourceTitle || '',
        forkGroupId: parsed.forkGroupId || '',
        sourceForkIndex: Number.isFinite(parsed.sourceForkIndex) ? parsed.sourceForkIndex! : 0,
        nextForkIndex: Number.isFinite(parsed.nextForkIndex) ? parsed.nextForkIndex! : 1,
        markdown: parsed.markdown || '',
        mode,
        filename: typeof parsed.filename === 'string' ? parsed.filename : undefined,
        createdAt: parsed.createdAt,
      };

      if (
        !pendingFork.sourceConversationId ||
        !pendingFork.sourceTurnId ||
        !pendingFork.forkGroupId ||
        !pendingFork.markdown.trim()
      ) {
        await browser.storage.local.remove(PENDING_FORK_KEY);
        return null;
      }

      return pendingFork;
    } catch {
      return null;
    }
  }

  function checkAndHandlePendingFork(): void {
    // Only handle on a new conversation page (no conversation ID yet)
    const currentConvId = getConversationId();
    if (currentConvId) return;

    // Clean up legacy sessionStorage data (from versions before this fix)
    try {
      sessionStorage.removeItem(PENDING_FORK_KEY);
    } catch {
      // Ignore
    }

    void handlePendingForkFromStorage();
  }

  async function handlePendingForkFromStorage(): Promise<void> {
    // The opener tab writes to storage.local after async work, which may take a moment.
    // Try immediately, then retry once after a short delay.
    let pendingFork = await readPendingFork();
    if (!pendingFork) {
      await new Promise((r) => setTimeout(r, 2000));
      pendingFork = await readPendingFork();
    }
    if (!pendingFork) return;

    // Clear immediately so other tabs don't pick it up
    try {
      await browser.storage.local.remove(PENDING_FORK_KEY);
    } catch {
      // Ignore
    }

    // Re-check: still on a new conversation page?
    if (getConversationId()) return;

    const remainingMs = getPendingForkRemainingMs(pendingFork);
    if (remainingMs <= 0) return;

    if (pendingFork.mode === 'fileUpload') {
      showManualUploadHint(pendingFork, remainingMs);
      void prefillManualUploadPrompt(pendingFork);
      watchForNewConversation(pendingFork, remainingMs);
      return;
    }

    // Wait for the input field to be available
    const input = await waitForElement('rich-textarea [contenteditable="true"]', 10000);
    if (!input) {
      console.warn('[Fork] Input field not found');
      return;
    }

    setInputText(input, pendingFork.markdown);

    // Watch for URL change (conversation created after submission)
    watchForNewConversation(pendingFork, remainingMs);
  }

  async function prefillManualUploadPrompt(pendingFork: PendingForkData): Promise<void> {
    const input = await waitForElement('rich-textarea [contenteditable="true"]', 10000);
    if (!input || getInputText(input).trim()) return;
    setInputText(input, buildManualUploadPrompt(pendingFork));
  }

  function showManualUploadHint(pendingFork: PendingForkData, remainingMs: number): void {
    clearManualUploadHint();

    const notice = document.createElement('div');
    notice.className = FORK_MANUAL_UPLOAD_HINT_CLASS;
    notice.setAttribute('role', 'status');

    const message = document.createElement('span');
    message.textContent = formatTranslation(getTranslationSync('forkManualUploadHint'), {
      filename: pendingFork.filename || 'MD',
    });

    const timer = document.createElement('strong');
    timer.className = FORK_MANUAL_UPLOAD_TIMER_CLASS;
    timer.setAttribute('aria-live', 'polite');
    timer.textContent = formatCountdown(remainingMs);
    message.appendChild(timer);

    const closeButton = document.createElement('button');
    closeButton.type = 'button';
    closeButton.textContent = '\u00d7';
    closeButton.title = getTranslationSync('forkCancel');
    closeButton.setAttribute('aria-label', getTranslationSync('forkCancel'));
    closeButton.addEventListener('click', () => clearManualUploadHint());

    notice.appendChild(message);
    notice.appendChild(closeButton);
    document.body.appendChild(notice);

    const expiresAt = Date.now() + remainingMs;
    manualUploadCountdownTimer = setInterval(() => {
      const nextRemainingMs = Math.max(0, expiresAt - Date.now());
      timer.textContent = formatCountdown(nextRemainingMs);
      if (nextRemainingMs <= 0) {
        clearManualUploadHint();
      }
    }, 1000);
    manualUploadHintTimer = setTimeout(clearManualUploadHint, remainingMs);
  }

  function waitForElement(selector: string, timeoutMs: number): Promise<HTMLElement | null> {
    return new Promise((resolve) => {
      const existing = document.querySelector<HTMLElement>(selector);
      if (existing && existing.getBoundingClientRect().height > 0) {
        resolve(existing);
        return;
      }

      const deadline = Date.now() + timeoutMs;
      const check = () => {
        const el = document.querySelector<HTMLElement>(selector);
        if (el && el.getBoundingClientRect().height > 0) {
          resolve(el);
          return;
        }
        if (Date.now() > deadline) {
          resolve(null);
          return;
        }
        requestAnimationFrame(check);
      };
      requestAnimationFrame(check);
    });
  }

  function watchForNewConversation(pendingFork: PendingForkData, timeoutMs: number): void {
    let lastUrl = window.location.href;
    let stopped = false;
    let pollInterval: ReturnType<typeof setInterval> | null = null;
    let cleanupTimer: ReturnType<typeof setTimeout> | null = null;

    const stopWatching = () => {
      if (stopped) return;
      stopped = true;
      urlObserver.disconnect();
      window.removeEventListener('popstate', onUrlChange);
      window.removeEventListener('hashchange', onUrlChange);
      if (pollInterval) clearInterval(pollInterval);
      if (cleanupTimer) clearTimeout(cleanupTimer);
      clearManualUploadHint();
    };

    const checkUrl = async () => {
      if (stopped) return;
      const currentUrl = window.location.href;
      if (currentUrl === lastUrl) return;
      lastUrl = currentUrl;

      const newConvId = getConversationId();
      if (!newConvId) return;

      // New conversation created! Create fork nodes for both sides
      stopWatching();

      try {
        // Create fork node for the SOURCE conversation (original, index 0)
        const sourceNode: ForkNode = {
          turnId: pendingFork.sourceTurnId,
          conversationId: pendingFork.sourceConversationId,
          conversationUrl: pendingFork.sourceUrl,
          conversationTitle: pendingFork.sourceTitle,
          forkGroupId: pendingFork.forkGroupId,
          forkIndex: pendingFork.sourceForkIndex,
          createdAt: Date.now(),
        };
        await ForkNodesService.addForkNode(sourceNode);

        // Create fork node for the NEW conversation (fork)
        // Use the first user turn ID in the new conversation
        const newNode: ForkNode = {
          turnId: 'u-0', // First user turn in new conversation
          conversationId: newConvId,
          conversationUrl: currentUrl,
          conversationTitle: getConversationTitle(),
          forkGroupId: pendingFork.forkGroupId,
          forkIndex: pendingFork.nextForkIndex,
          createdAt: Date.now(),
        };
        await ForkNodesService.addForkNode(newNode);

        // Inject fork indicators in the new conversation
        setTimeout(() => onLinked(), 1000);
      } catch (error) {
        if (!isExtensionContextInvalidatedError(error)) {
          console.error('[Fork] Failed to create fork nodes:', error);
        }
      }
    };

    // Use a MutationObserver on the URL (via popstate + polling)
    const urlObserver = new MutationObserver(() => void checkUrl());
    urlObserver.observe(document, { subtree: true, childList: true });

    // Also listen to popstate and hashchange
    const onUrlChange = () => void checkUrl();
    window.addEventListener('popstate', onUrlChange);
    window.addEventListener('hashchange', onUrlChange);

    // Poll as fallback (SPA navigation may not trigger popstate)
    pollInterval = setInterval(() => {
      void checkUrl();
    }, 500);

    // Cleanup when the fork window expires
    cleanupTimer = setTimeout(stopWatching, timeoutMs);
  }

  checkAndHandlePendingFork();
  return clearManualUploadHint;
}
