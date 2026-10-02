/**
 * Reads the conversation shown on the page into export turns and selectable messages.
 *
 * All host-specific selectors come from the export adapter. This module owns
 * the DOM heuristics shared by every caller: document-order pairing, skipping
 * Gemini's thinking panel and Deep Research immersive nodes, starred-turn
 * lookup, and appending Canvas document content to responses that reference it.
 */
import {
  buildConversationIdFromUrl,
  buildLegacyConversationIdFromUrl,
  buildRouteConversationIdFromUrl,
} from '@/core/utils/conversationIdentity';

import type { CanvasDoc, ChatTurn as ExportChatTurn } from '../../../features/export/types/export';
import { isServerTurnId } from '../fork/turnId';
import { historyTimestampStore } from '../timestamp/historyTimestamps';
import type { ExportPlatformAdapter } from './adapter/platformAdapters';
import { assistantHasCanvasDoc, extractAllCanvasDocs, isAnyCanvasOpen } from './canvasDocExtractor';
import {
  filterOutDeepResearchImmersiveNodes,
  findFirstElementBetweenTurns,
} from './conversationDom';
import { resolveUniqueExportTurnIds } from './selectionIds';
import { groupSelectedMessagesByTurn } from './selectionUtils';
import { geminiConversationIdFromLocation } from './sidebarConversationNavigation';

const CANVAS_EXPORT_SECTION_CLASS = 'gv-canvas-export-section';

export type ChatTurn = {
  turnId: string;
  user: string;
  assistant: string;
  starred: boolean;
  userElement?: HTMLElement;
  assistantElement?: HTMLElement;
  assistantHostElement?: HTMLElement;
};

export type ExportMessageRole = 'user' | 'assistant' | 'unknown';

/** One selectable message: `${turnId}:u` / `${turnId}:a`, or an adapter turn-container id. */
export type ExportMessage = {
  messageId: string;
  role: ExportMessageRole;
  hostElement: HTMLElement;
  exportElement?: HTMLElement;
  text: string;
  starred: boolean;
};

export interface ConversationCollector {
  /** User/assistant pairs in document order. Appends Canvas sections to responses (once). */
  collectChatPairs(): ChatTurn[];
  /** Selectable messages for the current page, in reading order. */
  collectSelectionMessages(): ExportMessage[];
  /** Export turns for the given message ids, read fresh from the page. Empty turns are dropped. */
  turnsForMessageIds(selectedMessageIds: ReadonlySet<string>): ExportChatTurn[];
  /** Message id of the response that owns a response-menu trigger, or null. */
  assistantMessageIdFor(trigger: HTMLElement | null): string | null;
  /** First top-level user turn inside the conversation root. */
  topUserElement(): HTMLElement | null;
  conversationRoot(): HTMLElement;
  /**
   * Remember open Canvas documents so their content still exports after the
   * preload loop scrolls or re-renders the page and closes the panel.
   */
  snapshotOpenCanvasDocs(): void;
  /** Forget the snapshot and remove every appended Canvas section. */
  releaseCanvasDocs(): void;
}

/** Remove Canvas sections appended to responses during an export. */
export function removeCanvasExportSections(): void {
  document.querySelectorAll(`.${CANVAS_EXPORT_SECTION_CLASS}`).forEach((el) => el.remove());
}

function normalizeText(text: string | null): string {
  try {
    return String(text || '')
      .replace(/\s+/g, ' ')
      .trim();
  } catch {
    return '';
  }
}

/**
 * querySelector variant that skips elements nested inside model-thoughts / thoughts-container.
 * When the user expands Gemini's "thinking" section, a second `message-content` element
 * appears *before* the real response in DOM order.  A plain `querySelector` would match
 * the thinking panel first, causing exports to grab the wrong content.
 */
function queryOutsideThoughts<T extends Element = Element>(
  root: Element,
  selector: string,
): T | null {
  const candidates = root.querySelectorAll<T>(selector);
  for (const el of Array.from(candidates)) {
    if (!el.closest('model-thoughts, .thoughts-container, .thoughts-content')) {
      return el;
    }
  }
  return null;
}

function filterTopLevel(elements: Element[]): HTMLElement[] {
  const arr = elements.map((e) => e as HTMLElement);
  const out: HTMLElement[] = [];
  for (let i = 0; i < arr.length; i++) {
    const el = arr[i];
    let isDescendant = false;
    for (let j = 0; j < arr.length; j++) {
      if (i === j) continue;
      const other = arr[j];
      if (other.contains(el)) {
        isDescendant = true;
        break;
      }
    }
    if (!isDescendant) out.push(el);
  }
  return out;
}

function readStarredSet(conversationId: string): Set<string> {
  try {
    const candidateConversationIds = [
      conversationId,
      buildRouteConversationIdFromUrl(window.location.href),
      buildLegacyConversationIdFromUrl(window.location.href),
    ];

    for (const candidateConversationId of candidateConversationIds) {
      const raw = localStorage.getItem(`geminiTimelineStars:${candidateConversationId}`);
      if (!raw) continue;
      const arr = JSON.parse(raw);
      if (!Array.isArray(arr)) continue;
      return new Set(arr.map((x: unknown) => String(x)));
    }

    return new Set();
  } catch {
    return new Set();
  }
}

function extractAssistantText(el: HTMLElement): string {
  // Prefer direct text from message container if available (connected to DOM)
  // Use queryOutsideThoughts to avoid matching the message-content inside
  // the expanded thinking/reasoning panel.
  try {
    const mc = queryOutsideThoughts<HTMLElement>(
      el,
      'message-content, .markdown, .markdown-main-panel',
    );
    if (mc) {
      const raw = mc.textContent || mc.innerText || '';
      const txt = normalizeText(raw);
      if (txt) return txt;
    }
  } catch {}

  // Clone and remove reasoning toggles/labels before reading text (detached fallback)
  const clone = el.cloneNode(true) as HTMLElement;
  const matchesReasonToggle = (txt: string): boolean => {
    const s = normalizeText(txt).toLowerCase();
    if (!s) return false;
    return (
      /^(show\s*(thinking|reasoning)|hide\s*(thinking|reasoning))$/i.test(s) ||
      /^(显示\s*(思路|推理)|隐藏\s*(思路|推理))$/u.test(s)
    );
  };
  const shouldDrop = (node: HTMLElement): boolean => {
    const role = (node.getAttribute('role') || '').toLowerCase();
    const aria = (node.getAttribute('aria-label') || '').toLowerCase();
    const txt = node.textContent || '';
    if (matchesReasonToggle(txt)) return true;
    if (role === 'button' && (/thinking|reasoning/i.test(txt) || /思路|推理/u.test(txt)))
      return true;
    if (/thinking|reasoning/i.test(aria) || /思路|推理/u.test(aria)) return true;
    return false;
  };
  try {
    const candidates = clone.querySelectorAll(
      'button, [role="button"], [aria-label], span, div, a',
    );
    candidates.forEach((n) => {
      const eln = n as HTMLElement;
      if (shouldDrop(eln)) eln.remove();
    });
  } catch {}
  const text = normalizeText(clone.innerText || clone.textContent || '');
  return text;
}

function appendCanvasDocSections(targetContainer: Element, canvasDocs: readonly CanvasDoc[]): void {
  for (const doc of canvasDocs) {
    const section = document.createElement('div');
    section.className = CANVAS_EXPORT_SECTION_CLASS;
    const heading = document.createElement('h3');
    heading.textContent = `📄 Canvas Document: ${doc.title}`;
    const content = document.createElement('div');
    content.className = 'gv-canvas-content';
    content.textContent = doc.content;
    section.appendChild(heading);
    section.appendChild(content);
    targetContainer.appendChild(section);
  }
}

function buildExportMessagesFromPairs(pairs: ChatTurn[]): ExportMessage[] {
  const out: ExportMessage[] = [];
  pairs.forEach((pair) => {
    if (pair.userElement) {
      out.push({
        messageId: `${pair.turnId}:u`,
        role: 'user',
        hostElement: pair.userElement,
        exportElement: pair.userElement,
        text: pair.user,
        starred: pair.starred,
      });
    }

    const assistantHost = pair.assistantHostElement;
    if (assistantHost) {
      out.push({
        messageId: `${pair.turnId}:a`,
        role: 'assistant',
        hostElement: assistantHost,
        exportElement: pair.assistantElement || assistantHost,
        text: pair.assistant,
        starred: pair.starred,
      });
    }
  });
  return out;
}

function buildTurnsForSelectedMessages(
  selectedMessages: readonly ExportMessage[],
): ExportChatTurn[] {
  const groupedTurns = groupSelectedMessagesByTurn(
    selectedMessages.filter(
      (message): message is ExportMessage & { role: Exclude<ExportMessageRole, 'unknown'> } =>
        message.role !== 'unknown',
    ),
  );
  return groupedTurns
    .map((turn) => ({
      user: turn.user?.text || '',
      assistant: turn.assistant?.text || '',
      starred: turn.starred,
      omitEmptySections: true,
      userElement: turn.user?.exportElement,
      assistantElement: turn.assistant?.exportElement,
    }))
    .filter(
      (turn) =>
        turn.user.length > 0 ||
        turn.assistant.length > 0 ||
        !!turn.userElement ||
        !!turn.assistantElement,
    );
}

export function createConversationCollector(adapter: ExportPlatformAdapter): ConversationCollector {
  let cachedCanvasDocs: CanvasDoc[] | null = null;

  const conversationRoot = (): HTMLElement =>
    adapter.resolveConversationRoot(adapter.getUserSelectors(), document);

  const topUserElement = (): HTMLElement | null => {
    const selectors = adapter.getUserSelectors();
    const root = adapter.resolveConversationRoot(selectors, document);
    const all = filterOutDeepResearchImmersiveNodes(
      Array.from(root.querySelectorAll<HTMLElement>(selectors.join(','))),
    );
    if (!all.length) return null;
    const topLevel = filterTopLevel(all);
    return topLevel.length > 0 ? topLevel[0] : null;
  };

  const collectChatPairs = (): ChatTurn[] => {
    const userSelectors = adapter.getUserSelectors();
    const root = adapter.resolveConversationRoot(userSelectors, document);
    const assistantSelectors = adapter.getAssistantSelectors();
    const userNodeList = filterOutDeepResearchImmersiveNodes(
      Array.from(root.querySelectorAll<HTMLElement>(userSelectors.join(','))),
    );
    if (!userNodeList || userNodeList.length === 0) return [];
    const users = filterTopLevel(userNodeList);
    if (users.length === 0) return [];

    const uniqueTurnIds = resolveUniqueExportTurnIds(users);

    const assistantsAll = filterOutDeepResearchImmersiveNodes(
      Array.from(root.querySelectorAll<HTMLElement>(assistantSelectors.join(','))),
    );
    const assistants = filterTopLevel(assistantsAll);

    const starredSet = readStarredSet(
      adapter.extractConversationIdFromUrl() || buildConversationIdFromUrl(window.location.href),
    );
    const nativeConversationId = geminiConversationIdFromLocation();
    const pairs: ChatTurn[] = [];

    for (let i = 0; i < users.length; i++) {
      const uEl = users[i] as HTMLElement;
      const uText = normalizeText(uEl.innerText || uEl.textContent || '');
      let aText = '';
      let aEl = findFirstElementBetweenTurns(uEl, users[i + 1], assistants);

      if (aEl) {
        aText = extractAssistantText(aEl);
      } else {
        // Fallback: search next siblings up to a small window
        let sib: HTMLElement | null = uEl;
        for (let step = 0; step < 8 && sib; step++) {
          sib = sib.nextElementSibling as HTMLElement | null;
          if (!sib) break;
          if (sib.matches(userSelectors.join(','))) break;
          if (sib.matches(assistantSelectors.join(','))) {
            aEl = sib;
            aText = extractAssistantText(sib);
            break;
          }
        }
      }
      const turnId = uniqueTurnIds[i];
      const turnIdAliases =
        turnId && nativeConversationId && isServerTurnId(turnId)
          ? historyTimestampStore.getTurnIdAliases(nativeConversationId, turnId)
          : turnId && isServerTurnId(turnId)
            ? [turnId]
            : [];
      const starred = turnIdAliases.some((alias) => starredSet.has(alias));
      if (uText || aText) {
        // Prefer a richer assistant container for downstream rich extraction
        let finalAssistantEl: HTMLElement | undefined = undefined;
        if (aEl) {
          const pick =
            queryOutsideThoughts<HTMLElement>(aEl, 'message-content') ||
            queryOutsideThoughts<HTMLElement>(aEl, '.markdown, .markdown-main-panel') ||
            (aEl.closest('.presented-response-container') as HTMLElement | null) ||
            queryOutsideThoughts<HTMLElement>(
              aEl,
              '.presented-response-container, .response-content',
            ) ||
            queryOutsideThoughts<HTMLElement>(aEl, 'response-element') ||
            aEl;
          finalAssistantEl = pick || undefined;
        }
        pairs.push({
          turnId,
          user: uText,
          assistant: aText,
          starred,
          userElement: uEl,
          assistantElement: finalAssistantEl,
          assistantHostElement: aEl || undefined,
        });
        // Canvas document content injection: if this assistant response references
        // a Canvas doc, append full Canvas content directly into the DOM element
        // so DOMContentExtractor can pick it up.
        // Guard against duplicate injection (collectChatPairs may be called multiple times).
        if (
          aEl &&
          assistantHasCanvasDoc(aEl) &&
          (isAnyCanvasOpen() || (cachedCanvasDocs && cachedCanvasDocs.length > 0)) &&
          finalAssistantEl &&
          !finalAssistantEl.querySelector(`.${CANVAS_EXPORT_SECTION_CLASS}`)
        ) {
          const canvasDocs =
            cachedCanvasDocs && cachedCanvasDocs.length > 0
              ? cachedCanvasDocs
              : extractAllCanvasDocs();
          if (canvasDocs.length > 0) {
            appendCanvasDocSections(
              finalAssistantEl.querySelector('.markdown, .markdown-main-panel') || finalAssistantEl,
              canvasDocs,
            );
          }
        }
      }
    }
    return pairs;
  };

  const selectionMessagesFromPairs = (pairsInput: ChatTurn[]): ExportMessage[] => {
    const turnContainers = adapter.collectTurnContainers?.();
    if (turnContainers) {
      // ChatGPT virtualizes its thread, so the DOM holds only a few turns. The
      // adapter's list (crawled up front, or retained containers on the earlier
      // DOM) is the only reliable source for selection identity and order.
      return turnContainers.map((turn) => ({
        messageId: turn.id,
        role: turn.role,
        hostElement: turn.container,
        exportElement: turn.container,
        text: '',
        starred: false,
      }));
    }

    const messages = buildExportMessagesFromPairs(pairsInput);
    return messages
      .map((message) => {
        const rect = message.hostElement.getBoundingClientRect();
        return {
          ...message,
          absTop: rect.top + window.scrollY,
        };
      })
      .sort((a, b) => a.absTop - b.absTop);
  };

  return {
    collectChatPairs,
    collectSelectionMessages: () => selectionMessagesFromPairs(collectChatPairs()),
    turnsForMessageIds: (selectedMessageIds) => {
      const pairs = collectChatPairs();
      if (selectedMessageIds.size === 0) return [];
      const selectedMessages = selectionMessagesFromPairs(pairs).filter((message) =>
        selectedMessageIds.has(message.messageId),
      );
      return buildTurnsForSelectedMessages(selectedMessages);
    },
    assistantMessageIdFor: (trigger) => {
      if (!trigger) return null;

      const assistantHost = trigger.closest(
        '.response-container, response-container, .model-response, model-response',
      ) as HTMLElement | null;
      if (!assistantHost) return null;

      const messages = buildExportMessagesFromPairs(collectChatPairs());
      const target = messages.find((message) => {
        if (message.role !== 'assistant') return false;
        const host = message.hostElement;
        return (
          host === assistantHost ||
          host.contains(assistantHost) ||
          assistantHost.contains(host) ||
          host.contains(trigger)
        );
      });

      return target?.messageId || null;
    },
    topUserElement,
    conversationRoot,
    snapshotOpenCanvasDocs: () => {
      if (isAnyCanvasOpen()) cachedCanvasDocs = extractAllCanvasDocs();
    },
    releaseCanvasDocs: () => {
      cachedCanvasDocs = null;
      removeCanvasExportSections();
    },
  };
}
