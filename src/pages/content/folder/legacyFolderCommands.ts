/**
 * Gemini's legacy `FolderCommands` façade (DESIGN-v2 §8.5): each op calls the
 * `FolderStore` method that does that edit today, synchronously, so the store's
 * change hook and every re-render run in the same tick as before. Outcomes map
 * the store's result; `set*` ops toggle only when the stored value differs.
 */
import type { ConversationReference } from '@/core/types/folder';
import {
  type EditOutcome,
  type FolderCommands,
  NOOP,
  type OpOf,
  type OrdinaryOpBody,
  failed,
  legacyOutcome,
} from '@/features/folder/commands/folderCommands';
import { ownBucket } from '@/features/folder/model/folderData';
import { type ConversationSeed, rejected } from '@/features/folder/owner/folderOps';

import type { FolderStore } from './FolderStore';
import type { DragData } from './types';

type Kind = OrdinaryOpBody['kind'];
type Handlers = { [K in Kind]: (body: OpOf<K>) => EditOutcome | Promise<EditOutcome> };

const ROOT_PARENT = '__root__';
const asDragData = (seeds: ConversationSeed[]): DragData => ({
  type: 'conversation',
  title: seeds[0]?.title ?? '',
  conversations: seeds.map((seed) => ({ ...seed, addedAt: Date.now() })),
});

export function createLegacyFolderCommands(store: FolderStore): FolderCommands {
  const folderOf = (id: string) => store.data.folders.find((folder) => folder.id === id);
  const recordIn = (bucket: string, id: string): ConversationReference | undefined =>
    ownBucket(store.data.folderContents, bucket)?.find((c) => c.conversationId === id);
  /** Runs a void store edit and reports what the legacy store can say about it. */
  const edit = (apply: () => void): EditOutcome => {
    const editable = store.canEdit;
    apply();
    return legacyOutcome(editable);
  };
  const addFromNative = (target: string, s: ConversationSeed) =>
    store.addConversationToFolderFromNative(
      target,
      s.conversationId,
      s.title,
      s.url,
      s.isGem,
      s.gemId,
      s.lastTurnAt,
    );
  const toggleIf = (differs: boolean | undefined, toggle: () => void): EditOutcome => {
    if (differs === undefined)
      return store.canEdit ? rejected('folder_missing') : failed('read_only');
    return differs ? edit(toggle) : NOOP;
  };

  const handlers: Handlers = {
    createFolder: ({ name, parentId }) => {
      // The legacy store picks its own id; `folderId` is honoured from P4 on.
      if (store.createFolder(name, parentId)) return legacyOutcome(true);
      return store.canEdit ? rejected('depth_limit') : failed('read_only');
    },
    renameFolder: ({ folderId, name }) => edit(() => store.renameFolder(folderId, name)),
    removeFolder: ({ folderId }) => edit(() => store.removeFolder(folderId)),
    moveFolder: ({ folderId, parentId, index }) =>
      edit(() => {
        if (index !== undefined) store.reorderFolder(folderId, parentId ?? ROOT_PARENT, index);
        else if (parentId === null) store.moveFolderToRoot({ type: 'folder', folderId, title: '' });
        else store.addFolderToFolder(parentId, { type: 'folder', folderId, title: '' });
      }),
    setFolderColor: ({ folderId, color }) =>
      edit(() => store.changeFolderColor(folderId, color ?? 'default')),
    setFolderPinned: ({ folderId, pinned }) => {
      const folder = folderOf(folderId);
      return toggleIf(folder && !!folder.pinned !== pinned, () => store.togglePinFolder(folderId));
    },
    setFolderExpanded: ({ folderId, expanded }) => {
      const folder = folderOf(folderId);
      return toggleIf(folder && !!folder.isExpanded !== expanded, () =>
        store.toggleFolder(folderId),
      );
    },
    setFolderInstructions: async ({ folderId, instructions }) => {
      const editable = store.canEdit;
      const exists = !!folderOf(folderId);
      if (await store.setFolderInstructions(folderId, instructions ?? undefined)) {
        return { kind: 'saved' };
      }
      if (!editable) return failed('read_only');
      return exists ? failed('storage_error') : rejected('folder_missing');
    },
    addConversations: ({ target, seeds, via }) => {
      // An outside drop does not check its target today (FolderSelection); the others do.
      if (via === 'outside-drop') {
        const records = asDragData(seeds).conversations ?? [];
        return edit(() => store.addConversationsToFolder(target, records));
      }
      if (!folderOf(target))
        return store.canEdit ? rejected('target_missing') : failed('read_only');
      return edit(() => seeds.forEach((seed) => addFromNative(target, seed)));
    },
    moveConversations: ({ ids, from, target, via, index }) => {
      if (index !== undefined) {
        return edit(() => store.reorderOrMoveConversations(ids, from, target, index));
      }
      const records = ids.map((id) => recordIn(from, id));
      if (!records.every((record) => record !== undefined)) return rejected('source_missing');
      if (via === 'tree-drag') {
        return edit(() => store.addConversationsToFolder(target, records, from));
      }
      return edit(() => records.forEach((c) => store.moveConversationToFolder(from, target, c)));
    },
    reorderConversations: ({ ids, from, target, index, ensure }) =>
      edit(() => {
        if (ensure?.length) store.ensureConversationsInFolder(target, asDragData(ensure));
        store.reorderOrMoveConversations(ids, from ?? target, target, index);
      }),
    removeConversations: ({ folderId, ids }) =>
      edit(() =>
        ids.length === 1
          ? store.removeConversationFromFolder(folderId, ids[0])
          : store.removeConversationsFromFolder(folderId, new Set(ids)),
      ),
    removeConversationEverywhere: ({ conversationId }) =>
      edit(() => store.removeConversationFromAllFolders(conversationId)),
    setConversationStarred: ({ conversationId, starred, scope }) => {
      if (scope === 'everywhere') {
        return edit(() => store.setConversationStarAcrossFolders(conversationId, starred));
      }
      const record = recordIn(scope.folderId, conversationId);
      return toggleIf(record && !!record.starred !== starred, () =>
        store.toggleConversationStar(scope.folderId, conversationId),
      );
    },
    // The tree buffers several titles and flushes once; one op flushes its own.
    renameConversation: ({ folderId, conversationId, title }) => {
      const record = recordIn(folderId, conversationId);
      if (!record) return rejected('conversation_missing');
      return edit(() => {
        store.bufferTitleUpdate(record, title);
        store.flushTitleUpdates();
      });
    },
    syncNativeTitles: ({ entries }) =>
      edit(() => entries.forEach((e) => store.updateConversationTitle(e.conversationId, e.title))),
    restoreNativeTitle: async ({ conversationId, nativeTitle }) => {
      const editable = store.canEdit;
      await store.restoreNativeTitleSync(conversationId, nativeTitle);
      return legacyOutcome(editable);
    },
    setConversationGem: ({ hexId, gemId }) => edit(() => store.updateConversationGem(hexId, gemId)),
    markConversationOpened: ({ conversationId }) =>
      edit(() => store.markConversationAsRecentlyOpened(conversationId)),
    setConversationActivity: ({ entries }) =>
      edit(() =>
        entries.forEach((e) => store.markConversationLastTurnAt(e.conversationId, e.lastTurnAt)),
      ),
  };

  return {
    status: () => (store.canEdit ? 'ready' : 'read_only'),
    view: () => store.data,
    run: (body) => {
      const handler = handlers[body.kind] as (b: OrdinaryOpBody) => ReturnType<Handlers[Kind]>;
      return Promise.resolve(handler(body));
    },
    // Gemini's import and Drive merge still run through FolderTransferController (manager.ts).
    runBulk: () => Promise.resolve(failed('not_loaded')),
    flush: () => {
      store.flushPendingSaveData();
      return Promise.resolve();
    },
  };
}
