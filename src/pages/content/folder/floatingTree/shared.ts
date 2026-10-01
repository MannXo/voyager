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
};

/** Data callbacks the tree raises; the host decides how each one is stored. */
export type TreeActions = {
  onNavigate?: (conv: ConversationReference) => void;
  onCreateFolder?: (name: string, parentId: string | null) => void;
  onRenameFolder?: (folderId: string, newName: string) => void;
  onDeleteFolder?: (folderId: string) => void;
  onRemoveConversation?: (folderId: string, conversationId: string) => void;
  /** Asks before `onRemoveConversation`; without it, removal is immediate. */
  confirmConversationRemoval?: (title: string, anchor: HTMLElement, onConfirm: () => void) => void;
  onToggleStar?: (folderId: string, conversationId: string) => void;
  onToggleFolderPinned?: (folderId: string) => void;
  /** Persists a folder's expansion; without it, expansion stays local to the panel. */
  onToggleFolderExpanded?: (folderId: string) => void;
  onMoveConversation?: (conversationId: string, fromFolderId: string, toFolderId: string) => void;
  onSetFolderColor?: (folderId: string, color: string) => void;
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
};

export type ConversationDragData = {
  type: 'conversation';
  conversationId: string;
  sourceFolderId: string;
};

export function getFolderChildren(data: FolderData, parentId: string | null): Folder[] {
  return sortFolders(data.folders.filter((folder) => folder.parentId === parentId));
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
