/**
 * Conversation Fork Feature
 *
 * Allows users to fork/branch a conversation at any user message.
 * When forking, the conversation up to that point is exported as markdown
 * and pasted into a new Gemini conversation. Both conversations are linked
 * via fork indicators for easy navigation between branches.
 */
import browser from 'webextension-polyfill';

import { StorageKeys } from '@/core/types/common';
import { isExtensionContextInvalidatedError } from '@/core/utils/extensionContext';

import { getTranslationSync } from '../../../utils/i18n';
import { historyTimestampStore } from '../timestamp/historyTimestamps';
import { setInputText } from '../utils/inputHelper';
import { ForkNodesService } from './ForkNodesService';
import { buildBranchDisplayNodes } from './branching';
import { collectForkChatPairs } from './chatPairs';
import { createForkControls } from './forkControls';
import {
  PENDING_FORK_KEY,
  type PendingForkData,
  type PendingForkMode,
  createForkLauncher,
} from './forkLaunch';
import type { ForkNode } from './forkTypes';
import { getLegacyTurnIndex, makeTurnId, normalizeTurnId } from './turnId';

// ============================================================================
// Constants
// ============================================================================

const FORK_INDICATOR_CLASS = 'gv-fork-indicator';
const FORK_INDICATOR_GROUP_CLASS = 'gv-fork-indicator-group';
const FORK_INDICATOR_ITEM_CLASS = 'gv-fork-indicator-item';
const FORK_INDICATOR_DELETE_CLASS = 'gv-fork-indicator-delete';
const FORK_MANUAL_UPLOAD_HINT_CLASS = 'gv-fork-manual-upload-hint';
const FORK_MANUAL_UPLOAD_TIMER_CLASS = 'gv-fork-manual-upload-timer';

const OBSERVER_DEBOUNCE_MS = 500;
const CONVERSATION_VERIFY_TIMEOUT_MS = 4000;
const CONVERSATION_EXISTENCE_CACHE_TTL_MS = 30000;

const conversationExistenceCache = new Map<string, { exists: boolean; checkedAt: number }>();

// ============================================================================
// Styles
// ============================================================================

// ============================================================================
// Helpers
// ============================================================================

function extractConversationIdFromUrl(): string | null {
  const appMatch = window.location.pathname.match(/\/app\/([^/?#]+)/);
  if (appMatch?.[1]) return appMatch[1];
  const gemMatch = window.location.pathname.match(/\/gem\/[^/]+\/([^/?#]+)/);
  return gemMatch?.[1] || null;
}

function resolveCurrentConversationTurnId(turnId: string): string | null {
  const conversationId = extractConversationIdFromUrl();
  if (!conversationId) return normalizeTurnId(turnId);
  return historyTimestampStore.resolveCanonicalTurnId(conversationId, turnId);
}

function getNewConversationUrlForCurrentAccount(): string {
  const accountPrefix = window.location.pathname.match(/^\/u\/\d+(?=\/)/)?.[0] || '';
  return `${window.location.origin}${accountPrefix}/app`;
}

function getConversationTitle(): string {
  const conversationId = extractConversationIdFromUrl();
  if (conversationId) {
    const escapedId = conversationId.replace(/"/g, '\\"');
    const link = document.querySelector<HTMLAnchorElement>(
      `[data-test-id="conversation"][jslog*="c_${escapedId}"] a, a[href*="/app/${escapedId}"]`,
    );
    if (link?.textContent?.trim()) return link.textContent.trim();
  }
  return document.title || 'Untitled';
}

function formatTranslation(template: string, values: Record<string, string>): string {
  return Object.entries(values).reduce((result, [key, value]) => {
    return result.split(`{${key}}`).join(value);
  }, template);
}

function ensureTurnId(el: HTMLElement, index: number): string {
  const stableId = makeTurnId(el, index);
  const current = el.dataset?.turnId || '';
  if (normalizeTurnId(current) !== stableId) {
    el.dataset.turnId = stableId;
  }
  return stableId;
}

function resolveUserMessageHost(userEl: HTMLElement): HTMLElement {
  const preferred =
    userEl.querySelector<HTMLElement>('.user-query-bubble-with-background') ||
    userEl.querySelector<HTMLElement>('user-query-content .user-query-bubble-with-background') ||
    userEl.querySelector<HTMLElement>('.user-query-bubble-container');
  return preferred || userEl;
}

function extractConversationIdFromHref(href: string): string | null {
  try {
    const url = new URL(href, window.location.origin);
    const appMatch = url.pathname.match(/\/app\/([^/?#]+)/);
    if (appMatch?.[1]) return appMatch[1];
    const gemMatch = url.pathname.match(/\/gem\/[^/]+\/([^/?#]+)/);
    return gemMatch?.[1] || null;
  } catch {
    return null;
  }
}

function findSidebarConversationLinkById(conversationId: string): HTMLAnchorElement | null {
  const links = Array.from(
    document.querySelectorAll<HTMLAnchorElement>('a[href*="/app/"], a[href*="/gem/"]'),
  );
  for (const link of links) {
    if (extractConversationIdFromHref(link.href) === conversationId) return link;
  }
  return null;
}

function triggerNativeClick(target: HTMLElement): void {
  const options = { bubbles: true, cancelable: true, view: window };
  target.dispatchEvent(new MouseEvent('pointerdown', options));
  target.dispatchEvent(new MouseEvent('mousedown', options));
  target.dispatchEvent(new MouseEvent('mouseup', options));
  target.dispatchEvent(new MouseEvent('click', options));
}

function navigateToForkConversation(node: ForkNode): void {
  if (!node.conversationId) return;
  const currentConversationId = extractConversationIdFromUrl();
  if (currentConversationId === node.conversationId) return;

  const sidebarLink = findSidebarConversationLinkById(node.conversationId);
  if (sidebarLink) {
    triggerNativeClick(sidebarLink);
    return;
  }

  const fallbackUrl =
    node.conversationUrl ||
    `${window.location.origin}/app/${encodeURIComponent(node.conversationId)}`;
  window.location.assign(fallbackUrl);
}

function collectSidebarConversationIds(): Set<string> {
  const ids = new Set<string>();
  const links = document.querySelectorAll<HTMLAnchorElement>('a[href*="/app/"], a[href*="/gem/"]');
  links.forEach((link) => {
    const id = extractConversationIdFromHref(link.href);
    if (id) ids.add(id);
  });
  return ids;
}

async function checkConversationExists(
  node: ForkNode,
  sidebarConversationIds: Set<string>,
): Promise<boolean> {
  const currentConversationId = extractConversationIdFromUrl();
  if (currentConversationId && node.conversationId === currentConversationId) return true;
  if (sidebarConversationIds.has(node.conversationId)) {
    conversationExistenceCache.set(node.conversationId, { exists: true, checkedAt: Date.now() });
    return true;
  }

  const cached = conversationExistenceCache.get(node.conversationId);
  const now = Date.now();
  if (cached && now - cached.checkedAt <= CONVERSATION_EXISTENCE_CACHE_TTL_MS) {
    return cached.exists;
  }

  if (!node.conversationUrl) {
    conversationExistenceCache.set(node.conversationId, { exists: false, checkedAt: now });
    return false;
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), CONVERSATION_VERIFY_TIMEOUT_MS);
  try {
    const response = await fetch(node.conversationUrl, {
      method: 'GET',
      redirect: 'follow',
      credentials: 'include',
      signal: controller.signal,
    });
    const responseConversationId = extractConversationIdFromHref(response.url);
    const exists =
      response.ok && !!responseConversationId && node.conversationId === responseConversationId;
    conversationExistenceCache.set(node.conversationId, { exists, checkedAt: now });
    return exists;
  } catch {
    // If verification fails for network/CSP reasons, keep node to avoid destructive false positives.
    return true;
  } finally {
    clearTimeout(timer);
  }
}

async function pruneDeletedNodesFromGroup(
  groupNodes: ForkNode[],
  sidebarConversationIds: Set<string>,
): Promise<ForkNode[]> {
  const cleaned: ForkNode[] = [];

  for (const node of groupNodes) {
    const exists = await checkConversationExists(node, sidebarConversationIds);
    if (exists) {
      cleaned.push(node);
      continue;
    }

    try {
      await ForkNodesService.removeForkNode(node.conversationId, node.turnId, node.forkGroupId);
    } catch (error) {
      if (!isExtensionContextInvalidatedError(error)) {
        console.error('[Fork] Failed to prune deleted fork node:', error);
      }
    }
  }

  return cleaned;
}

function clearInjectedForkIndicators(): void {
  document.querySelectorAll(`.${FORK_INDICATOR_GROUP_CLASS}`).forEach((el) => el.remove());
}

function hasOrDedupForkIndicatorGroup(hostEl: HTMLElement): boolean {
  const groups = Array.from(hostEl.querySelectorAll<HTMLElement>(`.${FORK_INDICATOR_GROUP_CLASS}`));
  if (groups.length === 0) return false;
  if (groups.length > 1) {
    for (let i = 1; i < groups.length; i++) {
      groups[i].remove();
    }
  }
  return true;
}

// ============================================================================
// Fork Button Injection
// ============================================================================

let observer: MutationObserver | null = null;
let observerDebounceTimer: ReturnType<typeof setTimeout> | null = null;
let storageRefreshTimer: ReturnType<typeof setTimeout> | null = null;
let manualUploadHintTimer: ReturnType<typeof setTimeout> | null = null;
let manualUploadCountdownTimer: ReturnType<typeof setInterval> | null = null;

function scheduleForkIndicatorRefresh(): void {
  if (storageRefreshTimer) clearTimeout(storageRefreshTimer);
  storageRefreshTimer = setTimeout(() => {
    clearInjectedForkIndicators();
    void injectForkIndicators();
    storageRefreshTimer = null;
  }, OBSERVER_DEBOUNCE_MS);
}

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
  const currentConvId = extractConversationIdFromUrl();
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
  if (extractConversationIdFromUrl()) return;

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

    const newConvId = extractConversationIdFromUrl();
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
      setTimeout(() => injectForkIndicators(), 1000);
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

// ============================================================================
// Fork Indicator UI
// ============================================================================

async function injectForkIndicators(): Promise<void> {
  const conversationId = extractConversationIdFromUrl();
  if (!conversationId) return;

  let forkNodes: ForkNode[];
  try {
    forkNodes = await ForkNodesService.getForConversation(conversationId);
  } catch (error) {
    if (!isExtensionContextInvalidatedError(error)) {
      console.error('[Fork] Failed to get fork nodes:', error);
    }
    return;
  }

  if (forkNodes.length === 0) return;

  // Build a map of normalized turnId -> forkGroupIds
  const turnForkMap = new Map<string, Set<string>>();
  for (const node of forkNodes) {
    const normalizedTurnId = resolveCurrentConversationTurnId(node.turnId);
    if (!normalizedTurnId) continue;
    if (!turnForkMap.has(normalizedTurnId)) {
      turnForkMap.set(normalizedTurnId, new Set<string>());
    }
    turnForkMap.get(normalizedTurnId)?.add(node.forkGroupId);
  }

  const pairs = collectForkChatPairs();
  const sidebarConversationIds = collectSidebarConversationIds();
  if (conversationId) sidebarConversationIds.add(conversationId);

  for (let index = 0; index < pairs.length; index++) {
    const userEl = pairs[index].userElement;
    const mountedTurnId = ensureTurnId(userEl, index);
    if (getLegacyTurnIndex(mountedTurnId) !== null) continue;
    const turnId = resolveCurrentConversationTurnId(mountedTurnId);
    if (!turnId) continue;
    const hostEl = resolveUserMessageHost(userEl);
    const forkGroupIds = turnForkMap.get(turnId);
    if (!forkGroupIds || forkGroupIds.size === 0) continue;

    if (hasOrDedupForkIndicatorGroup(hostEl)) continue;

    const groupNodesList: ForkNode[][] = [];
    for (const forkGroupId of forkGroupIds) {
      try {
        const groupNodes = await ForkNodesService.getGroup(forkGroupId);
        if (groupNodes.length === 0) continue;
        const cleanedGroupNodes = await pruneDeletedNodesFromGroup(
          groupNodes,
          sidebarConversationIds,
        );
        if (cleanedGroupNodes.length > 0) groupNodesList.push(cleanedGroupNodes);
      } catch {
        // Ignore single group failure and continue rendering available groups.
      }
    }
    if (groupNodesList.length === 0) continue;

    const displayNodes = buildBranchDisplayNodes(groupNodesList);
    if (displayNodes.length < 2) continue;

    // Re-check after async group loading to avoid duplicate render in concurrent injections.
    if (hasOrDedupForkIndicatorGroup(hostEl)) continue;

    const group = document.createElement('div');
    group.className = FORK_INDICATOR_GROUP_CLASS;

    for (let displayIndex = 0; displayIndex < displayNodes.length; displayIndex++) {
      const node = displayNodes[displayIndex];
      const branchNumber = displayIndex + 1;
      const isCurrent = node.conversationId === conversationId;
      const item = document.createElement('div');
      item.className = FORK_INDICATOR_ITEM_CLASS;

      const indicator = document.createElement('button');
      indicator.className = `${FORK_INDICATOR_CLASS}${isCurrent ? ' gv-current' : ''}`;
      indicator.type = 'button';
      indicator.textContent = String(branchNumber);
      indicator.title = `${getTranslationSync('forkBranch')} ${branchNumber}${
        isCurrent ? ` - ${getTranslationSync('forkCurrent')}` : ''
      }`;

      if (isCurrent) {
        indicator.setAttribute('aria-current', 'true');
        indicator.disabled = true;
      } else {
        indicator.addEventListener('click', (e) => {
          e.stopPropagation();
          e.preventDefault();
          navigateToForkConversation(node);
        });
      }
      item.appendChild(indicator);

      const deleteBtn = document.createElement('button');
      deleteBtn.className = FORK_INDICATOR_DELETE_CLASS;
      deleteBtn.type = 'button';
      deleteBtn.textContent = '×';
      deleteBtn.title = getTranslationSync('forkDeleteData');
      deleteBtn.setAttribute('aria-label', getTranslationSync('forkDeleteData'));
      deleteBtn.addEventListener('click', async (e) => {
        e.stopPropagation();
        e.preventDefault();
        const confirmed = window.confirm(getTranslationSync('forkDeleteDataConfirm'));
        if (!confirmed) return;

        deleteBtn.disabled = true;
        try {
          await ForkNodesService.removeForkNode(node.conversationId, node.turnId, node.forkGroupId);
        } catch (error) {
          if (!isExtensionContextInvalidatedError(error)) {
            console.error('[Fork] Failed to delete fork branch data:', error);
          }
        } finally {
          clearInjectedForkIndicators();
          void injectForkIndicators();
        }
      });
      item.appendChild(deleteBtn);
      group.appendChild(item);
    }

    hostEl.style.position = hostEl.style.position || 'relative';
    hostEl.appendChild(group);
  }
}

// ============================================================================
// Language Update
// ============================================================================

function updateForkIndicatorTexts(): void {
  // Update indicator titles (sequence numbers stay the same, language labels change)
  const indicators = document.querySelectorAll<HTMLElement>(`.${FORK_INDICATOR_CLASS}`);
  indicators.forEach((ind) => {
    const branchNumber = ind.textContent?.trim();
    if (!branchNumber) return;
    const isCurrent = ind.classList.contains('gv-current');
    ind.title = `${getTranslationSync('forkBranch')} ${branchNumber}${
      isCurrent ? ` - ${getTranslationSync('forkCurrent')}` : ''
    }`;
  });

  const deleteButtons = document.querySelectorAll<HTMLElement>(`.${FORK_INDICATOR_DELETE_CLASS}`);
  deleteButtons.forEach((btn) => {
    btn.title = getTranslationSync('forkDeleteData');
    btn.setAttribute('aria-label', getTranslationSync('forkDeleteData'));
  });
}

// ============================================================================
// Module Entry Point
// ============================================================================

export function startFork(): () => void {
  const executeFork = createForkLauncher({
    getConversationId: extractConversationIdFromUrl,
    getConversationTitle,
    getNewConversationUrl: getNewConversationUrlForCurrentAccount,
    ensureTurnId,
    resolveTurnId: resolveCurrentConversationTurnId,
  });
  const controls = createForkControls({
    ensureTurnId,
    resolveUserMessageHost,
    onFork: executeFork,
  });

  // Check for pending fork data (new conversation paste)
  checkAndHandlePendingFork();

  // Inject fork buttons and indicators
  const setup = () => {
    controls.inject();
    void injectForkIndicators();
  };

  // Initial injection with delay to let DOM settle
  setTimeout(setup, 1000);

  // MutationObserver for dynamically loaded messages
  observer = new MutationObserver(() => {
    if (observerDebounceTimer) clearTimeout(observerDebounceTimer);
    observerDebounceTimer = setTimeout(() => {
      controls.inject();
      void injectForkIndicators();
    }, OBSERVER_DEBOUNCE_MS);
  });

  observer.observe(document.body, {
    childList: true,
    subtree: true,
  });

  // Language change listener
  const onStorageChanged = (
    changes: Record<string, browser.Storage.StorageChange>,
    areaName: string,
  ) => {
    if ((areaName === 'sync' || areaName === 'local') && changes[StorageKeys.LANGUAGE]) {
      controls.updateLanguage();
      updateForkIndicatorTexts();
    }
    if (areaName === 'local' && changes[StorageKeys.FORK_NODES]) {
      scheduleForkIndicatorRefresh();
    }
  };
  browser.storage.onChanged.addListener(onStorageChanged);

  // Cleanup function
  return () => {
    if (observer) {
      observer.disconnect();
      observer = null;
    }
    if (observerDebounceTimer) {
      clearTimeout(observerDebounceTimer);
      observerDebounceTimer = null;
    }
    if (storageRefreshTimer) {
      clearTimeout(storageRefreshTimer);
      storageRefreshTimer = null;
    }
    clearManualUploadHint();
    controls.stop();
    browser.storage.onChanged.removeListener(onStorageChanged);

    // Remove injected elements
    document.querySelectorAll(`.${FORK_INDICATOR_CLASS}`).forEach((el) => el.remove());
    document.querySelectorAll(`.${FORK_INDICATOR_GROUP_CLASS}`).forEach((el) => el.remove());
  };
}
