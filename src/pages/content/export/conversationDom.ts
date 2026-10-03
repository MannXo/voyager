type ResolveConversationRootOptions = {
  userSelectors: string[];
  doc?: Document;
};

const CONVERSATION_ROOT_CANDIDATES = [
  '#chat-history',
  'infinite-scroller.chat-history',
  'chat-window-content',
  'main',
];

export function filterOutDeepResearchImmersiveNodes<T extends HTMLElement>(elements: T[]): T[] {
  return elements.filter((element) => !element.closest('deep-research-immersive-panel'));
}

// Virtualized turns have incomparable offset parents; DOM order bounds replies by the next prompt.
// Repeated prompt text still represents separate turns.
export function findFirstElementBetweenTurns(
  currentTurn: HTMLElement,
  nextTurn: HTMLElement | undefined,
  candidates: readonly HTMLElement[],
): HTMLElement | null {
  for (const candidate of candidates) {
    const followsCurrent = !!(
      currentTurn.compareDocumentPosition(candidate) & Node.DOCUMENT_POSITION_FOLLOWING
    );
    const precedesNext =
      !nextTurn ||
      !!(candidate.compareDocumentPosition(nextTurn) & Node.DOCUMENT_POSITION_FOLLOWING);

    if (followsCurrent && precedesNext) return candidate;
  }

  return null;
}

function hasVisibleUserTurns(root: HTMLElement, userSelectors: string[]): boolean {
  if (userSelectors.length === 0) return false;
  const nodes = filterOutDeepResearchImmersiveNodes(
    Array.from(root.querySelectorAll<HTMLElement>(userSelectors.join(','))),
  );
  return nodes.length > 0;
}

export function resolveConversationRoot({
  userSelectors,
  doc = document,
}: ResolveConversationRootOptions): HTMLElement {
  const body = doc.body as HTMLElement;
  let firstCandidate: HTMLElement | null = null;

  for (const selector of CONVERSATION_ROOT_CANDIDATES) {
    const candidate = doc.querySelector(selector) as HTMLElement | null;
    if (!candidate) continue;
    if (!firstCandidate) firstCandidate = candidate;
    if (hasVisibleUserTurns(candidate, userSelectors)) return candidate;
  }

  return firstCandidate || body;
}
