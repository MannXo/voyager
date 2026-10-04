import type { StarStore } from '@/features/savedLibrary/starStore';
import type { StarredMessage } from '@/features/savedLibrary/starTypes';

import { isTrustedSyncMessageSender } from './runtimeMessageRouting';

type StarredMessageRequest =
  | { type: 'gv.starred.add'; payload: StarredMessage }
  | {
      type: 'gv.starred.remove' | 'gv.starred.isStarred';
      payload: Pick<StarredMessage, 'conversationId' | 'turnId'>;
    }
  | { type: 'gv.starred.getAll' }
  | { type: 'gv.starred.getForConversation'; payload: Pick<StarredMessage, 'conversationId'> }
  | { type: 'gv.starred.mergeCloud'; payload: unknown }
  | {
      type: 'gv.starred.reconcileConversationIds';
      payload: {
        targetConversationId: string;
        sourceConversationIds?: unknown;
        conversationUrl?: unknown;
      };
    };

export function createStarredMessagesHandler(store: StarStore) {
  return (
    message: unknown,
    sender?: chrome.runtime.MessageSender,
  ): Promise<Record<string, unknown>> | null => {
    const request = message as StarredMessageRequest | null;
    switch (request?.type) {
      case 'gv.starred.add':
        return store.add(request.payload).then((added) => ({ ok: true, added }));
      case 'gv.starred.remove':
        return store
          .remove(request.payload.conversationId, request.payload.turnId)
          .then((removed) => ({ ok: true, removed }));
      case 'gv.starred.getAll':
        return store.getAll().then((data) => ({ ok: true, data }));
      case 'gv.starred.getForConversation':
        return store
          .getForConversation(request.payload.conversationId)
          .then((messages) => ({ ok: true, messages }));
      case 'gv.starred.isStarred':
        return store.getForConversation(request.payload.conversationId).then((messages) => ({
          ok: true,
          isStarred: messages.some((item) => item.turnId === request.payload.turnId),
        }));
      case 'gv.starred.reconcileConversationIds':
        return store
          .reconcile(
            request.payload.targetConversationId,
            Array.isArray(request.payload.sourceConversationIds)
              ? request.payload.sourceConversationIds.filter(
                  (id): id is string => typeof id === 'string',
                )
              : [],
            typeof request.payload.conversationUrl === 'string'
              ? request.payload.conversationUrl
              : undefined,
          )
          .then((messages) => ({ ok: true, messages }));
      case 'gv.starred.mergeCloud':
        if (
          !sender ||
          !(['gemini', 'aistudio', 'chatgpt'] as const).some((platform) =>
            isTrustedSyncMessageSender(sender, platform),
          )
        ) {
          return Promise.reject(new Error('Untrusted starred messages restore sender'));
        }
        return store.mergeCloud(request.payload).then((result) => ({ ok: true, ...result }));
      default:
        return null;
    }
  };
}
