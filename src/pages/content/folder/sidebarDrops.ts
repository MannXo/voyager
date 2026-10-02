import { ROOT_CONVERSATIONS_ID } from '@/features/folder/constants';
import {
  type ConversationSortMode,
  sortConversationsByPriority,
  sortFolders,
} from '@/features/folder/model/folderData';
import { getTranslationSyncUnsafe as t } from '@/utils/i18n';

import type { FolderFeedback } from './FolderFeedback';
import type { FolderStore } from './FolderStore';
import { VOYAGER_DRAG_MIME, readDragPayload } from './dragPayload';
import type { DropPlacement } from './floatingTree/shared';
import type { DragData } from './types';

/** What a drop on Gemini's sidebar folders needs. */
export type SidebarDropContext = {
  store: FolderStore;
  feedback: Pick<FolderFeedback, 'showNotification'>;
  sortMode: () => ConversationSortMode;
  /** After any drop that read a payload: ends the multi-select a drag carried. */
  finish: () => void;
};

/** Gemini's sidebar drags all carry Voyager JSON: folder rows, folder chats and native chats. */
export function acceptsSidebarDrag(types: readonly string[]): boolean {
  return types.includes(VOYAGER_DRAG_MIME);
}

function conversationIdsOf(dragData: DragData): string[] {
  if (dragData.conversations?.length) {
    return dragData.conversations.map((conversation) => conversation.conversationId);
  }
  return dragData.conversationId ? [dragData.conversationId] : [];
}

/** The insert index of a drop beside `placement`'s folder among its unpinned siblings. */
function folderInsertIndex(
  store: FolderStore,
  placement: Extract<DropPlacement, { kind: 'folder' }>,
): { parentId: string; index: number } | null {
  const target = store.data.folders.find((folder) => folder.id === placement.folderId);
  if (!target) return null;
  // Pinned folders never move, so a dragged folder ranks among the unpinned.
  const siblings = sortFolders(
    store.data.folders.filter((folder) => folder.parentId === target.parentId && !folder.pinned),
  );
  const at = siblings.findIndex((folder) => folder.id === target.id);
  const index = at < 0 ? 0 : placement.position === 'before' ? at : at + 1;
  return { parentId: target.parentId ?? '__root__', index };
}

/** The insert index of a drop beside a chat, within its starred or unstarred group. */
function conversationInsertIndex(
  store: FolderStore,
  sortMode: ConversationSortMode,
  placement: Extract<DropPlacement, { kind: 'conversation' }>,
): number {
  const sorted = sortConversationsByPriority(
    store.data.folderContents[placement.bucketId] ?? [],
    sortMode,
  );
  const target = sorted.find((conv) => conv.conversationId === placement.conversationId);
  const group = sorted.filter((conv) => !!conv.starred === !!target?.starred);
  const at = group.findIndex((conv) => conv.conversationId === placement.conversationId);
  if (at < 0) return group.length;
  return placement.position === 'before' ? at : at + 1;
}

/**
 * Files a dropped payload: a folder nests or reorders, chats move, reorder or
 * join from Gemini's own list. In recent order a chat dropped back into its
 * own folder explains why it cannot be reordered instead.
 */
export function applySidebarDrop(
  context: SidebarDropContext,
  dragData: DragData,
  folderId: string,
  placement?: DropPlacement,
): void {
  const { store } = context;
  try {
    if (dragData.type === 'folder') {
      if (placement?.kind === 'folder' && dragData.folderId) {
        const at = folderInsertIndex(store, placement);
        if (at) store.reorderFolder(dragData.folderId, at.parentId, at.index);
      } else if (folderId === ROOT_CONVERSATIONS_ID) {
        store.moveFolderToRoot(dragData);
      } else {
        store.addFolderToFolder(folderId, dragData);
      }
      return;
    }
    const sortMode = context.sortMode();
    if (sortMode === 'recent' && dragData.sourceFolderId === folderId) {
      context.feedback.showNotification(t('folder_sort_recent_drag_hint'), 'info');
      return;
    }
    if (placement?.kind === 'conversation' && sortMode === 'manual') {
      const insertIndex = conversationInsertIndex(store, sortMode, placement);
      if (!dragData.sourceFolderId) store.ensureConversationsInFolder(folderId, dragData);
      store.reorderOrMoveConversations(
        conversationIdsOf(dragData),
        dragData.sourceFolderId ?? folderId,
        folderId,
        insertIndex,
      );
    } else if (dragData.conversations?.length) {
      store.addConversationsToFolder(folderId, dragData.conversations, dragData.sourceFolderId);
    } else {
      store.addConversationToFolder(folderId, dragData);
    }
  } catch (error) {
    console.error('[FolderManager] Drop error:', error);
  } finally {
    context.finish();
  }
}

/** A drop on the tree: reads and files the payload. Returns whether there was one. */
export function dropOnSidebar(
  context: SidebarDropContext,
  e: DragEvent,
  folderId: string,
  placement?: DropPlacement,
): boolean {
  const dragData = readDragPayload(e.dataTransfer);
  if (!dragData) return false;
  applySidebarDrop(context, dragData, folderId, placement);
  return true;
}

/**
 * Makes `element` file drops at the root: the section header, and the tree
 * host for drops between rows that no row takes. Returns its cleanup.
 */
export function bindRootDropZone(element: HTMLElement, context: SidebarDropContext): () => void {
  const active = 'gv-folder-list-dragover';
  const onDragOver = (e: DragEvent) => {
    if (!acceptsSidebarDrag(Array.from(e.dataTransfer?.types ?? []))) return;
    e.preventDefault();
    e.stopPropagation();
    if (e.dataTransfer) e.dataTransfer.dropEffect = 'move';
    element.classList.add(active);
  };
  const onDragLeave = (e: DragEvent) => {
    const into = e.relatedTarget;
    if (into instanceof Node && element.contains(into)) return;
    element.classList.remove(active);
  };
  const onDrop = (e: DragEvent) => {
    element.classList.remove(active);
    if (!acceptsSidebarDrag(Array.from(e.dataTransfer?.types ?? []))) return;
    e.preventDefault();
    e.stopPropagation();
    dropOnSidebar(context, e, ROOT_CONVERSATIONS_ID);
  };
  element.addEventListener('dragover', onDragOver);
  element.addEventListener('dragleave', onDragLeave);
  element.addEventListener('drop', onDrop);
  return () => {
    element.removeEventListener('dragover', onDragOver);
    element.removeEventListener('dragleave', onDragLeave);
    element.removeEventListener('drop', onDrop);
  };
}
