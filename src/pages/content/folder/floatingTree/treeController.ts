import type { ConversationSortMode } from '@/features/folder/model/folderData';

import { eventPassedThrough } from '../shadowHost';
import type { Folder, FolderData } from '../types';
import { renderContextMenu } from './ContextMenu';
import { renderFolderTree } from './FolderTree';
import { mountPopoverLayer } from './popoverLayer';
import {
  type ContextMenuState,
  type InlineEditorState,
  type TreeActions,
  type TreeChange,
  type TreeProps,
  type TreeSiteOptions,
  MENU_SELECTOR,
  cls,
} from './shared';

const VIEWPORT_MARGIN = 8;

/** How far a box from `start` of `size` moves to sit inside `viewport`, margin kept. */
function shiftIntoView(start: number, size: number, viewport: number): number {
  const overflow = start + size - (viewport - VIEWPORT_MARGIN);
  return Math.max(overflow > 0 ? -overflow : 0, VIEWPORT_MARGIN - start);
}

export type FolderTreeOptions = {
  /** The element the tree renders into. */
  body: HTMLElement;
  /** The surface the tree lives in: clicks outside it close the folder menu. */
  boundary: HTMLElement;
  /** The shadow root holding `body`, read for the focused inline input. */
  focusRoot: ShadowRoot;
  data: FolderData;
  rootBucketId: string;
  conversationSortMode: ConversationSortMode;
  actions: TreeActions;
  site?: TreeSiteOptions;
  /**
   * Renders the folder menu in its own surface on `document.body`, styled by
   * `css`, for a tree inside a container that transforms or clips. Removed
   * with the tree.
   */
  popoverLayer?: { css: string };
};

export type FolderTreeController = {
  /** Applies a view change, runs `effect`, then re-renders. */
  apply: (change: TreeChange, effect?: () => void) => void;
  /** New data; waits for an open inline edit the user is typing in. */
  update: (data: FolderData, conversationSortMode?: ConversationSortMode) => void;
  /** Replaces account data and discards transient edits. */
  reset: (data: FolderData, conversationSortMode?: ConversationSortMode) => void;
  /** Changes site options, such as the open conversation, and re-renders. */
  setSite: (site: TreeSiteOptions) => void;
  /** Unmounts the tree and removes its document listener; the caller removes `body`. */
  destroy: () => void;
};

/**
 * The view state a folder tree keeps between renders: the open inline editor,
 * the folder menu, and expansion when the host does not persist it.
 */
export function mountFolderTree({
  body,
  boundary,
  focusRoot,
  data,
  rootBucketId,
  conversationSortMode,
  actions,
  site,
  popoverLayer,
}: FolderTreeOptions): FolderTreeController {
  let currentSite = site;
  let currentData = data;
  let currentConversationSortMode = conversationSortMode;
  let inlineEditor: InlineEditorState | null = null;
  let contextMenu: ContextMenuState | null = null;
  const expandedFolders = new Map<string, boolean>();
  const { onToggleFolderExpanded, onRenameFolder } = actions;
  // The rename form keeps the folder it opened on, and renders wait while it
  // has focus; compare with live data, as not every owner ignores a no-op.
  const treeActions: TreeActions = onRenameFolder
    ? {
        ...actions,
        onRenameFolder: (folderId, name) => {
          const live = currentData.folders.find((folder) => folder.id === folderId);
          if (live?.name !== name) onRenameFolder(folderId, name);
        },
      }
    : actions;
  const layer = popoverLayer ? mountPopoverLayer(popoverLayer.css) : null;

  // With a store callback, expansion is the folder's persisted `isExpanded`,
  // shared with the sidebar; without one it stays local to this tree.
  const isExpanded = (folder: Folder): boolean =>
    onToggleFolderExpanded
      ? folder.isExpanded
      : (expandedFolders.get(folder.id) ?? folder.isExpanded);
  const setExpanded = (folderId: string, expanded: boolean): void => {
    if (!onToggleFolderExpanded) {
      expandedFolders.set(folderId, expanded);
      return;
    }
    const folder = currentData.folders.find((candidate) => candidate.id === folderId);
    if (folder && folder.isExpanded !== expanded) onToggleFolderExpanded(folderId);
  };

  const render = () => {
    for (const folder of currentData.folders) {
      if (!expandedFolders.has(folder.id)) {
        expandedFolders.set(folder.id, folder.isExpanded);
      }
    }

    const tree: TreeProps = {
      data: currentData,
      rootBucketId,
      conversationSortMode: currentConversationSortMode,
      actions: treeActions,
      inlineEditor,
      contextMenu,
      isExpanded,
      apply,
      site: currentSite,
    };
    renderFolderTree(body, layer ? { ...tree, menuInLayer: true } : tree);
    if (layer) renderContextMenu(layer.container, tree);
  };

  // A menu opened from the keyboard takes focus, and gives it back to its
  // button when it closes and nothing else took it.
  const focusMenuButton = (folderId: string) =>
    Array.from(body.querySelectorAll<HTMLElement>(`.${cls('folder-header')}`))
      .find((header) => header.dataset.folderId === folderId)
      ?.querySelector<HTMLElement>(`.${cls('icon-button--menu')}`)
      ?.focus();
  const focusIsLost = () => !document.activeElement || document.activeElement === document.body;

  // A menu opened near the viewport's edge moves inside it. The shift is a
  // delta, so it holds in a container that offsets fixed boxes. A box without
  // layout (0×0) stays.
  const fitMenuIntoView = () => {
    const menu = (layer?.container ?? body).querySelector<HTMLElement>(MENU_SELECTOR);
    if (!contextMenu || !menu) return;
    const rect = menu.getBoundingClientRect();
    if (!rect.width || !rect.height) return;
    const dx = shiftIntoView(rect.left, rect.width, window.innerWidth);
    const dy = shiftIntoView(rect.top, rect.height, window.innerHeight);
    if (!dx && !dy) return;
    contextMenu = { ...contextMenu, x: contextMenu.x + dx, y: contextMenu.y + dy };
    render();
  };

  function apply(change: TreeChange, effect?: () => void): void {
    const closing = contextMenu && change.contextMenu === null ? contextMenu : null;
    if (change.inlineEditor !== undefined) inlineEditor = change.inlineEditor;
    if (change.contextMenu !== undefined) contextMenu = change.contextMenu;
    if (change.expand) setExpanded(change.expand.folderId, change.expand.expanded);
    effect?.();
    render();
    if (change.contextMenu) fitMenuIntoView();
    if (change.contextMenu?.fromKeyboard) {
      (layer?.container ?? body).querySelector<HTMLElement>(`.${cls('menu-item')}`)?.focus();
    } else if (closing?.fromKeyboard && focusIsLost()) {
      focusMenuButton(closing.folderId);
    }
  }
  render();

  const onDocumentClick = (e: MouseEvent) => {
    if (!contextMenu || eventPassedThrough(e, boundary)) return;
    if (layer && eventPassedThrough(e, layer.host)) return;
    apply({ contextMenu: null });
  };
  const onDocumentKeyDown = (e: KeyboardEvent) => {
    if (contextMenu && e.key === 'Escape') apply({ contextMenu: null });
  };
  document.addEventListener('click', onDocumentClick);
  document.addEventListener('keydown', onDocumentKeyDown);

  // Is the user currently typing into an inline create/rename input?
  // Focus inside the shadow root shows as the host on `document.activeElement`.
  const isInlineFormInputFocused = () =>
    !!focusRoot.activeElement?.classList.contains(cls('inline-input'));

  return {
    apply,
    setSite: (next) => {
      currentSite = next;
      render();
    },
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
    destroy: () => {
      document.removeEventListener('click', onDocumentClick);
      document.removeEventListener('keydown', onDocumentKeyDown);
      // Unmount first so the inline form drops its document listener.
      renderFolderTree(body, null);
      if (layer) {
        renderContextMenu(layer.container, null);
        layer.destroy();
      }
    },
  };
}
