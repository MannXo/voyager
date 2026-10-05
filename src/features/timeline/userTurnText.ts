const USER_CONTENT_SELECTOR = '[data-user-message-bubble], .query-text, .ds-collapsible-text';
const EXCLUDED_SELECTOR =
  'button, [role="button"], script, style, template, model-response, [data-message-author-role="assistant"], [data-conversation-role="assistant"]';
const BLOCK_TAGS = new Set([
  'ADDRESS',
  'ARTICLE',
  'BLOCKQUOTE',
  'DIV',
  'DL',
  'DT',
  'DD',
  'FIGCAPTION',
  'FIGURE',
  'H1',
  'H2',
  'H3',
  'H4',
  'H5',
  'H6',
  'LI',
  'OL',
  'P',
  'PRE',
  'SECTION',
  'TABLE',
  'TR',
  'UL',
]);

const HIGHLIGHT_MARK_SELECTOR = 'mark.gv-highlight-mark';

function excluded(element: Element): boolean {
  // Voyager highlight wrappers carry the user's authored text, not injected UI.
  if (element.matches(HIGHLIGHT_MARK_SELECTOR)) return false;
  if (
    element.matches(EXCLUDED_SELECTOR) ||
    element.hasAttribute('hidden') ||
    element.getAttribute('aria-hidden') === 'true' ||
    Array.from(element.classList).some(
      (name) =>
        name.startsWith('gv-') ||
        name.includes('visually-hidden') ||
        name === 'sr-only' ||
        name === 'screen-reader-only',
    )
  )
    return true;
  // Host stylesheets hide alternatives and internal labels; only the connected original knows that.
  return getComputedStyle(element).display === 'none';
}

export interface UserTurnCapture {
  /** Changes whenever which nodes count as visible changes, even if the markup does not. */
  readonly visibilityKey: string;
  readonly read: () => string;
}

/** Decide hidden nodes on the connected original, before a detached clone loses computed styles. */
export function captureUserTurn(element: HTMLElement): UserTurnCapture {
  const dropped: number[] = [];
  const invisible = new Map<Element, boolean>();
  const hidesText = (parent: Element): boolean => {
    let hidden = invisible.get(parent);
    if (hidden === undefined) {
      hidden = getComputedStyle(parent).visibility === 'hidden';
      invisible.set(parent, hidden);
    }
    return hidden;
  };
  let index = 0;
  const walk = (node: Node): void => {
    const position = index++;
    if (node.nodeType === Node.TEXT_NODE) {
      const parent = node.parentElement;
      if (parent && hidesText(parent)) dropped.push(position);
      return;
    }
    if (node instanceof Element && excluded(node)) {
      dropped.push(position);
      return;
    }
    node.childNodes.forEach(walk);
  };
  if (excluded(element)) return { visibilityKey: 'root', read: () => '' };
  index++;
  element.childNodes.forEach(walk);
  return {
    visibilityKey: dropped.join(','),
    read: () => extract(element, new Set(dropped)),
  };
}

export function userTurnText(element: HTMLElement): string {
  return captureUserTurn(element).read();
}

function extract(element: HTMLElement, dropped: ReadonlySet<number>): string {
  const clone = element.cloneNode(true) as HTMLElement;
  const removals: Node[] = [];
  let index = 1;
  const walk = (node: Node): void => {
    if (dropped.has(index++)) {
      removals.push(node);
      return;
    }
    if (node.nodeType !== Node.TEXT_NODE) node.childNodes.forEach(walk);
  };
  clone.childNodes.forEach(walk);
  removals.forEach((node) => node.parentNode?.removeChild(node));
  clone.querySelectorAll(HIGHLIGHT_MARK_SELECTOR).forEach((mark) => {
    mark.replaceWith(...mark.childNodes);
  });
  const content = clone.matches(USER_CONTENT_SELECTOR)
    ? clone
    : (clone.querySelector<HTMLElement>(USER_CONTENT_SELECTOR) ?? clone);
  for (const node of [
    content,
    ...content.querySelectorAll<HTMLElement>('[data-user-latex-original]'),
  ]) {
    const original = node.getAttribute('data-user-latex-original');
    if (original !== null) node.textContent = original;
  }
  let text = '';
  let syntheticNewline = false;
  const newline = () => {
    if (text && !text.endsWith('\n')) {
      text += '\n';
      syntheticNewline = true;
    }
  };
  const visit = (node: Node): void => {
    if (node.nodeType === Node.TEXT_NODE) {
      const value = (node.nodeValue ?? '').replace(/\r\n?/g, '\n');
      text += value;
      if (value) syntheticNewline = false;
    } else if (node instanceof Element) {
      if (node.tagName === 'BR') {
        text += '\n';
        syntheticNewline = false;
        return;
      }
      const block = BLOCK_TAGS.has(node.tagName);
      if (block) newline();
      node.childNodes.forEach(visit);
      if (block) newline();
    }
  };
  visit(content);
  return syntheticNewline ? text.slice(0, -1) : text;
}
