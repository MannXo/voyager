import type { FolderStore } from './FolderStore';
import type { TreeActions } from './floatingTree/shared';
import type { FolderDialogs } from './folderDialogs';

/**
 * The floating tree's data callbacks, backed by the same store paths and
 * dialogs as the sidebar tree. Each store call persists through saveData,
 * whose change hook pushes the fresh snapshot back into the panel, so none of
 * these update the panel themselves.
 */
export function createFloatingTreeStoreActions(
  store: FolderStore,
  dialogs: Pick<FolderDialogs, 'confirmConversationRemoval'>,
): Omit<TreeActions, 'onNavigate'> {
  return {
    onCreateFolder: (name, parentId) => {
      store.createFolder(name, parentId);
    },
    onRenameFolder: (folderId, name) => store.renameFolder(folderId, name),
    onDeleteFolder: (folderId) => store.removeFolder(folderId),
    onRemoveConversation: (folderId, conversationId) => {
      store.removeConversationFromFolder(folderId, conversationId);
    },
    confirmConversationRemoval: (title, anchor, onConfirm) =>
      dialogs.confirmConversationRemoval(title, anchor, onConfirm),
    onToggleStar: (folderId, conversationId) => {
      store.toggleConversationStar(folderId, conversationId);
    },
    onToggleFolderPinned: (folderId) => {
      store.togglePinFolder(folderId);
    },
    onToggleFolderExpanded: (folderId) => store.toggleFolder(folderId),
    // Intra-panel conversation move: user dragged a conversation row from
    // folder A to folder B inside the floating panel. Cross-document drag
    // (native Gemini row → panel) is intentionally NOT wired — that path
    // proved unreliable; the user files new conversations via the native
    // ⋮ → "Move to folder" menu instead.
    onMoveConversation: (conversationId, fromFolderId, toFolderId) => {
      const conv = store.data.folderContents[fromFolderId]?.find(
        (c) => c.conversationId === conversationId,
      );
      if (!conv) return;
      store.moveConversationToFolder(fromFolderId, toFolderId, conv);
    },
    onSetFolderColor: (folderId, color) => {
      store.changeFolderColor(folderId, color);
    },
  };
}
