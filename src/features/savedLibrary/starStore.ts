import { StorageKeys } from '@/core/types/common';

import { mergeStarredMessages, normalizeStarredMessages } from './starData';
import type { StarredMessage, StarredMessagesData } from './starTypes';

export interface StorageArea {
  get(keys: string[]): Promise<Record<string, unknown>>;
  set(items: Record<string, unknown>): Promise<void>;
}

export interface StarStore {
  getAll(): Promise<StarredMessagesData>;
  getForConversation(id: string): Promise<StarredMessage[]>;
  add(item: StarredMessage): Promise<boolean>;
  remove(conversationId: string, turnId: string): Promise<boolean>;
  reconcile(target: string, sources: string[], url?: string): Promise<StarredMessage[]>;
  mergeCloud(envelope: unknown): Promise<{ status: 'absent' | 'merged'; count: number }>;
}

const MAX_CONTENT_LENGTH = 60;

export function createStarStore(area: StorageArea): StarStore {
  let queue: Promise<unknown> = Promise.resolve();
  const serialize = <T>(operation: () => Promise<T>): Promise<T> => {
    const pending = queue.then(operation);
    queue = pending.catch(() => {});
    return pending;
  };
  const keys = [StorageKeys.SAVED_LIBRARY_STARS, StorageKeys.TIMELINE_STARRED_MESSAGES];
  const write = (data: StarredMessagesData): Promise<void> =>
    area.set({
      [StorageKeys.SAVED_LIBRARY_STARS]: data,
      [StorageKeys.TIMELINE_STARRED_MESSAGES]: data,
    });
  const read = async (): Promise<{ data: StarredMessagesData; dirty: boolean }> => {
    // Downgraded clients may add legacy stars even after the neutral projection exists.
    const values = await area.get(keys);
    const neutral = values[StorageKeys.SAVED_LIBRARY_STARS];
    const legacy = values[StorageKeys.TIMELINE_STARRED_MESSAGES];
    const data = mergeStarredMessages(
      neutral === undefined ? { messages: {} } : normalizeStarredMessages(neutral),
      legacy === undefined ? { messages: {} } : normalizeStarredMessages(legacy),
    );
    const serialized = JSON.stringify(data);
    return {
      data,
      dirty:
        (neutral !== undefined || legacy !== undefined) &&
        (JSON.stringify(neutral) !== serialized || JSON.stringify(legacy) !== serialized),
    };
  };
  const readReconciled = async (): Promise<StarredMessagesData> => {
    const { data, dirty } = await read();
    if (dirty) await write(data);
    return data;
  };

  return {
    getAll: () => serialize(readReconciled),
    getForConversation: (id) => serialize(async () => (await readReconciled()).messages[id] || []),
    add: (item) =>
      serialize(async () => {
        const { data, dirty } = await read();
        const bucket = data.messages[item.conversationId] || [];
        if (bucket.some((message) => message.turnId === item.turnId)) {
          if (dirty) await write(data);
          return false;
        }
        const normalized = normalizeStarredMessages({
          messages: { [item.conversationId]: [item] },
        }).messages[item.conversationId][0];
        if (!normalized) throw new Error('Invalid starred message');
        data.messages[item.conversationId] = [
          ...bucket,
          {
            ...normalized,
            content:
              normalized.content.length > MAX_CONTENT_LENGTH
                ? `${normalized.content.slice(0, MAX_CONTENT_LENGTH)}...`
                : normalized.content,
          },
        ];
        await write(data);
        return true;
      }),
    remove: (conversationId, turnId) =>
      serialize(async () => {
        const { data, dirty } = await read();
        const bucket = data.messages[conversationId] || [];
        const remaining = bucket.filter((item) => item.turnId !== turnId);
        if (bucket.length === remaining.length) {
          if (dirty) await write(data);
          return false;
        }
        if (remaining.length) data.messages[conversationId] = remaining;
        else delete data.messages[conversationId];
        await write(data);
        return true;
      }),
    reconcile: (target, sources, url) =>
      serialize(async () => {
        const { data } = await read();
        const ids = Array.from(new Set([target, ...sources])).filter(Boolean);
        let merged: StarredMessagesData = { messages: {} };
        for (const id of ids) {
          const bucket = (data.messages[id] || []).map((item) => ({
            ...item,
            conversationId: target,
            conversationUrl: url || item.conversationUrl,
          }));
          // Later source buckets keep the existing reconciliation tie precedence.
          merged = mergeStarredMessages({ messages: { [target]: bucket } }, merged);
        }
        const result = merged.messages[target] || [];
        if (result.length) data.messages[target] = result;
        else delete data.messages[target];
        for (const id of ids) if (id !== target) delete data.messages[id];
        await write(data);
        return result;
      }),
    mergeCloud: (envelope) =>
      serialize(async () => {
        if (envelope === null || typeof envelope !== 'object') {
          return { status: 'absent', count: 0 };
        }
        if (
          Array.isArray(envelope) ||
          ('format' in envelope && envelope.format !== 'gemini-voyager.starred.v1') ||
          !('data' in envelope)
        ) {
          throw new Error('Invalid starred messages envelope');
        }
        const cloud = normalizeStarredMessages(envelope.data);
        const data = mergeStarredMessages((await read()).data, cloud);
        await write(data);
        return {
          status: 'merged',
          count: Object.values(data.messages).reduce((total, bucket) => total + bucket.length, 0),
        };
      }),
  };
}
