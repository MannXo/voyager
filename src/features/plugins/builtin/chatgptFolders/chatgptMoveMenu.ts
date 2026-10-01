/**
 * "Move to folder" in a sidebar row's "Chat actions" menu. ChatGPT's rows are
 * not HTML5 drag sources, so this menu entry is how a conversation gets from the
 * sidebar into a folder without opening it first.
 *
 * Observed live (2026-10-01): the menu is a Radix menu portaled under `body` and
 * labelled by the row's trigger, which reads `aria-expanded="true"` while it is
 * open. The entry is a clone of a native item, so it inherits ChatGPT's look and
 * hover. Without `data-radix-collection-item`, Radix's arrow keys skip it: the
 * entry is pointer-only. Selecting it closes the menu with the Escape Radix
 * listens for, which also returns focus to the trigger.
 */
import type { ConversationReference } from '@/core/types/folder';

import { CHATGPT_CONVERSATION_ID_PREFIX } from './chatgptIdentity';
import { readMenuConversation, readSidebarTitle } from './chatgptSidebarDom';

export const MOVE_ENTRY_ATTR = 'data-gv-chatgpt-move-to-folder';

const OPEN_TRIGGER_SELECTOR = 'button[aria-haspopup="menu"][aria-expanded="true"][id]';
const ITEM_SELECTOR = '[role="menuitem"]';
const FOLDER_ICON_PATH =
  'M160-160q-33 0-56.5-23.5T80-240v-480q0-33 23.5-56.5T160-800h240l80 80h320q33 0 56.5 23.5T880-640v400q0 33-23.5 56.5T800-160H160Zm0-80h640v-400H447l-80-80H160v480Zm0 0v-480 480Z';

function folderIcon(): SVGSVGElement {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 -960 960 960');
  svg.setAttribute('width', '20');
  svg.setAttribute('height', '20');
  svg.setAttribute('fill', 'currentColor');
  svg.setAttribute('aria-hidden', 'true');
  const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  path.setAttribute('d', FOLDER_ICON_PATH);
  svg.append(path);
  return svg;
}

/** A native item's look with this entry's icon and label, and no Radix wiring. */
function buildEntry(template: Element, label: string): HTMLElement {
  const entry = template.cloneNode(true) as HTMLElement;
  for (const name of [
    'id',
    'data-radix-collection-item',
    'data-highlighted',
    'data-disabled',
    'aria-disabled',
    'aria-haspopup',
    'aria-expanded',
    'aria-controls',
    'data-state',
  ]) {
    entry.removeAttribute(name);
  }
  entry.setAttribute(MOVE_ENTRY_ATTR, '');
  entry.setAttribute('tabindex', '-1');
  const icon = entry.querySelector('[aria-hidden="true"]');
  icon?.replaceChildren(folderIcon());
  const texts: Text[] = [];
  const walker = document.createTreeWalker(entry, NodeFilter.SHOW_TEXT);
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    if (node.nodeValue?.trim() && !icon?.contains(node)) texts.push(node as Text);
  }
  if (texts.length === 0) {
    entry.append(label);
  } else {
    texts[0].nodeValue = label;
    for (const extra of texts.slice(1)) extra.remove();
  }
  return entry;
}

function closeMenu(menu: HTMLElement): void {
  menu.dispatchEvent(
    new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }),
  );
}

export interface MoveMenuOptions {
  readonly label: () => string;
  readonly untitled: () => string;
  /** Whether a conversation can be filed right now (the store is ready). */
  readonly canFile: () => boolean;
  readonly onMove: (conversation: ConversationReference) => void;
}

/** Frames to wait for a menu whose content was not rendered with its trigger. */
const MENU_WAIT_FRAMES = 10;

/**
 * Adds the entry to a row's open "Chat actions" menu. `check` runs after every
 * sidebar change and leaves an entry already in the open menu alone. It returns
 * whether to check again next frame: a trigger is open but its menu is not
 * rendered yet. That wait is bounded per trigger.
 */
export class ChatGptMoveMenu {
  private waitingFor: Element | null = null;
  private waitedFrames = 0;

  constructor(
    private readonly options: MoveMenuOptions,
    private readonly doc: Document = document,
  ) {}

  check(sidebar: HTMLElement | null): boolean {
    const trigger = sidebar?.querySelector<HTMLElement>(OPEN_TRIGGER_SELECTOR) ?? null;
    if (!trigger || !this.options.canFile()) {
      this.waitingFor = null;
      return false;
    }
    // Radix ids (`radix-:r1a:`) need escaping in a selector; compare instead.
    const menu = [...this.doc.querySelectorAll<HTMLElement>('[role="menu"][aria-labelledby]')].find(
      (candidate) => candidate.getAttribute('aria-labelledby') === trigger.id,
    );
    if (!menu) {
      if (this.waitingFor !== trigger) {
        this.waitingFor = trigger;
        this.waitedFrames = 0;
      }
      this.waitedFrames += 1;
      return this.waitedFrames <= MENU_WAIT_FRAMES;
    }
    this.waitingFor = null;
    if (!menu.querySelector(`[${MOVE_ENTRY_ATTR}]`)) this.inject(menu);
    return false;
  }

  private inject(menu: HTMLElement): void {
    const row = readMenuConversation(menu, this.doc);
    if (!row) return;
    const items = [...menu.querySelectorAll<HTMLElement>(ITEM_SELECTOR)].filter(
      (item) => item.closest('[role="menu"]') === menu,
    );
    const template = items.find((item) => !item.hasAttribute('aria-haspopup'));
    if (!template) return;

    const conversation: ConversationReference = {
      conversationId: `${CHATGPT_CONVERSATION_ID_PREFIX}${row.id}`,
      title: readSidebarTitle(row) || this.options.untitled(),
      url: `${this.doc.location.origin}${row.path}`,
      addedAt: 0,
    };
    const entry = buildEntry(template, this.options.label());
    entry.addEventListener('click', (event) => {
      event.preventDefault();
      event.stopPropagation();
      closeMenu(menu);
      this.options.onMove({ ...conversation, addedAt: Date.now() });
    });
    // Next to ChatGPT's own "Move to project" (its only submenu), else last.
    const anchor = items.find((item) => item.hasAttribute('aria-haspopup')) ?? items.at(-1);
    anchor?.after(entry);
  }
}
