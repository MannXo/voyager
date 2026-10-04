/**
 * Service for managing starred messages across all conversations
 * Uses message passing to background script to prevent race conditions
 */
import { StorageKeys } from '@/core/types/common';
import { eventBus } from '@/pages/content/timeline/EventBus';

import { decodeStarredSnapshot, normalizeStarredMessages } from './starData';
import type { StarredMessage, StarredMessagesData } from './starTypes';

export class StarredMessagesService {
  /**
   * Send message to background script and wait for response
   */
  private static async sendMessage<T>(type: string, payload?: unknown): Promise<T> {
    return new Promise((resolve, reject) => {
      chrome.runtime.sendMessage({ type, payload }, (response) => {
        if (chrome.runtime.lastError) {
          reject(new Error(chrome.runtime.lastError.message));
          return;
        }
        if (!response || !response.ok) {
          reject(new Error(response?.error || 'Operation failed'));
          return;
        }
        resolve(response as T);
      });
    });
  }

  static decodeStorageChange(
    area: string,
    changes: Record<string, unknown>,
  ): StarredMessagesData | undefined {
    if (area !== 'local') return undefined;
    const change = changes[StorageKeys.SAVED_LIBRARY_STARS];
    if (!change || typeof change !== 'object' || Array.isArray(change)) return undefined;
    if ('newValue' in change) {
      return change.newValue === undefined
        ? { messages: {} }
        : decodeStarredSnapshot(change.newValue);
    }
    return 'oldValue' in change ? { messages: {} } : undefined;
  }

  /**
   * Get all starred messages from storage
   */
  static async getAllStarredMessages(): Promise<StarredMessagesData> {
    const response = await this.sendMessage<{ ok: boolean; data: StarredMessagesData }>(
      'gv.starred.getAll',
    );
    return normalizeStarredMessages(response.data);
  }

  /**
   * Get starred messages for a specific conversation
   */
  static async getStarredMessagesForConversation(
    conversationId: string,
  ): Promise<StarredMessage[]> {
    const response = await this.sendMessage<{ ok: boolean; messages: StarredMessage[] }>(
      'gv.starred.getForConversation',
      { conversationId },
    );
    return normalizeStarredMessages({ messages: { [conversationId]: response.messages } }).messages[
      conversationId
    ];
  }

  /**
   * Add a starred message - delegated to background script
   */
  static async addStarredMessage(message: StarredMessage): Promise<void> {
    const response = await this.sendMessage<{ ok: boolean; added: boolean }>(
      'gv.starred.add',
      message,
    );

    if (response.added) {
      // Emit event for cross-component synchronization
      eventBus.emit('starred:added', {
        conversationId: message.conversationId,
        turnId: message.turnId,
      });

      // Also update localStorage for backward compatibility
      await this.updateLegacyStorage(message.conversationId, message.turnId, 'add');
    }
  }

  /**
   * Remove a starred message - delegated to background script
   */
  static async removeStarredMessage(conversationId: string, turnId: string): Promise<void> {
    const response = await this.sendMessage<{ ok: boolean; removed: boolean }>(
      'gv.starred.remove',
      { conversationId, turnId },
    );

    if (response.removed) {
      // Emit event for cross-component synchronization
      eventBus.emit('starred:removed', {
        conversationId,
        turnId,
      });

      // Also update localStorage for backward compatibility
      await this.updateLegacyStorage(conversationId, turnId, 'remove');
    }
  }

  static async mergeCloud(
    envelope: unknown,
  ): Promise<{ status: 'absent' | 'merged'; count: number }> {
    const response = await this.sendMessage<{
      ok: boolean;
      status: 'absent' | 'merged';
      count: number;
    }>('gv.starred.mergeCloud', envelope);
    return { status: response.status, count: response.count };
  }

  /**
   * Update legacy localStorage format for backward compatibility
   * This ensures TimelineManager's storage event listener works
   */
  private static async updateLegacyStorage(
    conversationId: string,
    turnId: string,
    action: 'add' | 'remove',
  ): Promise<void> {
    try {
      // Catalog timelines use their own local keys; Gemini's legacy key remains unchanged.
      const site = /^(claude|chatgpt|deepseek):/.exec(conversationId)?.[1];
      const key = site
        ? `gvTimelineStars:${site}:${conversationId}`
        : `geminiTimelineStars:${conversationId}`;
      const raw = localStorage.getItem(key);
      let ids = this.readLocalStarIds(raw);
      if (site && raw === null) {
        // A first Saved Library edit must preserve stars saved before the catalog mirror existed.
        const legacyIds = this.readLocalStarIds(
          localStorage.getItem(`geminiTimelineStars:${conversationId}`),
        );
        const messages = await this.getStarredMessagesForConversation(conversationId);
        const currentRaw = localStorage.getItem(key);
        ids =
          currentRaw === null
            ? Array.from(new Set([...legacyIds, ...messages.map((message) => message.turnId)]))
            : this.readLocalStarIds(currentRaw);
      }

      if (action === 'add') {
        if (!ids.includes(turnId)) {
          ids.push(turnId);
        }
      } else {
        ids = ids.filter((id) => id !== turnId);
      }

      localStorage.setItem(key, JSON.stringify(ids));
    } catch (error) {
      console.warn('[StarredMessagesService] Failed to update legacy storage:', error);
    }
  }

  private static readLocalStarIds(raw: string | null): string[] {
    try {
      const ids: unknown = JSON.parse(raw || '[]');
      return Array.isArray(ids) ? (ids as string[]) : [];
    } catch {
      return [];
    }
  }

  /**
   * Check if a message is starred
   */
  static async isMessageStarred(conversationId: string, turnId: string): Promise<boolean> {
    const messages = await this.getStarredMessagesForConversation(conversationId);
    return messages.some((m) => m.turnId === turnId);
  }

  /**
   * Get all starred messages sorted by timestamp (newest first)
   */
  static async getAllStarredMessagesSorted(): Promise<StarredMessage[]> {
    const data = await this.getAllStarredMessages();
    const allMessages: StarredMessage[] = [];

    Object.values(data.messages).forEach((messages) => {
      allMessages.push(...messages);
    });

    return allMessages.sort((a, b) => b.starredAt - a.starredAt);
  }

  /**
   * Merge legacy conversation IDs into the current stable conversation ID.
   */
  static async reconcileConversationIds(
    targetConversationId: string,
    sourceConversationIds: string[],
    conversationUrl: string,
  ): Promise<StarredMessage[]> {
    const response = await this.sendMessage<{ ok: boolean; messages: StarredMessage[] }>(
      'gv.starred.reconcileConversationIds',
      {
        targetConversationId,
        sourceConversationIds,
        conversationUrl,
      },
    );
    return normalizeStarredMessages({
      messages: { [targetConversationId]: response.messages },
    }).messages[targetConversationId];
  }
}
