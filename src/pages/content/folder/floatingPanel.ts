import { CLOUD_SYNC_PATH, CLOUD_UPLOAD_PATH } from '@/core/icons/cloudSyncPaths';
import { isSafari } from '@/core/utils/browser';
import type { ConversationSortMode } from '@/features/folder/model/folderData';

import panelCss from './floatingPanel.css?raw';
import { renderFolderTree } from './floatingTree/FolderTree';
import {
  type ContextMenuState,
  FLOATING_PANEL_CLASS,
  type InlineEditorState,
  type TreeActions,
  type TreeChange,
  t,
} from './floatingTree/shared';
import { attachShadowSurface, eventPassedThrough } from './shadowHost';
import type { FolderData } from './types';

export { FLOATING_PANEL_CLASS };

export type FloatingPanelPos = { x: number; y: number };
export type FloatingPanelSize = { w: number; h: number };

export type MountArgs = TreeActions & {
  data: FolderData;
  dataReady?: boolean;
  conversationSortMode?: ConversationSortMode;
  storedPos?: FloatingPanelPos | null;
  storedSize?: FloatingPanelSize | null;
  onPosChange?: (pos: FloatingPanelPos) => void;
  onSizeChange?: (size: FloatingPanelSize) => void;
  onClose?: () => void;
  onCloudUpload?: () => void;
  onCloudSync?: () => void;
  getCloudUploadTooltip?: () => Promise<string>;
  getCloudSyncTooltip?: () => Promise<string>;
};

export type FloatingPanelMountArgs = MountArgs;

export type FloatingPanelHandle = {
  element: HTMLElement;
  setDataReady: (ready: boolean) => void;
  update: (data: FolderData, conversationSortMode?: ConversationSortMode) => void;
  /** Replaces account data and discards transient edits without changing panel geometry. */
  reset: (data: FolderData, conversationSortMode?: ConversationSortMode) => void;
  destroy: () => void;
};

const MIN_MARGIN = 8;
const DEFAULT_WIDTH = 320;
const DEFAULT_HEIGHT = 420;
const MIN_PANEL_WIDTH = 280;
const MIN_PANEL_HEIGHT = 320;
const MAX_PANEL_WIDTH = 640;
const VIEWPORT_SIZE_MARGIN = 32;
const SIZE_CHANGE_DEBOUNCE_MS = 300;

function clampPos(pos: FloatingPanelPos, width: number, height: number): FloatingPanelPos {
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  return {
    x: Math.max(MIN_MARGIN, Math.min(pos.x, Math.max(MIN_MARGIN, vw - width - MIN_MARGIN))),
    y: Math.max(MIN_MARGIN, Math.min(pos.y, Math.max(MIN_MARGIN, vh - height - MIN_MARGIN))),
  };
}

function clampSize(size: FloatingPanelSize): FloatingPanelSize {
  const maxWidth = Math.max(
    MIN_PANEL_WIDTH,
    Math.min(MAX_PANEL_WIDTH, window.innerWidth - VIEWPORT_SIZE_MARGIN),
  );
  const maxHeight = Math.max(MIN_PANEL_HEIGHT, window.innerHeight - VIEWPORT_SIZE_MARGIN);

  return {
    w: Math.max(MIN_PANEL_WIDTH, Math.min(size.w, maxWidth)),
    h: Math.max(MIN_PANEL_HEIGHT, Math.min(size.h, maxHeight)),
  };
}

function getPanelSize(panel: HTMLElement): FloatingPanelSize {
  const rect = panel.getBoundingClientRect();
  return clampSize({
    w: Math.round(rect.width || panel.offsetWidth || DEFAULT_WIDTH),
    h: Math.round(rect.height || panel.offsetHeight || DEFAULT_HEIGHT),
  });
}

function isSameSize(a: FloatingPanelSize, b: FloatingPanelSize): boolean {
  return a.w === b.w && a.h === b.h;
}

function defaultPos(size: FloatingPanelSize): FloatingPanelPos {
  return {
    x: Math.max(MIN_MARGIN, window.innerWidth - size.w - 24),
    y: Math.max(MIN_MARGIN, window.innerHeight - size.h - 24),
  };
}

function createIconButton(
  modifier: string,
  labelKey: string,
  text: string,
  onClick: (e: MouseEvent) => void,
): HTMLButtonElement {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = `${FLOATING_PANEL_CLASS}__icon-button ${FLOATING_PANEL_CLASS}__icon-button--${modifier}`;
  button.setAttribute('aria-label', t(labelKey));
  button.title = t(labelKey);
  button.textContent = text;
  button.addEventListener('click', onClick);
  return button;
}

function createSvgIconButton(
  modifier: string,
  labelKey: string,
  pathData: string,
  onClick: (e: MouseEvent) => void,
): HTMLButtonElement {
  const button = createIconButton(modifier, labelKey, '', onClick);
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('height', '20px');
  svg.setAttribute('viewBox', '0 -960 960 960');
  svg.setAttribute('width', '20px');
  svg.setAttribute('fill', 'currentColor');
  svg.setAttribute('aria-hidden', 'true');

  const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  path.setAttribute('d', pathData);
  svg.appendChild(path);
  button.appendChild(svg);
  return button;
}

function updateTooltipOnHover(
  button: HTMLButtonElement,
  getTooltip: (() => Promise<string>) | undefined,
): void {
  if (!getTooltip) return;

  button.addEventListener('mouseenter', () => {
    void getTooltip()
      .then((tooltip) => {
        button.title = tooltip;
      })
      .catch(() => {});
  });
}

function createEmptyFolderIcon(): SVGSVGElement {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.classList.add(`${FLOATING_PANEL_CLASS}__empty-icon`);
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('aria-hidden', 'true');

  const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  path.setAttribute(
    'd',
    'M4.75 6.5c0-.69.56-1.25 1.25-1.25h4.16c.36 0 .69.15.93.41l1.12 1.23c.14.15.34.24.55.24H18c.69 0 1.25.56 1.25 1.25v1.12H4.75v-3Zm0 4.25h14.5v6.75c0 .69-.56 1.25-1.25 1.25H6c-.69 0-1.25-.56-1.25-1.25v-6.75Z',
  );
  svg.appendChild(path);
  return svg;
}

function createHintRow(key: string, iconText: string): HTMLElement {
  const row = document.createElement('div');
  row.className = `${FLOATING_PANEL_CLASS}__move-hint`;

  const icon = document.createElement('span');
  icon.className = `${FLOATING_PANEL_CLASS}__move-hint-icon`;
  icon.textContent = iconText;
  icon.setAttribute('aria-hidden', 'true');

  const text = document.createElement('span');
  text.className = `${FLOATING_PANEL_CLASS}__move-hint-text`;
  text.textContent = t(key);

  row.appendChild(icon);
  row.appendChild(text);
  return row;
}

function createHintStack(): HTMLElement {
  const stack = document.createElement('div');
  stack.className = `${FLOATING_PANEL_CLASS}__hint-stack`;
  stack.appendChild(createHintRow('floatingPanelMoveHint', 'i'));
  stack.appendChild(createHintRow('floatingPanelGestureHint', '?'));
  return stack;
}

export function mountFloatingPanel({
  data,
  dataReady = true,
  conversationSortMode = 'manual',
  storedPos,
  storedSize,
  onPosChange,
  onSizeChange,
  onClose,
  onNavigate,
  onCreateFolder,
  onRenameFolder,
  onDeleteFolder,
  onRemoveConversation,
  onToggleStar,
  onToggleFolderPinned,
  onMoveConversation,
  onSetFolderColor,
  onCloudUpload,
  onCloudSync,
  getCloudUploadTooltip,
  getCloudSyncTooltip,
}: MountArgs): FloatingPanelHandle {
  const existing = document.querySelector(`.${FLOATING_PANEL_CLASS}`);
  if (existing) existing.remove();

  let currentData = data;
  let currentConversationSortMode = conversationSortMode;

  const panel = document.createElement('div');
  panel.className = FLOATING_PANEL_CLASS;
  panel.setAttribute('role', 'dialog');
  panel.setAttribute('aria-label', t('floatingPanelTitle'));

  const header = document.createElement('div');
  header.className = `${FLOATING_PANEL_CLASS}__header`;

  const title = document.createElement('div');
  title.className = `${FLOATING_PANEL_CLASS}__title`;
  title.textContent = t('floatingPanelTitle');

  const headerActions = document.createElement('div');
  headerActions.className = `${FLOATING_PANEL_CLASS}__header-actions`;

  if (!isSafari()) {
    const cloudUploadBtn = createSvgIconButton(
      'cloud-upload',
      'floatingPanelCloudUpload',
      CLOUD_UPLOAD_PATH,
      (e) => {
        e.stopPropagation();
        onCloudUpload?.();
      },
    );
    updateTooltipOnHover(cloudUploadBtn, getCloudUploadTooltip);

    const cloudSyncBtn = createSvgIconButton(
      'cloud-sync',
      'floatingPanelCloudSync',
      CLOUD_SYNC_PATH,
      (e) => {
        e.stopPropagation();
        onCloudSync?.();
      },
    );
    updateTooltipOnHover(cloudSyncBtn, getCloudSyncTooltip);

    headerActions.appendChild(cloudUploadBtn);
    headerActions.appendChild(cloudSyncBtn);
  }

  const createBtn = createIconButton('create', 'floatingPanelCreateFolder', '+', (e) => {
    e.stopPropagation();
    apply({ inlineEditor: { mode: 'create', parentId: null }, contextMenu: null });
  });

  const closeBtn = document.createElement('button');
  closeBtn.type = 'button';
  closeBtn.className = `${FLOATING_PANEL_CLASS}__close`;
  closeBtn.setAttribute('aria-label', t('floatingPanelClose'));
  closeBtn.textContent = '×';

  header.appendChild(title);
  headerActions.appendChild(createBtn);
  headerActions.appendChild(closeBtn);
  header.appendChild(headerActions);

  const body = document.createElement('div');
  body.className = `${FLOATING_PANEL_CLASS}__body`;

  const setDataReady = (ready: boolean): void => {
    body.inert = !ready;
    body.setAttribute('aria-busy', String(!ready));
    headerActions
      .querySelectorAll<HTMLButtonElement>(`.${FLOATING_PANEL_CLASS}__icon-button`)
      .forEach((button) => {
        button.disabled = !ready;
      });
  };
  setDataReady(dataReady);

  const surface = attachShadowSurface(panel, panelCss);
  surface.root.append(header, createHintStack(), body);

  const initialSize = clampSize(storedSize ?? { w: DEFAULT_WIDTH, h: DEFAULT_HEIGHT });
  const initialPos = clampPos(storedPos ?? defaultPos(initialSize), initialSize.w, initialSize.h);
  panel.style.left = `${initialPos.x}px`;
  panel.style.top = `${initialPos.y}px`;
  panel.style.width = `${initialSize.w}px`;
  panel.style.height = `${initialSize.h}px`;

  // Drag support — header is the grabbable handle. Panel dimensions are read
  // once at drag start and reused on every move: interleaving offsetWidth/
  // offsetHeight reads with style writes inside pointermove forces a layout
  // pass per event (the panel doesn't resize mid-drag anyway).
  let dragState: { offsetX: number; offsetY: number; width: number; height: number } | null = null;

  const onPointerDown = (e: PointerEvent) => {
    if (e.button !== 0) return; // primary button only — no right/middle drags
    const target = e.target as HTMLElement;
    if (target.closest(`.${FLOATING_PANEL_CLASS}__close`)) return;
    if (target.closest(`.${FLOATING_PANEL_CLASS}__icon-button`)) return;
    const rect = panel.getBoundingClientRect();
    dragState = {
      offsetX: e.clientX - rect.left,
      offsetY: e.clientY - rect.top,
      width: rect.width || panel.offsetWidth,
      height: rect.height || panel.offsetHeight,
    };
    header.setPointerCapture(e.pointerId);
    header.classList.add(`${FLOATING_PANEL_CLASS}__header--dragging`);
  };
  const onPointerMove = (e: PointerEvent) => {
    if (!dragState) return;
    const next = clampPos(
      { x: e.clientX - dragState.offsetX, y: e.clientY - dragState.offsetY },
      dragState.width,
      dragState.height,
    );
    panel.style.left = `${next.x}px`;
    panel.style.top = `${next.y}px`;
  };
  const onPointerUp = (e: PointerEvent) => {
    if (!dragState) return;
    dragState = null;
    try {
      header.releasePointerCapture(e.pointerId);
    } catch {}
    header.classList.remove(`${FLOATING_PANEL_CLASS}__header--dragging`);
    onPosChange?.({ x: panel.offsetLeft, y: panel.offsetTop });
  };

  header.addEventListener('pointerdown', onPointerDown);
  header.addEventListener('pointermove', onPointerMove);
  header.addEventListener('pointerup', onPointerUp);
  header.addEventListener('pointercancel', onPointerUp);

  let lastCommittedSize = initialSize;
  let sizeDebounceTimer: ReturnType<typeof setTimeout> | null = null;

  const commitObservedSize = (size: FloatingPanelSize) => {
    if (isSameSize(size, lastCommittedSize)) return;
    lastCommittedSize = size;
    onSizeChange?.(size);
  };

  const scheduleSizeCommit = (size: FloatingPanelSize) => {
    if (isSameSize(size, lastCommittedSize)) return;
    if (sizeDebounceTimer) clearTimeout(sizeDebounceTimer);
    sizeDebounceTimer = setTimeout(() => {
      sizeDebounceTimer = null;
      commitObservedSize(getPanelSize(panel));
    }, SIZE_CHANGE_DEBOUNCE_MS);
  };

  const resizeObserver =
    typeof ResizeObserver === 'function'
      ? new ResizeObserver(() => {
          const nextSize = getPanelSize(panel);
          const nextPos = clampPos(
            { x: panel.offsetLeft, y: panel.offsetTop },
            nextSize.w,
            nextSize.h,
          );
          panel.style.left = `${nextPos.x}px`;
          panel.style.top = `${nextPos.y}px`;
          scheduleSizeCommit(nextSize);
        })
      : null;
  resizeObserver?.observe(panel);

  let inlineEditor: InlineEditorState | null = null;
  let contextMenu: ContextMenuState | null = null;
  const expandedFolders = new Map<string, boolean>();
  const actions: TreeActions = {
    onNavigate,
    onCreateFolder,
    onRenameFolder,
    onDeleteFolder,
    onRemoveConversation,
    onToggleStar,
    onToggleFolderPinned,
    onMoveConversation,
    onSetFolderColor,
  };

  const render = () => {
    for (const folder of currentData.folders) {
      if (!expandedFolders.has(folder.id)) {
        expandedFolders.set(folder.id, folder.isExpanded);
      }
    }

    renderFolderTree(body, {
      data: currentData,
      conversationSortMode: currentConversationSortMode,
      actions,
      inlineEditor,
      contextMenu,
      isExpanded: (folder) => expandedFolders.get(folder.id) ?? folder.isExpanded,
      apply,
    });
  };

  function apply(change: TreeChange, effect?: () => void): void {
    if (change.inlineEditor !== undefined) inlineEditor = change.inlineEditor;
    if (change.contextMenu !== undefined) contextMenu = change.contextMenu;
    if (change.expand) expandedFolders.set(change.expand.folderId, change.expand.expanded);
    effect?.();
    render();
  }
  render();

  const onResize = () => {
    const clamped = clampPos(
      { x: panel.offsetLeft, y: panel.offsetTop },
      panel.offsetWidth,
      panel.offsetHeight,
    );
    panel.style.left = `${clamped.x}px`;
    panel.style.top = `${clamped.y}px`;
  };
  window.addEventListener('resize', onResize);

  closeBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    destroy();
    onClose?.();
  });

  const onDocumentClick = (e: MouseEvent) => {
    if (contextMenu && !eventPassedThrough(e, panel)) apply({ contextMenu: null });
  };
  document.addEventListener('click', onDocumentClick);

  const destroy = () => {
    window.removeEventListener('resize', onResize);
    document.removeEventListener('click', onDocumentClick);
    resizeObserver?.disconnect();
    if (sizeDebounceTimer) {
      clearTimeout(sizeDebounceTimer);
      sizeDebounceTimer = null;
    }
    // Unmount first so the inline form drops its document listener.
    renderFolderTree(body, null);
    surface.disconnect();
    panel.remove();
  };

  document.body.appendChild(panel);

  // Is the user currently typing into an inline create/rename input?
  // Focus inside the shadow root shows as the host on `document.activeElement`.
  const isInlineFormInputFocused = () =>
    !!surface.root.activeElement?.classList.contains(`${FLOATING_PANEL_CLASS}__inline-input`);

  return {
    element: panel,
    setDataReady,
    reset: (next, nextConversationSortMode) => {
      currentData = next;
      if (nextConversationSortMode) currentConversationSortMode = nextConversationSortMode;
      inlineEditor = null;
      contextMenu = null;
      expandedFolders.clear();
      render();
    },
    update: (next, nextConversationSortMode) => {
      currentData = next;
      if (nextConversationSortMode) currentConversationSortMode = nextConversationSortMode;
      const nextIds = new Set(next.folders.map((folder) => folder.id));
      for (const folderId of expandedFolders.keys()) {
        if (!nextIds.has(folderId)) expandedFolders.delete(folderId);
      }
      if (inlineEditor?.mode === 'rename') {
        const editingFolderId = inlineEditor.folderId;
        if (!next.folders.some((folder) => folder.id === editingFolderId)) {
          inlineEditor = null;
        }
      }
      if (contextMenu && !next.folders.some((folder) => folder.id === contextMenu?.folderId)) {
        contextMenu = null;
      }
      // A background update (storage sync, another tab) must not rebuild the
      // tree while the user is typing in an inline form — the rebuild would
      // recreate the form empty, losing their input. `currentData` is already
      // updated above, and every form close path (submit / cancel / outside
      // mousedown) calls render(), which then picks up the deferred data.
      // If the edited folder was deleted remotely, inlineEditor is nulled
      // above and we fall through to render immediately.
      if (inlineEditor && isInlineFormInputFocused()) return;
      render();
    },
    destroy,
  };
}
