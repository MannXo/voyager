/**
 * ChatGPT's legacy `FolderCommands` façade (DESIGN-v2 §8.5) over
 * `ChatGptFolderStore`: each op calls today's store method synchronously and
 * maps its result. Edits ChatGPT folders have no UI for are refused.
 */
import type { ConversationReference } from '@/core/types/folder';
import {
  type EditOutcome,
  type FolderCommands,
  NOOP,
  type OpOf,
  type FolderEditBody,
  failed,
  legacyOutcome,
} from '@/features/folder/commands/folderCommands';
import { cloneFolderData, ownBucket } from '@/features/folder/model/folderData';
import { type ConversationSeed, rejected } from '@/features/folder/owner/folderOps';

import type { AddOutcome, ChatGptFolderStore } from './ChatGptFolderStore';
import { CHATGPT_CONVERSATION_ID_PREFIX } from './chatgptIdentity';
import { CHATGPT_FOLDER_CONFIG } from './config';
import { importChatGptFolders } from './transfer';

type Kind = FolderEditBody['kind'];
type Handler<K extends Kind> = (body: OpOf<K>) => EditOutcome | Promise<EditOutcome>;

const ADD_OUTCOMES: Record<AddOutcome, EditOutcome> = {
  added: { kind: 'unconfirmed' },
  present: { kind: 'unchanged', reason: 'present' },
  missing: rejected('target_missing'),
  closed: failed('not_loaded'),
};
/** Several adds report the strongest result: one added wins, then present, then a refusal. */
const ADD_RANK: AddOutcome[] = ['added', 'present', 'missing', 'closed'];

const unsupported = () => rejected('unsupported');
const recordOf = (seed: ConversationSeed): ConversationReference => ({
  ...seed,
  addedAt: Date.now(),
});
const bareId = (id: string) =>
  id.startsWith(CHATGPT_CONVERSATION_ID_PREFIX)
    ? id.slice(CHATGPT_CONVERSATION_ID_PREFIX.length)
    : id;

export function createLegacyChatGptCommands(store: ChatGptFolderStore): FolderCommands {
  const folderOf = (id: string) => store.data.folders.find((folder) => folder.id === id);
  const recordIn = (bucket: string, id: string) =>
    ownBucket(store.data.folderContents, bucket)?.find((c) => c.conversationId === id);
  const hasBucket = (id: string) => id === CHATGPT_FOLDER_CONFIG.rootBucketId || !!folderOf(id);
  const edit = (apply: () => void): EditOutcome => {
    const editable = store.ready;
    apply();
    return legacyOutcome(editable);
  };
  const toggleIf = (differs: boolean | undefined, toggle: () => void): EditOutcome => {
    if (differs === undefined)
      return store.ready ? rejected('folder_missing') : failed('read_only');
    return differs ? edit(toggle) : NOOP;
  };

  const handlers: { [K in Kind]: Handler<K> } = {
    createFolder: ({ name, parentId }) => edit(() => store.createFolder(name, parentId)),
    renameFolder: ({ folderId, name }) => edit(() => store.renameFolder(folderId, name)),
    removeFolder: ({ folderId }) => edit(() => store.removeFolder(folderId)),
    setFolderColor: ({ folderId, color }) =>
      edit(() => store.setFolderColor(folderId, color ?? 'default')),
    setFolderPinned: ({ folderId, pinned }) => {
      const folder = folderOf(folderId);
      return toggleIf(folder && !!folder.pinned !== pinned, () =>
        store.toggleFolderPinned(folderId),
      );
    },
    setFolderExpanded: ({ folderId, expanded }) => {
      const folder = folderOf(folderId);
      return toggleIf(folder && !!folder.isExpanded !== expanded, () =>
        store.toggleFolderExpanded(folderId),
      );
    },
    addConversations: ({ target, seeds }) => {
      const results = seeds.map((seed) => store.addConversation(target, recordOf(seed)));
      const best = ADD_RANK.find((rank) => results.includes(rank)) ?? 'closed';
      return ADD_OUTCOMES[best];
    },
    moveConversations: ({ ids, from, target }) => {
      if (!ids.every((id) => recordIn(from, id))) return rejected('source_missing');
      if (!hasBucket(target)) return rejected('target_missing');
      return edit(() => ids.forEach((id) => store.moveConversation(id, from, target)));
    },
    removeConversations: ({ folderId, ids }) =>
      edit(() => ids.forEach((id) => store.removeConversation(folderId, id))),
    setConversationStarred: ({ conversationId, starred, scope }) => {
      if (scope === 'everywhere') return unsupported();
      const record = recordIn(scope.folderId, conversationId);
      return toggleIf(record && !!record.starred !== starred, () =>
        store.toggleStar(scope.folderId, conversationId),
      );
    },
    syncNativeTitles: ({ entries }) => {
      const titles = new Map(entries.map((e) => [bareId(e.conversationId), e.title]));
      const editable = store.ready;
      if (store.applyNativeTitles(titles)) return legacyOutcome(true);
      return editable ? NOOP : failed('read_only');
    },
    placeAIStudioPrompt: () => rejected('unsupported'),
    saveCurrentData: () => rejected('unsupported'),
    ensureDefaultAIStudioFolder: () => rejected('unsupported'),
    dropConversations: unsupported,
    bufferNativeTitle: unsupported,
    flushNativeTitles: unsupported,
    syncNativeSidebarTitles: unsupported,
    moveFolder: unsupported,
    setFolderInstructions: unsupported,
    reorderConversations: unsupported,
    removeConversationEverywhere: unsupported,
    renameConversation: unsupported,
    restoreNativeTitle: unsupported,
    setConversationGem: unsupported,
    markConversationOpened: unsupported,
    setConversationActivity: unsupported,
  };

  async function importFile(payload: unknown): Promise<EditOutcome> {
    if (!store.ready) return failed('not_loaded');
    const outcome = await importChatGptFolders(payload, cloneFolderData(store.data));
    if (!outcome.ok) {
      if (outcome.reason === 'failed') return failed('storage_error', outcome.message ?? '');
      const messageKey =
        outcome.reason === 'wrong-site'
          ? 'folder_import_wrong_site'
          : 'folder_import_invalid_format';
      return { kind: 'rejected', reason: 'invalid_payload', messageKey };
    }
    if (!(await store.replaceData(outcome.data))) return failed('storage_error');
    return { kind: 'saved', stats: outcome.stats };
  }

  return {
    status: () => (store.ready ? 'ready' : 'read_only'),
    view: () => store.data,
    run: (body) => {
      const handler = handlers[body.kind] as Handler<Kind>;
      return Promise.resolve(handler(body as never));
    },
    // Merge only, as the panel's import does today; ChatGPT has no backups or Drive merge.
    runBulk: (body) =>
      body.kind === 'importFile' && body.strategy === 'merge'
        ? importFile(body.payload)
        : Promise.resolve(unsupported()),
    flush: () => Promise.resolve(),
  };
}
