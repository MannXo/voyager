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

function excluded(element: Element): boolean {
  return (
    element.matches(EXCLUDED_SELECTOR) ||
    element.hasAttribute('hidden') ||
    element.getAttribute('aria-hidden') === 'true' ||
    Array.from(element.classList).some(
      (name) =>
        name.startsWith('gv-') ||
        name.includes('visually-hidden') ||
        name === 'sr-only' ||
        name === 'screen-reader-only',
    ) ||
    (element instanceof HTMLElement &&
      (element.style.display === 'none' || element.style.visibility === 'hidden'))
  );
}

export function userTurnText(element: HTMLElement): string {
  const clone = element.cloneNode(true) as HTMLElement;
  if (excluded(clone)) return '';
  clone.querySelectorAll('mark.gv-highlight-mark').forEach((mark) => {
    mark.replaceWith(...mark.childNodes);
  });
  clone.querySelectorAll('*').forEach((node) => {
    if (excluded(node)) node.remove();
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
