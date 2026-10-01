/**
 * Pins floating panel behavior that `floatingPanel.test.ts` leaves open, ahead
 * of moving the panel into a shadow root. The panel has no search, and its only
 * keyboard handling is Enter/Escape in the inline name form. Floating mode and
 * the FAB are covered by `folderDisabledRuntime`, `FolderSidebarRuntime` and
 * `folderPositionEnforcer` tests.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

import { ROOT_CONVERSATIONS_ID } from '@/features/folder/constants';

import { mountFloatingPanel } from '../floatingPanel';
import {
  FLOATING_PANEL_CLASS,
  click,
  contextMenu,
  createConversation,
  createData,
  createDataTransfer,
  createDragEvent,
  createFolder,
  destroyMountedPanels,
  folderHeader,
  keydown,
  mountPanel,
  mousedown,
  panelRoot,
  part,
  pointerEvent,
  queryPart,
  setElementRect,
  setWindowSize,
  stubPointerCapture,
} from './floatingPanelHarness';

vi.mock('@/core/utils/browser', () => ({ isSafari: () => false }));
vi.mock('@/utils/i18n', () => ({ getTranslationSyncUnsafe: (key: string) => key }));

const originalWidth = window.innerWidth;
const originalHeight = window.innerHeight;

afterEach(() => {
  destroyMountedPanels();
  document.body.innerHTML = '';
  setWindowSize(originalWidth, originalHeight);
  vi.restoreAllMocks();
});

function folderBody(handle: ReturnType<typeof mountPanel>, folderId: string): HTMLElement {
  return folderHeader(panelRoot(handle), folderId).parentElement!.querySelector<HTMLElement>(
    `:scope > .${FLOATING_PANEL_CLASS}__folder-body`,
  )!;
}

describe('floating panel drifts from the sidebar tree, as they stand', () => {
  it('does not show conversations stored at the root', () => {
    const data = createData();
    data.folderContents[ROOT_CONVERSATIONS_ID] = [createConversation('root-conv', 'Root chat')];
    const handle = mountPanel({ data });

    expect(panelRoot(handle).textContent).not.toContain('Root chat');
    expect(panelRoot(handle).querySelector(`[data-conversation-id="root-conv"]`)).toBeNull();
  });

  it('keeps folder expansion local to the mounted panel', () => {
    const data = createData();
    const callbacks = {
      onCreateFolder: vi.fn(),
      onRenameFolder: vi.fn(),
      onToggleFolderPinned: vi.fn(),
      onMoveConversation: vi.fn(),
    };
    const handle = mountPanel({ data, ...callbacks });

    click(folderHeader(panelRoot(handle), 'folder-a'));
    expect(folderBody(handle, 'folder-a').style.display).toBe('none');
    for (const callback of Object.values(callbacks)) expect(callback).not.toHaveBeenCalled();
    expect(data.folders[0].isExpanded).toBe(true);

    const remounted = mountPanel({ data });
    expect(folderBody(remounted, 'folder-a').style.display).not.toBe('none');
  });

  it('removes a conversation without asking for confirmation', () => {
    const onRemoveConversation = vi.fn();
    const handle = mountPanel({ onRemoveConversation });

    click(part(handle, 'icon-button--remove'));

    expect(onRemoveConversation).toHaveBeenCalledWith('folder-a', 'conv-a');
    expect(document.querySelector('.gv-pm-confirm, .gv-folder-confirm-dialog')).toBeNull();
  });
});

describe('floating panel inline name form', () => {
  it('cancels on Escape and ignores an empty or unchanged name', () => {
    const onCreateFolder = vi.fn();
    const onRenameFolder = vi.fn();
    const handle = mountPanel({ onCreateFolder, onRenameFolder });

    click(part(handle, 'icon-button--create'));
    const escape = keydown(part(handle, 'inline-input'), 'Escape');
    expect(escape.defaultPrevented).toBe(true);
    expect(queryPart(handle, 'inline-input')).toBeNull();

    click(part(handle, 'icon-button--create'));
    const input = part<HTMLInputElement>(handle, 'inline-input');
    input.value = '   ';
    keydown(input, 'Enter');
    expect(queryPart(handle, 'inline-input')).toBeNull();
    expect(onCreateFolder).not.toHaveBeenCalled();

    folderHeader(panelRoot(handle), 'folder-a')
      .querySelector(`.${FLOATING_PANEL_CLASS}__folder-name`)!
      .dispatchEvent(new MouseEvent('dblclick', { bubbles: true, composed: true }));
    const rename = part<HTMLInputElement>(handle, 'inline-input');
    expect(rename.value).toBe('Alpha');
    keydown(rename, 'Enter');
    expect(onRenameFolder).not.toHaveBeenCalled();
  });

  it('stays open for a mousedown inside the form and saves from its button', () => {
    const onCreateFolder = vi.fn();
    const handle = mountPanel({ onCreateFolder });

    click(part(handle, 'icon-button--create'));
    const input = part<HTMLInputElement>(handle, 'inline-input');
    const inside = mousedown(input);
    expect(inside.defaultPrevented).toBe(false);
    expect(part(handle, 'inline-input')).toBe(input);

    input.value = '  Trimmed  ';
    click(part(handle, 'icon-button--save'));
    expect(onCreateFolder).toHaveBeenCalledWith('Trimmed', null);
  });

  it('caps the name length', () => {
    const handle = mountPanel();
    click(part(handle, 'icon-button--create'));
    expect(part<HTMLInputElement>(handle, 'inline-input').maxLength).toBe(50);
  });
});

describe('floating panel context menu', () => {
  it('stays open for clicks inside the panel and closes for a click outside it', () => {
    const handle = mountPanel();
    contextMenu(folderHeader(panelRoot(handle), 'folder-a'));

    click(part(handle, 'color-title'));
    expect(queryPart(handle, 'context-menu')).not.toBeNull();

    click(document.body);
    expect(queryPart(handle, 'context-menu')).toBeNull();
  });

  it('opens at the pointer and closes when its folder disappears', () => {
    const handle = mountPanel();
    contextMenu(folderHeader(panelRoot(handle), 'folder-a'));
    const menu = part(handle, 'context-menu');
    expect([menu.style.left, menu.style.top]).toEqual(['24px', '32px']);
    expect(menu.getAttribute('role')).toBe('menu');

    handle.update({ folders: [createFolder('folder-b', 'Beta', null, 1)], folderContents: {} });
    expect(queryPart(handle, 'context-menu')).toBeNull();
  });

  it('cancels a pending delete without deleting', () => {
    const onDeleteFolder = vi.fn();
    const handle = mountPanel({ onDeleteFolder });
    contextMenu(folderHeader(panelRoot(handle), 'folder-a'));
    click(part(handle, 'menu-item--danger'));
    const buttons = panelRoot(handle).querySelectorAll(`.${FLOATING_PANEL_CLASS}__confirm-button`);
    click(buttons[1]);

    expect(onDeleteFolder).not.toHaveBeenCalled();
    expect(queryPart(handle, 'context-menu')).toBeNull();
  });
});

describe('floating panel rows and drag', () => {
  it('shows the pin marker, a count of chats and subfolders, and an untitled label', () => {
    const data = createData();
    data.folders[0].pinned = true;
    data.folders.push(createFolder('child', 'Child', 'folder-a', 0));
    data.folderContents['folder-a'].push(createConversation('blank', ''));
    const handle = mountPanel({ data });
    const header = folderHeader(panelRoot(handle), 'folder-a');

    expect(header.querySelector(`.${FLOATING_PANEL_CLASS}__pin`)!.textContent).toBe('●');
    expect(header.querySelector(`.${FLOATING_PANEL_CLASS}__count`)!.textContent).toBe('3');
    expect(panelRoot(handle).textContent).toContain('floatingPanelUntitled');
  });

  it('flips the caret label when a folder collapses', () => {
    const handle = mountPanel();
    const caret = () =>
      folderHeader(panelRoot(handle), 'folder-a').querySelector(`.${FLOATING_PANEL_CLASS}__caret`)!;
    expect(caret().getAttribute('aria-label')).toBe('floatingPanelCollapseFolder');
    click(caret());
    expect(caret().getAttribute('aria-label')).toBe('floatingPanelExpandFolder');
  });

  it('starts a row drag with the folder-scoped payload and the title as text', () => {
    const handle = mountPanel();
    const transfer = createDataTransfer();
    const row = part(handle, 'conv');
    row.dispatchEvent(createDragEvent('dragstart', transfer));

    expect(JSON.parse(transfer.getData('application/json'))).toEqual({
      type: 'conversation',
      conversationId: 'conv-a',
      sourceFolderId: 'folder-a',
    });
    expect(transfer.getData('text/plain')).toBe('Conversation A');
    expect(row.classList.contains(`${FLOATING_PANEL_CLASS}__conv--dragging`)).toBe(true);
    row.dispatchEvent(createDragEvent('dragend', transfer));
    expect(row.classList.contains(`${FLOATING_PANEL_CLASS}__conv--dragging`)).toBe(false);
  });

  it('highlights only JSON drags and ignores a drop on the source folder', () => {
    const onMoveConversation = vi.fn();
    const handle = mountPanel({ onMoveConversation });
    const target = folderHeader(panelRoot(handle), 'folder-a');
    const highlight = `${FLOATING_PANEL_CLASS}__drop-target`;

    const plain = createDataTransfer();
    plain.setData('text/plain', 'x');
    const ignored = createDragEvent('dragover', plain);
    target.dispatchEvent(ignored);
    expect(ignored.defaultPrevented).toBe(false);
    expect(target.classList.contains(highlight)).toBe(false);

    const transfer = createDataTransfer();
    part(handle, 'conv').dispatchEvent(createDragEvent('dragstart', transfer));
    target.dispatchEvent(createDragEvent('dragover', transfer));
    expect(target.classList.contains(highlight)).toBe(true);
    target.dispatchEvent(createDragEvent('dragleave', transfer));
    expect(target.classList.contains(highlight)).toBe(false);

    target.dispatchEvent(createDragEvent('drop', transfer));
    expect(onMoveConversation).not.toHaveBeenCalled();
  });
});

describe('floating panel shell', () => {
  it('shows the empty state when there are no folders', () => {
    const handle = mountPanel({ data: { folders: [], folderContents: {} } });
    expect(part(handle, 'empty').textContent).toContain('floatingPanelEmpty');
  });

  it('replaces a panel that is already mounted', () => {
    const first = mountPanel();
    const second = mountFloatingPanel({ data: createData() });
    expect(first.element.isConnected).toBe(false);
    expect(document.querySelectorAll(`.${FLOATING_PANEL_CLASS}`)).toHaveLength(1);
    second.destroy();
  });

  it('closes from its close button', () => {
    const onClose = vi.fn();
    const handle = mountPanel({ onClose });
    click(part(handle, 'close'));
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(handle.element.isConnected).toBe(false);
  });

  it('blocks edits until the data is ready', () => {
    const handle = mountPanel({ dataReady: false });
    const body = part(handle, 'body');
    expect(body.inert).toBe(true);
    expect(body.getAttribute('aria-busy')).toBe('true');
    expect(part<HTMLButtonElement>(handle, 'icon-button--create').disabled).toBe(true);

    handle.setDataReady(true);
    expect(body.inert).toBe(false);
    expect(part<HTMLButtonElement>(handle, 'icon-button--create').disabled).toBe(false);
  });

  it('reports the dragged position and keeps the panel inside the viewport', () => {
    setWindowSize(1000, 800);
    const onPosChange = vi.fn();
    const handle = mountPanel({ onPosChange, storedPos: { x: 100, y: 100 } });
    const header = part(handle, 'header');
    stubPointerCapture(header);
    setElementRect(handle.element, 320, 420);

    header.dispatchEvent(pointerEvent('pointerdown', { button: 0, clientX: 110, clientY: 110 }));
    expect(header.classList.contains(`${FLOATING_PANEL_CLASS}__header--dragging`)).toBe(true);
    header.dispatchEvent(pointerEvent('pointermove', { clientX: 5000, clientY: -50 }));
    expect([handle.element.style.left, handle.element.style.top]).toEqual(['672px', '8px']);
    header.dispatchEvent(pointerEvent('pointerup', { button: 0 }));
    expect(onPosChange).toHaveBeenCalledTimes(1);
    expect(header.classList.contains(`${FLOATING_PANEL_CLASS}__header--dragging`)).toBe(false);
  });

  it('does not start a drag from a header button', () => {
    const handle = mountPanel();
    const header = part(handle, 'header');
    stubPointerCapture(header);
    part(handle, 'close').dispatchEvent(pointerEvent('pointerdown', { button: 0 }));
    expect(header.classList.contains(`${FLOATING_PANEL_CLASS}__header--dragging`)).toBe(false);
  });

  it('clamps the panel back into a smaller window', () => {
    setWindowSize(1000, 800);
    const handle = mountPanel({ storedPos: { x: 600, y: 300 }, storedSize: { w: 320, h: 420 } });
    Object.defineProperty(handle.element, 'offsetWidth', { configurable: true, value: 320 });
    Object.defineProperty(handle.element, 'offsetHeight', { configurable: true, value: 420 });
    Object.defineProperty(handle.element, 'offsetLeft', { configurable: true, value: 600 });
    Object.defineProperty(handle.element, 'offsetTop', { configurable: true, value: 300 });

    setWindowSize(700, 600);
    window.dispatchEvent(new Event('resize'));
    expect([handle.element.style.left, handle.element.style.top]).toEqual(['372px', '172px']);
  });
});
