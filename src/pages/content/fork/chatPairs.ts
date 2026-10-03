import { getGeminiTurnSelectors } from '@/core/gemini/turnSelectors';
import { createContentExtractor } from '@/features/export/services/DOMContentExtractor';

import { resolveExportAdapter } from '../export/adapter/platformAdapters';
import {
  filterOutDeepResearchImmersiveNodes,
  findFirstElementBetweenTurns,
  resolveConversationRoot,
} from '../export/conversationDom';
import { makeTurnId } from './turnId';

export interface ForkChatPair {
  turnId: string;
  user: string;
  assistant: string;
  userElement: HTMLElement;
}

function normalizeText(text: string | null): string {
  if (!text) return '';
  return text.replace(/\s+/g, ' ').trim();
}

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
  const arr = elements.map((element) => element as HTMLElement);
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

function getUserSelectors(): string[] {
  const configured = (() => {
    try {
      return (
        localStorage.getItem('geminiTimelineUserTurnSelector') ||
        localStorage.getItem('geminiTimelineUserTurnSelectorAuto') ||
        ''
      );
    } catch {
      return '';
    }
  })();

  const defaults = getGeminiTurnSelectors('turn.user');
  return configured
    ? [configured, ...defaults.filter((selector) => selector !== configured)]
    : defaults;
}

function getAssistantSelectors(): string[] {
  return [
    ...getGeminiTurnSelectors('turn.assistant'),
    ...getGeminiTurnSelectors('turn.assistantFallback'),
  ];
}

function pickAssistantExportElement(assistantHost: HTMLElement): HTMLElement {
  return (
    queryOutsideThoughts<HTMLElement>(assistantHost, 'message-content') ||
    queryOutsideThoughts<HTMLElement>(assistantHost, '.markdown, .markdown-main-panel') ||
    (assistantHost.closest('.presented-response-container') as HTMLElement | null) ||
    queryOutsideThoughts<HTMLElement>(
      assistantHost,
      '.presented-response-container, .response-content',
    ) ||
    queryOutsideThoughts<HTMLElement>(assistantHost, 'response-element') ||
    assistantHost
  );
}

export function collectForkChatPairs(): ForkChatPair[] {
  const userSelectors = getUserSelectors();
  const assistantSelectors = getAssistantSelectors();
  const root = resolveConversationRoot({ userSelectors, doc: document });

  const userNodesRaw = filterOutDeepResearchImmersiveNodes(
    Array.from(root.querySelectorAll<HTMLElement>(userSelectors.join(','))),
  );
  if (userNodesRaw.length === 0) return [];

  const users = filterTopLevel(userNodesRaw);
  if (users.length === 0) return [];

  const assistantNodesRaw = filterOutDeepResearchImmersiveNodes(
    Array.from(root.querySelectorAll<HTMLElement>(assistantSelectors.join(','))),
  );
  const assistants = filterTopLevel(assistantNodesRaw);

  const extractor = createContentExtractor(resolveExportAdapter());
  const pairs: ForkChatPair[] = [];

  for (let i = 0; i < users.length; i++) {
    const userEl = users[i];
    const turnId = makeTurnId(userEl, i);
    userEl.dataset.turnId = turnId;

    const userExtracted = extractor.extractUserContent(userEl).text;
    const userText = userExtracted || normalizeText(userEl.innerText || userEl.textContent || '');

    let assistantHost = findFirstElementBetweenTurns(userEl, users[i + 1], assistants);

    if (!assistantHost) {
      let sib: HTMLElement | null = userEl;
      for (let step = 0; step < 8 && sib; step++) {
        sib = sib.nextElementSibling as HTMLElement | null;
        if (!sib) break;
        if (sib.matches(userSelectors.join(','))) break;
        if (sib.matches(assistantSelectors.join(','))) {
          assistantHost = sib;
          break;
        }
      }
    }

    let assistantText = '';
    if (assistantHost) {
      const assistantExportEl = pickAssistantExportElement(assistantHost);
      const extracted = extractor.extractAssistantContent(assistantExportEl).text;
      assistantText =
        extracted ||
        normalizeText(assistantExportEl.innerText || assistantExportEl.textContent || '');
    }

    if (userText || assistantText) {
      pairs.push({
        turnId,
        user: userText,
        assistant: assistantText,
        userElement: userEl,
      });
    }
  }

  return pairs;
}
