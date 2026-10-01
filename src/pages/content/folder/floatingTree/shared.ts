import { MAX_FOLDER_DEPTH } from '@/features/folder/constants';
import { type ConversationSortMode, sortFolders } from '@/features/folder/model/folderData';
import { getTranslationSyncUnsafe } from '@/utils/i18n';

import { readDragPayload } from '../dragPayload';
import type { ConversationReference, Folder, FolderData } from '../types';

export const FLOATING_PANEL_CLASS = 'gv-floating-folder-panel';
export const MAX_FOLDER_NAME_LENGTH = 50;

/** `gv-floating-folder-panel__<part>` */
export function cls(part: string): string {
  return `${FLOATING_PANEL_CLASS}__${part}`;
}

export const MENU_SELECTOR = `.${cls('context-menu')}`;

export function t(key: string): string {
  return getTranslationSyncUnsafe(key);
}

export type InlineEditorState =
  | { mode: 'create'; parentId: string | null }
  | { mode: 'rename'; folderId: string };

export type ContextMenuState = {
  folderId: string;
  x: number;
  y: number;
  confirmingDelete: boolean;
  /** Opened from the keyboard: the menu takes focus and returns it on close. */
  fromKeyboard?: boolean;
};

/** Data callbacks the tree raises; the host decides how each one is stored. */
export type TreeActions = {
  onNavigate?: (conv: ConversationReference) => void;
  onCreateFolder?: (name: string, parentId: string | null) => void;
  onRenameFolder?: (folderId: string, newName: string) => void;
  onDeleteFolder?: (folderId: string) => void;
  /**
   * Asks before `onDeleteFolder` in a dialog of the host's own. Without it, the
   * menu turns into an inline Delete / Cancel confirm.
   */
  confirmFolderRemoval?: (anchor: HTMLElement, onConfirm: () => void) => void;
  onRemoveConversation?: (folderId: string, conversationId: string) => void;
  /** Asks before `onRemoveConversation`; without it, removal is immediate. */
  confirmConversationRemoval?: (title: string, anchor: HTMLElement, onConfirm: () => void) => void;
  onToggleStar?: (folderId: string, conversationId: string) => void;
  onToggleFolderPinned?: (folderId: string) => void;
  /** Persists a folder's expansion; without it, expansion stays local to the panel. */
  onToggleFolderExpanded?: (folderId: string) => void;
  onMoveConversation?: (conversationId: string, fromFolderId: string, toFolderId: string) => void;
  onSetFolderColor?: (folderId: string, color: string) => void;
  /** Files the open conversation into a folder; the folder menu offers it only when set. */
  onAddCurrentConversation?: (folderId: string) => void;
  /**
   * Takes every drop on a folder or root drop target in place of the tree's own
   * move, including drags the tree's payload check refuses, such as a native
   * row with no source folder. Returns whether it used the drop.
   */
  onDrop?: (e: DragEvent, folderId: string) => boolean;
  /** With `onDrop`: the drags to accept at dragover, from `dataTransfer.types`. */
  acceptsDrag?: (types: readonly string[]) => boolean;
};

/** Ways a site's tree differs from the floating panel's; each is off by default. */
export type TreeSiteOptions = {
  /** `created`: pinned first, then oldest first. Default: pinned, then sortIndex, then name. */
  folderOrder?: 'created';
  /** `stored`: a folder's conversations in stored order. Default: starred first, then the sort mode. */
  conversationOrder?: 'stored';
  /**
   * Root conversations go under this heading after the folders, and a root drop
   * target stays even with no folders. Default: root conversations first, unlabelled.
   */
  rootSection?: { labelKey: string };
  /** Marks the rows of the conversation the page has open. */
  activeConversationId?: string | null;
  /** A button on each folder row that opens its menu. Default: the menu opens on right-click only. */
  folderMenuButton?: { labelKey: string };
  /**
   * A folder's body (its subfolders and conversations) takes drops too, so the
   * whole folder block is a target; the innermost folder wins. Default: the header only.
   */
  folderBodyDrop?: boolean;
};

/** A transient view change; `null` clears the editor or menu, omitted keeps it. */
export type TreeChange = {
  inlineEditor?: InlineEditorState | null;
  contextMenu?: ContextMenuState | null;
  expand?: { folderId: string; expanded: boolean };
};

export type TreeProps = {
  data: FolderData;
  /** The `folderContents` bucket holding conversations filed at the root. */
  rootBucketId: string;
  conversationSortMode: ConversationSortMode;
  actions: TreeActions;
  inlineEditor: InlineEditorState | null;
  contextMenu: ContextMenuState | null;
  isExpanded: (folder: Folder) => boolean;
  /** Applies `change`, runs `effect`, then re-renders the tree. */
  apply: (change: TreeChange, effect?: () => void) => void;
  site?: TreeSiteOptions;
  /** The controller renders the folder menu in a body-level layer instead. */
  menuInLayer?: boolean;
};

export type ConversationDragData = {
  type: 'conversation';
  conversationId: string;
  sourceFolderId: string;
};

/** Pinned first, then oldest first. */
export function sortFoldersByCreation(folders: readonly Folder[]): Folder[] {
  return [...folders].sort(
    (a, b) => Number(!!b.pinned) - Number(!!a.pinned) || a.createdAt - b.createdAt,
  );
}

/** Where each folder renders: every stored id exactly once, under one parent. */
export type FolderLayout = {
  roots: Folder[];
  children: ReadonlyMap<string, Folder[]>;
};

/**
 * Lays out folders for display without rewriting them. A repeated id keeps its
 * first record. Folders a parent walk from the roots never reaches sit on a
 * parent cycle: the first of each such group in stored order stands in as a
 * root after the real ones, and the rest hang under it as stored.
 */
export function layoutFolders(
  data: FolderData,
  order?: TreeSiteOptions['folderOrder'],
): FolderLayout {
  const sort = (folders: Folder[]) =>
    order === 'created' ? sortFoldersByCreation(folders) : sortFolders(folders);
  const unique = new Map<string, Folder>();
  for (const folder of data.folders) if (!unique.has(folder.id)) unique.set(folder.id, folder);
  const ids = new Set(unique.keys());

  const byParent = new Map<string, Folder[]>();
  const realRoots: Folder[] = [];
  for (const folder of unique.values()) {
    if (isRootFolder(folder, ids)) {
      realRoots.push(folder);
      continue;
    }
    const siblings = byParent.get(folder.parentId as string) ?? [];
    siblings.push(folder);
    byParent.set(folder.parentId as string, siblings);
  }

  const children = new Map<string, Folder[]>();
  const placed = new Set<string>();
  const place = (top: Folder) => {
    placed.add(top.id);
    const pending = [top];
    while (pending.length > 0) {
      const parent = pending.pop()!;
      const kids = sort((byParent.get(parent.id) ?? []).filter((kid) => !placed.has(kid.id)));
      for (const kid of kids) placed.add(kid.id);
      children.set(parent.id, kids);
      pending.push(...kids);
    }
  };

  const roots = sort(realRoots);
  roots.forEach(place);
  for (const folder of unique.values()) {
    if (placed.has(folder.id)) continue;
    roots.push(folder);
    place(folder);
  }
  return { roots, children };
}

/**
 * Whether a folder shows at the root: its parent is unset (`null`, missing or
 * `''`, all of which stored and imported data hold) or names no folder. Read
 * only for display; stored data keeps its `parentId`.
 */
export function isRootFolder(folder: Folder, folderIds: ReadonlySet<string>): boolean {
  return !folder.parentId || !folderIds.has(folder.parentId);
}

/** Which drags a drop target accepts at dragover, when the payload cannot be read yet. */
export function acceptsDrag(actions: TreeActions, types: readonly string[]): boolean {
  if (actions.onDrop && actions.acceptsDrag) return actions.acceptsDrag(types);
  return types.includes('application/json');
}

export function canCreateChildAtDepth(depth: number): boolean {
  return depth < MAX_FOLDER_DEPTH;
}

export function readConversationDragData(e: DragEvent): ConversationDragData | null {
  const payload = readDragPayload(e.dataTransfer);
  if (payload?.type !== 'conversation' || !payload.conversationId || !payload.sourceFolderId) {
    return null;
  }
  return {
    type: 'conversation',
    conversationId: payload.conversationId,
    sourceFolderId: payload.sourceFolderId,
  };
}
