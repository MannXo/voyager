/**
 * The shared folder tree's site options. Each is off by default, so the
 * floating panel and ChatGPT keep their tree; each case pins both sides.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

import { cls } from '../floatingTree/shared';
import type { TreeActions, TreeSiteOptions } from '../floatingTree/shared';
import { type FolderTreeController, mountFolderTree } from '../floatingTree/treeController';
import type { ConversationReference, Folder, FolderData } from '../types';

vi.mock('@/utils/i18n', () => ({ getTranslationSyncUnsafe: (key: string) => key }));

const ROOT = 'root-bucket';
const mounted: Array<{ tree: FolderTreeController; host: HTMLElement }> = [];

function folder(id: string, name: string, extra: Partial<Folder> = {}): Folder {
  return { id, name, parentId: null, isExpanded: true, createdAt: 1, updatedAt: 1, ...extra };
}

function conv(id: string, extra: Partial<ConversationReference> = {}): ConversationReference {
  return {
    conversationId: id,
    title: `Title ${id}`,
    url: `https://x.test/${id}`,
    addedAt: 1,
    ...extra,
  };
}

function data(): FolderData {
  return {
    folders: [
      folder('z', 'Zeta', { createdAt: 1, sortIndex: 1 }),
      folder('a', 'Alpha', { createdAt: 2, sortIndex: 0 }),
      folder('m', 'Mu', { createdAt: 3, pinned: true }),
    ],
    folderContents: {
      z: [
        conv('old', { addedAt: 1 }),
        conv('star', { addedAt: 2, starred: true }),
        conv('new', { addedAt: 3 }),
      ],
      a: [],
      m: [],
      [ROOT]: [conv('loose')],
    },
  };
}

function mount(
  site?: TreeSiteOptions,
  actions: TreeActions = {},
  initial: FolderData = data(),
): { tree: FolderTreeController; root: ShadowRoot } {
  const host = document.createElement('div');
  const root = host.attachShadow({ mode: 'open' });
  const body = document.createElement('div');
  root.appendChild(body);
  document.body.appendChild(host);
  const tree = mountFolderTree({
    body,
    boundary: host,
    focusRoot: root,
    data: initial,
    rootBucketId: ROOT,
    conversationSortMode: 'manual',
    actions,
    site,
  });
  mounted.push({ tree, host });
  return { tree, root };
}

const q = (root: ParentNode, part: string) => root.querySelector<HTMLElement>(`.${cls(part)}`);
const all = (root: ParentNode, part: string) =>
  Array.from(root.querySelectorAll<HTMLElement>(`.${cls(part)}`));
const folderNames = (root: ParentNode) => all(root, 'folder-name').map((el) => el.textContent);
const convIds = (root: ParentNode, bucket: string) =>
  Array.from(
    root.querySelectorAll<HTMLElement>(`.${cls('conv')}[data-folder-id="${bucket}"]`),
    (row) => row.dataset.conversationId,
  );
const header = (root: ParentNode, id: string) =>
  root.querySelector<HTMLElement>(`.${cls('folder-header')}[data-folder-id="${id}"]`)!;

function transfer(data: Record<string, string>) {
  return {
    types: Object.keys(data),
    getData: (type: string) => data[type] ?? '',
    dropEffect: 'none',
  };
}

/** Returns whether dragover was accepted. */
function drop(target: HTMLElement, data: Record<string, string>): boolean {
  const dataTransfer = transfer(data);
  const over = new Event('dragover', { bubbles: true, cancelable: true });
  Object.defineProperty(over, 'dataTransfer', { value: dataTransfer });
  target.dispatchEvent(over);
  const dropped = new Event('drop', { bubbles: true, cancelable: true });
  Object.defineProperty(dropped, 'dataTransfer', { value: dataTransfer });
  target.dispatchEvent(dropped);
  return over.defaultPrevented;
}

const nativeRow = {
  'text/uri-list': 'https://x.test/native',
  'application/json': JSON.stringify({
    type: 'conversation',
    conversationId: 'native',
    title: 'N',
  }),
};

afterEach(() => {
  for (const { tree, host } of mounted.splice(0)) {
    tree.destroy();
    host.remove();
  }
});

describe('folderOrder', () => {
  it('created: pinned first, then oldest first', () => {
    expect(folderNames(mount({ folderOrder: 'created' }).root)).toEqual(['Mu', 'Zeta', 'Alpha']);
  });

  it('default: pinned first, then sortIndex', () => {
    expect(folderNames(mount().root)).toEqual(['Mu', 'Alpha', 'Zeta']);
  });
});

describe('conversationOrder', () => {
  it('stored: keeps the bucket order', () => {
    expect(convIds(mount({ conversationOrder: 'stored' }).root, 'z')).toEqual([
      'old',
      'star',
      'new',
    ]);
  });

  it('default: starred first, then most recent', () => {
    expect(convIds(mount().root, 'z')).toEqual(['star', 'new', 'old']);
  });
});

describe('rootSection', () => {
  it('puts root conversations under the heading after the folders', () => {
    const { root } = mount({ rootSection: { labelKey: 'folder_uncategorized' } });
    const section = q(root, 'root-section')!;
    expect(q(section, 'root-section-title')?.textContent).toBe('folder_uncategorized');
    expect(convIds(root, ROOT)).toEqual(['loose']);
    // Rows are flat siblings: the heading follows the last folder, and the root
    // conversations follow the heading.
    const lastFolder = all(root, 'folder').at(-1)!;
    expect(
      lastFolder.compareDocumentPosition(section) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    expect(
      section.compareDocumentPosition(
        root.querySelector(`.${cls('conv')}[data-folder-id="${ROOT}"]`)!,
      ) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
  });

  it('hides the heading while the root bucket is empty but keeps a drop target, even with no folders', () => {
    const onDrop = vi.fn(() => true);
    const { root } = mount(
      { rootSection: { labelKey: 'folder_uncategorized' } },
      { onDrop, acceptsDrag: () => true },
      { folders: [], folderContents: {} },
    );
    expect(q(root, 'root-section')).toBeNull();
    expect(q(root, 'empty')).not.toBeNull();
    expect(drop(q(root, 'root-drop')!, nativeRow)).toBe(true);
    expect(onDrop).toHaveBeenCalledWith(expect.anything(), ROOT);
  });

  it('default: root conversations come first, with no heading or drop strip', () => {
    const { root } = mount();
    expect(q(root, 'root-section')).toBeNull();
    expect(q(root, 'root-drop')).toBeNull();
    const firstRow = q(root, 'conv')!;
    expect(firstRow.dataset.folderId).toBe(ROOT);
    expect(
      firstRow.compareDocumentPosition(q(root, 'folder')!) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
  });
});

describe('activeConversationId', () => {
  it('marks only the open conversation, and follows a change', () => {
    const { root, tree } = mount({ activeConversationId: 'star' });
    expect(all(root, 'conv--active').map((row) => row.dataset.conversationId)).toEqual(['star']);
    expect(root.querySelector('[aria-current="page"]')?.textContent).toBe('Title star');

    tree.setSite({ activeConversationId: 'loose' });
    expect(all(root, 'conv--active').map((row) => row.dataset.conversationId)).toEqual(['loose']);
  });

  it('default: marks nothing', () => {
    const { root } = mount();
    expect(all(root, 'conv--active')).toEqual([]);
    expect(root.querySelector('[aria-current]')).toBeNull();
  });
});

describe('folderMenuButton', () => {
  it('opens the folder menu from a labelled button', () => {
    const { root } = mount({ folderMenuButton: { labelKey: 'folder_settings' } });
    const button = header(root, 'a').querySelector<HTMLButtonElement>(
      `.${cls('icon-button--menu')}`,
    )!;
    expect(button.getAttribute('aria-label')).toBe('folder_settings');
    button.click();
    expect(q(root, 'context-menu')?.textContent).toContain('floatingPanelRenameFolder');
  });

  it('default: no button; the menu opens on right-click', () => {
    const { root } = mount();
    expect(q(root, 'icon-button--menu')).toBeNull();
    header(root, 'a').dispatchEvent(
      new MouseEvent('contextmenu', { bubbles: true, cancelable: true }),
    );
    expect(q(root, 'context-menu')).not.toBeNull();
  });
});

describe('onDrop and acceptsDrag', () => {
  it('hand every drop, including a native row with no source folder, to the site', () => {
    const onDrop = vi.fn(() => true);
    const onMoveConversation = vi.fn();
    const { root } = mount(undefined, {
      onDrop,
      acceptsDrag: (types) => types.includes('text/uri-list'),
      onMoveConversation,
    });
    expect(drop(header(root, 'a'), { 'text/uri-list': 'https://x.test/native' })).toBe(true);
    expect(onDrop).toHaveBeenCalledWith(expect.anything(), 'a');
    expect(drop(header(root, 'a'), { 'text/html': '<b>x</b>' })).toBe(false);
    expect(onMoveConversation).not.toHaveBeenCalled();
  });

  it('default: only Voyager JSON with a source folder moves, through onMoveConversation', () => {
    const onMoveConversation = vi.fn();
    const { root } = mount(undefined, { onMoveConversation });
    expect(drop(header(root, 'a'), { 'text/uri-list': 'https://x.test/native' })).toBe(false);
    drop(header(root, 'a'), nativeRow);
    expect(onMoveConversation).not.toHaveBeenCalled();

    drop(header(root, 'a'), {
      'application/json': JSON.stringify({
        type: 'conversation',
        conversationId: 'old',
        sourceFolderId: 'z',
      }),
    });
    expect(onMoveConversation).toHaveBeenCalledWith('old', 'z', 'a');
  });
});

describe('folder colour', () => {
  it('is offered only when the site can store it', () => {
    const plain = mount();
    plain.root
      .querySelector<HTMLElement>(`.${cls('folder-header')}`)!
      .dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true }));
    expect(q(plain.root, 'color-section')).toBeNull();

    const coloured = mount(undefined, { onSetFolderColor: vi.fn() });
    coloured.root
      .querySelector<HTMLElement>(`.${cls('folder-header')}`)!
      .dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true }));
    expect(q(coloured.root, 'color-section')).not.toBeNull();
  });
});

describe('confirmFolderRemoval', () => {
  const openMenu = (root: ShadowRoot) =>
    header(root, 'a').dispatchEvent(
      new MouseEvent('contextmenu', { bubbles: true, cancelable: true }),
    );
  const deleteItem = (root: ParentNode) =>
    all(root, 'menu-item').find((item) => item.textContent === 'floatingPanelDeleteFolder')!;

  it("asks in the host's dialog and deletes only once it is answered yes", () => {
    let answer: (() => void) | undefined;
    const confirmFolderRemoval = vi.fn((_anchor: HTMLElement, onConfirm: () => void) => {
      answer = onConfirm;
    });
    const onDeleteFolder = vi.fn();
    const { root } = mount(undefined, { confirmFolderRemoval, onDeleteFolder });
    openMenu(root);
    deleteItem(root).click();

    expect(confirmFolderRemoval).toHaveBeenCalledWith(
      expect.any(HTMLElement),
      expect.any(Function),
    );
    expect(q(root, 'context-menu')).toBeNull();
    expect(onDeleteFolder).not.toHaveBeenCalled();
    answer!();
    expect(onDeleteFolder).toHaveBeenCalledWith('a');
  });

  it('default: the menu turns into an inline Delete / Cancel confirm', () => {
    const onDeleteFolder = vi.fn();
    const { root } = mount(undefined, { onDeleteFolder });
    openMenu(root);
    deleteItem(root).click();

    expect(q(root, 'context-menu--confirming')).not.toBeNull();
    expect(onDeleteFolder).not.toHaveBeenCalled();
    deleteItem(root).click();
    expect(onDeleteFolder).toHaveBeenCalledWith('a');
  });
});

describe('folderBodyDrop', () => {
  function nestedData(): FolderData {
    const nested = data();
    nested.folders.push(folder('zc', 'Zeta child', { parentId: 'z', createdAt: 4 }));
    nested.folderContents.zc = [conv('inner')];
    return nested;
  }
  const row = (root: ParentNode, bucket: string, id: string) =>
    root.querySelector<HTMLElement>(
      `.${cls('conv')}[data-folder-id="${bucket}"][data-conversation-id="${id}"]`,
    )!;
  // Rows are flat: a conversation row stands for its folder's body.
  const lit = (root: ParentNode) =>
    all(root, 'drop-target').map((el) =>
      el.classList.contains(cls('conv'))
        ? `body:${el.dataset.folderId}`
        : `header:${el.dataset.folderId}`,
    );
  const dragOver = (target: HTMLElement) => {
    const over = new Event('dragover', { bubbles: true, cancelable: true, composed: true });
    Object.defineProperty(over, 'dataTransfer', { value: transfer(nativeRow) });
    target.dispatchEvent(over);
    return over.defaultPrevented;
  };

  it('takes a drop anywhere in the folder block, and the innermost folder wins', () => {
    const onDrop = vi.fn(() => true);
    const { root } = mount({ folderBodyDrop: true }, { onDrop }, nestedData());

    expect(drop(row(root, 'z', 'old'), nativeRow)).toBe(true);
    expect(onDrop).toHaveBeenLastCalledWith(expect.anything(), 'z');
    expect(drop(row(root, 'zc', 'inner'), nativeRow)).toBe(true);
    expect(onDrop).toHaveBeenLastCalledWith(expect.anything(), 'zc');
    expect(onDrop).toHaveBeenCalledTimes(2);
  });

  it('lights only the innermost target under the pointer', () => {
    const { root } = mount({ folderBodyDrop: true }, { onDrop: () => true }, nestedData());
    dragOver(header(root, 'zc'));
    expect(lit(root)).toEqual(['header:zc']);
    header(root, 'zc').dispatchEvent(new Event('dragleave', { bubbles: true }));
    dragOver(row(root, 'zc', 'inner'));
    expect(lit(root)).toEqual(['body:zc']);
  });

  it('keeps a same-folder drop from falling through to the parent folder', () => {
    const onMoveConversation = vi.fn();
    const { root } = mount({ folderBodyDrop: true }, { onMoveConversation }, nestedData());
    drop(row(root, 'zc', 'inner'), {
      'application/json': JSON.stringify({
        type: 'conversation',
        conversationId: 'inner',
        sourceFolderId: 'zc',
      }),
    });
    expect(onMoveConversation).not.toHaveBeenCalled();
  });

  it('default: only the header takes a drop', () => {
    const onDrop = vi.fn(() => true);
    const { root } = mount(undefined, { onDrop, acceptsDrag: () => true }, nestedData());
    expect(drop(row(root, 'z', 'old'), nativeRow)).toBe(false);
    expect(onDrop).not.toHaveBeenCalled();
  });
});
