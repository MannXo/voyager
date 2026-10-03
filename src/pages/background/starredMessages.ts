import { StorageKeys } from '@/core/types/common';
import type { StarredMessage, StarredMessagesData } from '@/pages/content/timeline/starredTypes';

interface StorageArea {
  get(keys: string[]): Promise<Record<string, unknown>>;
  set(items: Record<string, unknown>): Promise<void>;
}

function isStarredMessagesData(value: unknown): value is StarredMessagesData {
  if (typeof value !== 'object' || value === null) return false;
  const data = value as { messages?: unknown };
  if (typeof data.messages !== 'object' || data.messages === null) return false;
  const messages = data.messages as Record<string, unknown>;
  return Object.values(messages).every((v) => Array.isArray(v));
}

class StarredMessagesManager {
  private operationQueue: Promise<unknown> = Promise.resolve();

  constructor(private readonly area: StorageArea) {}

  /**
   * Serialize all operations to prevent race conditions
   */
  private serialize<T>(operation: () => Promise<T>): Promise<T> {
    const promise = this.operationQueue.then(operation, operation);
    this.operationQueue = promise.catch(() => {}); // Prevent error propagation
    return promise;
  }

  private async getFromStorage(): Promise<StarredMessagesData> {
    // Let the runtime boundary report failed reads instead of claiming all stars were removed.
    const result = await this.area.get([StorageKeys.TIMELINE_STARRED_MESSAGES]);
    const starred = result[StorageKeys.TIMELINE_STARRED_MESSAGES];
    return isStarredMessagesData(starred) ? starred : { messages: {} };
  }

  private async saveToStorage(data: StarredMessagesData): Promise<void> {
    await this.area.set({ [StorageKeys.TIMELINE_STARRED_MESSAGES]: data });
  }

  async addStarredMessage(message: StarredMessage): Promise<boolean> {
    return this.serialize(async () => {
      const data = await this.getFromStorage();

      if (!data.messages[message.conversationId]) {
        data.messages[message.conversationId] = [];
      }

      // Check if message already exists
      const exists = data.messages[message.conversationId].some((m) => m.turnId === message.turnId);

      if (!exists) {
        // Truncate content to save storage space
        // Popup is ~360px wide with line-clamp-2, showing ~50-60 chars max
        const MAX_CONTENT_LENGTH = 60;
        const truncatedMessage: StarredMessage = {
          ...message,
          content:
            message.content.length > MAX_CONTENT_LENGTH
              ? message.content.slice(0, MAX_CONTENT_LENGTH) + '...'
              : message.content,
        };
        data.messages[message.conversationId].push(truncatedMessage);
        await this.saveToStorage(data);
        return true;
      }
      return false;
    });
  }

  async removeStarredMessage(conversationId: string, turnId: string): Promise<boolean> {
    return this.serialize(async () => {
      const data = await this.getFromStorage();

      if (data.messages[conversationId]) {
        const initialLength = data.messages[conversationId].length;
        data.messages[conversationId] = data.messages[conversationId].filter(
          (m) => m.turnId !== turnId,
        );

        if (data.messages[conversationId].length < initialLength) {
          // Remove conversation key if no messages left
          if (data.messages[conversationId].length === 0) {
            delete data.messages[conversationId];
          }

          await this.saveToStorage(data);
          return true;
        }
      }
      return false;
    });
  }

  async getAllStarredMessages(): Promise<StarredMessagesData> {
    return this.getFromStorage();
  }

  async getStarredMessagesForConversation(conversationId: string): Promise<StarredMessage[]> {
    const data = await this.getFromStorage();
    return data.messages[conversationId] || [];
  }

  async isMessageStarred(conversationId: string, turnId: string): Promise<boolean> {
    const messages = await this.getStarredMessagesForConversation(conversationId);
    return messages.some((m) => m.turnId === turnId);
  }

  async reconcileConversationIds(
    targetConversationId: string,
    sourceConversationIds: string[],
    conversationUrl?: string,
  ): Promise<StarredMessage[]> {
    return this.serialize(async () => {
      const data = await this.getFromStorage();
      const uniqueConversationIds = Array.from(
        new Set([targetConversationId, ...sourceConversationIds]),
      ).filter(Boolean);

      const mergedMessages = new Map<string, StarredMessage>();

      for (const conversationId of uniqueConversationIds) {
        const messages = data.messages[conversationId] || [];
        for (const message of messages) {
          const normalizedMessage: StarredMessage = {
            ...message,
            conversationId: targetConversationId,
            conversationUrl: conversationUrl || message.conversationUrl,
          };
          const existing = mergedMessages.get(message.turnId);
          if (!existing || normalizedMessage.starredAt >= existing.starredAt) {
            mergedMessages.set(message.turnId, normalizedMessage);
          }
        }
      }

      if (mergedMessages.size > 0) {
        data.messages[targetConversationId] = Array.from(mergedMessages.values());
      } else {
        delete data.messages[targetConversationId];
      }

      for (const conversationId of uniqueConversationIds) {
        if (conversationId !== targetConversationId) {
          delete data.messages[conversationId];
        }
      }

      await this.saveToStorage(data);
      return data.messages[targetConversationId] || [];
    });
  }
}

type StarredMessageRequest =
  | { type: 'gv.starred.add'; payload: StarredMessage }
  | {
      type: 'gv.starred.remove' | 'gv.starred.isStarred';
      payload: Pick<StarredMessage, 'conversationId' | 'turnId'>;
    }
  | { type: 'gv.starred.getAll' }
  | { type: 'gv.starred.getForConversation'; payload: Pick<StarredMessage, 'conversationId'> }
  | {
      type: 'gv.starred.reconcileConversationIds';
      payload: {
        targetConversationId: string;
        sourceConversationIds?: unknown;
        conversationUrl?: unknown;
      };
    };

export interface StarredMessagesOwner {
  handle(message: unknown): Promise<Record<string, unknown>> | null;
  getAllStarredMessages(): Promise<StarredMessagesData>;
}

/** Owns starred-message writes and reconciliation in one serialized queue. */
export function createStarredMessagesOwner(area: StorageArea): StarredMessagesOwner {
  const manager = new StarredMessagesManager(area);
  return {
    getAllStarredMessages: () => manager.getAllStarredMessages(),
    handle(message) {
      const request = message as StarredMessageRequest | null;
      switch (request?.type) {
        case 'gv.starred.add':
          return manager.addStarredMessage(request.payload).then((added) => ({ ok: true, added }));
        case 'gv.starred.remove':
          return manager
            .removeStarredMessage(request.payload.conversationId, request.payload.turnId)
            .then((removed) => ({ ok: true, removed }));
        case 'gv.starred.getAll':
          return manager.getAllStarredMessages().then((data) => ({ ok: true, data }));
        case 'gv.starred.getForConversation':
          return manager
            .getStarredMessagesForConversation(request.payload.conversationId)
            .then((messages) => ({ ok: true, messages }));
        case 'gv.starred.isStarred':
          return manager
            .isMessageStarred(request.payload.conversationId, request.payload.turnId)
            .then((isStarred) => ({ ok: true, isStarred }));
        case 'gv.starred.reconcileConversationIds':
          return manager
            .reconcileConversationIds(
              request.payload.targetConversationId,
              Array.isArray(request.payload.sourceConversationIds)
                ? request.payload.sourceConversationIds
                : [],
              typeof request.payload.conversationUrl === 'string'
                ? request.payload.conversationUrl
                : undefined,
            )
            .then((messages) => ({ ok: true, messages }));
        default:
          return null;
      }
    },
  };
}
