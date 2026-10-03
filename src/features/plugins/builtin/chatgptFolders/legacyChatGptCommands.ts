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
  type OrdinaryOpBody,
  failed,
  legacyOutcome,
} from '@/features/folder/commands/folderCommands';
import { cloneFolderData, ownBucket } from '@/features/folder/model/folderData';
import { applyFolderOp } from '@/features/folder/owner/applyFolderOp';
import { type ConversationSeed, rejected } from '@/features/folder/owner/folderOps';
import { FOLDER_SITE_POLICIES } from '@/features/folder/owner/folderOwnerPolicy';

import type { AddOutcome, ChatGptFolderStore, MoveOutcome } from './ChatGptFolderStore';
import { bareConversationId } from './chatgptIdentity';
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
const MOVE_OUTCOMES: Record<MoveOutcome, EditOutcome> = {
  moved: { kind: 'unconfirmed' },
  unchanged: NOOP,
  missing: rejected('target_missing'),
  closed: failed('read_only'),
};
/** Several adds report the strongest result: one added wins, then present, then a refusal. */
const ADD_RANK: AddOutcome[] = ['added', 'present', 'missing', 'closed'];

const unsupported = () => rejected('unsupported');
const recordOf = (seed: ConversationSeed): ConversationReference => ({
  ...seed,
  addedAt: Date.now(),
});

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

  /** Runs a shared owner op on the current data and commits what it computed. */
  const applyOp = (body: OrdinaryOpBody): EditOutcome => {
    if (!store.ready) return failed('read_only');
    const policy = FOLDER_SITE_POLICIES.chatgpt;
    const { data, outcome } = applyFolderOp(store.data, body, policy, Date.now());
    if (outcome.kind !== 'saved') return outcome;
    store.apply(data);
    return legacyOutcome(true);
  };

  const moveConversations = (ids: string[], from: string, target: string): EditOutcome => {
    if (!ids.every((id) => recordIn(from, id))) return rejected('source_missing');
    if (!hasBucket(target)) return rejected('target_missing');
    return edit(() => ids.forEach((id) => store.moveConversation(id, from, target)));
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
    addConversations: ({ target, seeds, via }) => {
      const placement = FOLDER_SITE_POLICIES.chatgpt.addPlacement(via);
      const results = seeds.map((seed) => store.addConversation(target, recordOf(seed), placement));
      const best = ADD_RANK.find((rank) => results.includes(rank)) ?? 'closed';
      return ADD_OUTCOMES[best];
    },
    moveConversations: ({ ids, from, target }) => moveConversations(ids, from, target),
    moveFolder: ({ folderId, parentId, index }) =>
      MOVE_OUTCOMES[store.moveFolder(folderId, parentId, index)],
    // Only the tree's own rows drag here, so a drop always names the folder it left.
    dropConversations: ({ target, payload, index }) => {
      const from = payload.sourceFolderId;
      const ids = payload.conversations?.length
        ? payload.conversations.map((record) => record.conversationId)
        : payload.conversationId
          ? [payload.conversationId]
          : [];
      if (!from || ids.length === 0) return rejected('source_missing');
      if (index !== undefined) {
        if (!ids.every((id) => recordIn(from, id))) return rejected('source_missing');
        return MOVE_OUTCOMES[store.reorderConversations(ids, from, target, index)];
      }
      return from === target ? NOOP : moveConversations(ids, from, target);
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
      const titles = new Map(entries.map((e) => [bareConversationId(e.conversationId), e.title]));
      const editable = store.ready;
      if (store.applyNativeTitles(titles)) return legacyOutcome(true);
      return editable ? NOOP : failed('read_only');
    },
    placeAIStudioPrompt: () => rejected('unsupported'),
    saveCurrentData: () => rejected('unsupported'),
    ensureDefaultAIStudioFolder: () => rejected('unsupported'),
    bufferNativeTitle: unsupported,
    flushNativeTitles: unsupported,
    syncNativeSidebarTitles: unsupported,
    setFolderInstructions: unsupported,
    reorderConversations: unsupported,
    removeConversationEverywhere: unsupported,
    renameConversation: unsupported,
    restoreNativeTitle: (body) => applyOp(body),
    setConversationGem: unsupported,
    markConversationOpened: (body) => applyOp(body),
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
