import type { ConversationReference, FolderData } from './types';

type ConversationTimestamp = 'lastTurnAt' | 'lastOpenedAt' | 'updatedAt';
const CONVERSATION_TIMESTAMPS: readonly ConversationTimestamp[] = [
  'lastTurnAt',
  'lastOpenedAt',
  'updatedAt',
];

/**
 * Carry edits still waiting on the save debounce onto freshly loaded data, so a
 * reload neither reverts them nor discards what another context wrote.
 *
 * Debounced edits (`FolderRepository.scheduleSaveData` callers) may only touch
 * the fields merged here: a folder's expanded state and a conversation's
 * monotonic timestamps. `base` is what this context last read or wrote, which
 * tells a local expand/collapse apart from one made elsewhere.
 */
export function mergeDebouncedEdits(fresh: FolderData, local: FolderData, base: FolderData): void {
  const baseExpanded = new Map(base.folders.map((folder) => [folder.id, folder.isExpanded]));
  const localFolders = new Map(local.folders.map((folder) => [folder.id, folder]));
  for (const folder of fresh.folders) {
    const edited = localFolders.get(folder.id);
    const before = baseExpanded.get(folder.id);
    if (!edited || before === undefined || edited.isExpanded === before) continue;
    folder.isExpanded = edited.isExpanded;
    folder.updatedAt = Math.max(folder.updatedAt, edited.updatedAt);
  }

  for (const [folderId, conversations] of Object.entries(fresh.folderContents)) {
    const edited = new Map(
      (local.folderContents[folderId] ?? []).map((conversation) => [
        conversation.conversationId,
        conversation,
      ]),
    );
    for (const conversation of conversations) {
      const mine = edited.get(conversation.conversationId);
      if (mine) keepLaterTimestamps(conversation, mine);
    }
  }
}

function keepLaterTimestamps(target: ConversationReference, edited: ConversationReference): void {
  for (const field of CONVERSATION_TIMESTAMPS) {
    const value = edited[field];
    if (value !== undefined && value > (target[field] ?? 0)) target[field] = value;
  }
}
