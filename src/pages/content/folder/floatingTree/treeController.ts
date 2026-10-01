import type { ConversationSortMode } from '@/features/folder/model/folderData';

import { eventPassedThrough } from '../shadowHost';
import type { Folder, FolderData } from '../types';
import { renderFolderTree } from './FolderTree';
import {
  type ContextMenuState,
  type InlineEditorState,
  type TreeActions,
  type TreeChange,
  type TreeSiteOptions,
  cls,
} from './shared';

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

    renderFolderTree(body, {
      data: currentData,
      rootBucketId,
      conversationSortMode: currentConversationSortMode,
      actions: treeActions,
      inlineEditor,
      contextMenu,
      isExpanded,
      apply,
      site: currentSite,
    });
  };

  function apply(change: TreeChange, effect?: () => void): void {
    if (change.inlineEditor !== undefined) inlineEditor = change.inlineEditor;
    if (change.contextMenu !== undefined) contextMenu = change.contextMenu;
    if (change.expand) setExpanded(change.expand.folderId, change.expand.expanded);
    effect?.();
    render();
  }
  render();

  const onDocumentClick = (e: MouseEvent) => {
    if (contextMenu && !eventPassedThrough(e, boundary)) apply({ contextMenu: null });
  };
  document.addEventListener('click', onDocumentClick);

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
      // Unmount first so the inline form drops its document listener.
      renderFolderTree(body, null);
    },
  };
}
