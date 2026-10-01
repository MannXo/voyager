/**
 * Drives AI Studio's folder tree the way a user does, so the characterization
 * suite states behaviour once and survives a change of tree DOM.
 */
import { AISTUDIO_ROOT_BUCKET_ID } from '@/features/folder/constants';

export const ROOT = AISTUDIO_ROOT_BUCKET_ID;

export type FakeTransfer = {
  readonly types: string[];
  getData: (type: string) => string;
  setData: (type: string, value: string) => void;
  setDragImage: () => void;
  effectAllowed: string;
  dropEffect: string;
};

export function fakeTransfer(data: Record<string, string> = {}): FakeTransfer {
  const store = new Map(Object.entries(data));
  return {
    get types() {
      return [...store.keys()];
    },
    getData: (type) => store.get(type) ?? '',
    setData: (type, value) => void store.set(type, value),
    setDragImage: () => {},
    effectAllowed: 'all',
    dropEffect: 'none',
  };
}

/** What AI Studio's own binding puts on a drag from a native prompt row. */
export function nativeRowTransfer(conversationId: string, title: string): FakeTransfer {
  const json = JSON.stringify({
    type: 'conversation',
    conversationId,
    title,
    url: `https://aistudio.google.com/prompts/${conversationId}`,
  });
  return fakeTransfer({ 'application/json': json, 'text/plain': json });
}

function dragEvent(type: string, transfer: FakeTransfer): Event {
  const event = new Event(type, { bubbles: true, cancelable: true, composed: true });
  Object.defineProperty(event, 'dataTransfer', { value: transfer });
  return event;
}

function list(): HTMLElement {
  const element = document.querySelector<HTMLElement>('.gv-folder-list');
  if (!element) throw new Error('folder list is not mounted');
  return element;
}

function folderElement(folderId: string): HTMLElement {
  const element = list().querySelector<HTMLElement>(
    `.gv-folder-item[data-folder-id="${folderId}"]`,
  );
  if (!element) throw new Error(`folder ${folderId} is not rendered`);
  return element;
}

function folderHeader(folderId: string): HTMLElement {
  return folderElement(folderId).querySelector<HTMLElement>(':scope > .gv-folder-item-header')!;
}

function conversationRow(bucketId: string, conversationId: string): HTMLElement {
  const row = list().querySelector<HTMLElement>(
    `.gv-folder-conversation[data-folder-id="${bucketId}"][data-conversation-id="${conversationId}"]`,
  );
  if (!row) throw new Error(`conversation ${bucketId}/${conversationId} is not rendered`);
  return row;
}

function menuItem(folderId: string, label: string): HTMLButtonElement | null {
  folderHeader(folderId).querySelector<HTMLButtonElement>('.gv-folder-actions-btn')!.click();
  const items = Array.from(document.querySelectorAll<HTMLButtonElement>('.gv-folder-menu-item'));
  return items.find((item) => item.textContent?.includes(label)) ?? null;
}

function closeMenus(): void {
  document.querySelectorAll('.gv-aistudio-folder-menu').forEach((menu) => menu.remove());
}

function submitName(name: string): void {
  const input = nameInput();
  if (!input) throw new Error('no folder name input is open');
  input.value = name;
  input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
}

export function nameInput(): HTMLInputElement | null {
  return list().querySelector<HTMLInputElement>(
    '.gv-folder-inline-input input, .gv-folder-rename-inline input',
  );
}

export const tree = {
  text: (): string => list().textContent ?? '',

  /** Rendered folders in order; a subfolder reads `Parent › Child`. */
  folderOrder: (): string[] =>
    Array.from(list().querySelectorAll<HTMLElement>('.gv-folder-item'), (item) => {
      const name = item.querySelector(':scope > .gv-folder-item-header .gv-folder-name');
      const parent = item.parentElement?.closest<HTMLElement>('.gv-folder-item');
      const parentName = parent?.querySelector(':scope > .gv-folder-item-header .gv-folder-name');
      return parentName
        ? `${parentName.textContent} › ${name?.textContent}`
        : (name?.textContent ?? '');
    }),

  isRendered: (folderId: string): boolean =>
    !!list().querySelector(`.gv-folder-item[data-folder-id="${folderId}"]`),

  conversationIds: (bucketId: string): string[] =>
    Array.from(
      list().querySelectorAll<HTMLElement>(`.gv-folder-conversation[data-folder-id="${bucketId}"]`),
      (row) => row.dataset.conversationId ?? '',
    ),

  /** The heading over root conversations, or null while that section is hidden. */
  rootSectionLabel: (): string | null =>
    Array.from(list().querySelector('.gv-folder-uncategorized-header')?.childNodes ?? [], (node) =>
      node instanceof Element && node.matches('.google-symbols') ? '' : node.textContent,
    )
      .join('')
      .trim() || null,

  /** Whether the root section comes after every folder. */
  rootSectionIsLast: (): boolean => {
    const section = list().querySelector('.gv-folder-uncategorized');
    const folders = list().querySelectorAll('.gv-folder-item');
    const last = folders[folders.length - 1];
    return !!section && (!last || !!(last.compareDocumentPosition(section) & 4));
  },

  activeConversationIds: (): string[] =>
    Array.from(
      list().querySelectorAll<HTMLElement>('.gv-folder-conversation-selected'),
      (row) => row.dataset.conversationId ?? '',
    ),

  isStarredInView: (bucketId: string, conversationId: string): boolean =>
    conversationRow(bucketId, conversationId).classList.contains('gv-starred'),

  openConversation: (bucketId: string, conversationId: string): void =>
    conversationRow(bucketId, conversationId).click(),

  toggleExpanded: (folderId: string): void =>
    folderHeader(folderId).querySelector<HTMLButtonElement>('.gv-folder-expand-btn')!.click(),

  togglePinned: (folderId: string): void =>
    folderHeader(folderId).querySelector<HTMLButtonElement>('.gv-folder-pin-btn')!.click(),

  toggleStar: (bucketId: string, conversationId: string): void =>
    conversationRow(bucketId, conversationId)
      .querySelector<HTMLButtonElement>('.gv-conversation-star-btn')!
      .click(),

  /** Asks to remove a filed conversation; the question must still be answered. */
  requestRemoval: (bucketId: string, conversationId: string): void =>
    conversationRow(bucketId, conversationId)
      .querySelector<HTMLButtonElement>('.gv-conversation-remove-btn')!
      .click(),

  /** Text of the open removal question, or null. */
  pendingQuestion: (): string | null =>
    document.querySelector('.gv-aistudio-confirm .gv-confirm-message')?.textContent ?? null,

  answer: (confirm: boolean): void =>
    document
      .querySelector<HTMLButtonElement>(
        confirm
          ? '.gv-aistudio-confirm .gv-confirm-delete'
          : '.gv-aistudio-confirm .gv-confirm-cancel',
      )!
      .click(),

  canCreateSubfolder: (folderId: string): boolean => {
    const item = menuItem(folderId, 'Create subfolder');
    closeMenus();
    return item !== null;
  },

  createSubfolder: (folderId: string, name: string): void => {
    menuItem(folderId, 'Create subfolder')!.click();
    submitName(name);
  },

  createRootFolder: (name: string): void => {
    document.querySelector<HTMLButtonElement>('.gv-folder-add-btn')!.click();
    submitName(name);
  },

  startRootFolder: (): void =>
    document.querySelector<HTMLButtonElement>('.gv-folder-add-btn')!.click(),

  rename: (folderId: string, name: string): void => {
    folderHeader(folderId)
      .querySelector('.gv-folder-name')!
      .dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
    submitName(name);
  },

  /** Asks to delete a folder; answer with `answer(true)`. */
  requestFolderDeletion: (folderId: string): void => menuItem(folderId, 'Delete')!.click(),

  dropTarget: (bucketId: string): HTMLElement =>
    bucketId === ROOT
      ? list().querySelector<HTMLElement>('.gv-folder-root-drop')!
      : folderHeader(bucketId),

  /** Starts a drag on a filed row and returns what the row put on the drag. */
  dragRow: (bucketId: string, conversationId: string): FakeTransfer => {
    const transfer = fakeTransfer();
    conversationRow(bucketId, conversationId).dispatchEvent(dragEvent('dragstart', transfer));
    return transfer;
  },

  /** Drags over then drops on `target`; returns whether the drag was accepted at dragover. */
  drop: (target: HTMLElement, transfer: FakeTransfer): boolean => {
    target.dispatchEvent(dragEvent('dragenter', transfer));
    const over = dragEvent('dragover', transfer);
    target.dispatchEvent(over);
    target.dispatchEvent(dragEvent('drop', transfer));
    return over.defaultPrevented;
  },

  libraryButton: (): HTMLButtonElement | null =>
    document.querySelector<HTMLButtonElement>('.gv-folder-library-btn'),
};
