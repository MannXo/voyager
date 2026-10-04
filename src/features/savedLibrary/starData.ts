import type { StarredMessage, StarredMessagesData } from './starTypes';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function normalizeStarredMessages(value: unknown): StarredMessagesData {
  if (!isRecord(value) || !isRecord(value.messages)) {
    throw new Error('Invalid starred messages data');
  }
  const messages: Record<string, StarredMessage[]> = {};
  for (const [conversationId, bucket] of Object.entries(value.messages)) {
    if (!Array.isArray(bucket)) throw new Error('Invalid starred messages bucket');
    const records: StarredMessage[] = [];
    for (const item of bucket) {
      if (!isRecord(item) || typeof item.turnId !== 'string' || !item.turnId) continue;
      records.push({
        ...item,
        turnId: item.turnId,
        conversationId:
          typeof item.conversationId === 'string' && item.conversationId
            ? item.conversationId
            : conversationId,
        content: typeof item.content === 'string' ? item.content : '',
        conversationUrl: typeof item.conversationUrl === 'string' ? item.conversationUrl : '',
        starredAt:
          typeof item.starredAt === 'number' && Number.isFinite(item.starredAt)
            ? item.starredAt
            : 0,
      });
    }
    Object.defineProperty(messages, conversationId, {
      value: records,
      enumerable: true,
      configurable: true,
      writable: true,
    });
  }
  return { messages };
}

export function mergeStarredMessages(
  local: StarredMessagesData,
  cloud: StarredMessagesData,
): StarredMessagesData {
  const messages: Record<string, StarredMessage[]> = {};
  for (const id of new Set([...Object.keys(local.messages), ...Object.keys(cloud.messages)])) {
    const merged = new Map<string, StarredMessage>();
    for (const item of [...(cloud.messages[id] || []), ...(local.messages[id] || [])]) {
      const existing = merged.get(item.turnId);
      if (!existing) {
        merged.set(item.turnId, { ...item });
        continue;
      }
      const winner = item.starredAt >= existing.starredAt ? item : existing;
      const other = winner === item ? existing : item;
      const record = { ...other, ...winner } as StarredMessage & Record<string, unknown>;
      // Sparse newer records must not erase richer previews or opaque metadata.
      for (const [field, value] of Object.entries(other)) {
        if (record[field] === undefined || record[field] === null || record[field] === '') {
          record[field] = value;
        }
      }
      merged.set(item.turnId, record);
    }
    Object.defineProperty(messages, id, {
      value: Array.from(merged.values()),
      enumerable: true,
      configurable: true,
      writable: true,
    });
  }
  return { messages };
}
