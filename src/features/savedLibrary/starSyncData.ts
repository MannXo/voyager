import {
  buildConversationIdFromUrl,
  extractConversationIdFromUrl,
} from '@/core/utils/conversationIdentity';

import { mergeStarredMessages, normalizeStarredMessages } from './starData';
import type { StarredMessagesData, StarTombstone } from './starTypes';

export interface StarState {
  data: StarredMessagesData;
  tombstones: StarTombstone[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

const RETENTION_MS = 180 * 24 * 60 * 60 * 1000;
const identity = (conversationId: string, turnId: string): string =>
  JSON.stringify([conversationId, turnId]);

export function starDeletionConversationIds(conversationId: string, url: string): string[] {
  if (
    !conversationId.startsWith('gemini:') ||
    conversationId.startsWith('gemini:conv:') ||
    !extractConversationIdFromUrl(url)
  )
    return [conversationId];
  return [conversationId, buildConversationIdFromUrl(url)];
}

export function normalizeStarTombstones(value: unknown): StarTombstone[] {
  if (!Array.isArray(value)) return [];
  const records: StarTombstone[] = [];
  for (const item of value) {
    if (
      !isRecord(item) ||
      typeof item.conversationId !== 'string' ||
      !item.conversationId ||
      typeof item.turnId !== 'string' ||
      !item.turnId ||
      typeof item.conversationUrl !== 'string' ||
      typeof item.starredAt !== 'number' ||
      !Number.isFinite(item.starredAt) ||
      typeof item.deletedAt !== 'number' ||
      !Number.isFinite(item.deletedAt) ||
      (item.account !== undefined && typeof item.account !== 'string') ||
      (item.movedTo !== undefined && (typeof item.movedTo !== 'string' || !item.movedTo))
    ) {
      continue;
    }
    const record: StarTombstone = {
      conversationId: item.conversationId,
      turnId: item.turnId,
      conversationUrl: item.conversationUrl,
      starredAt: item.starredAt,
      deletedAt: item.deletedAt,
      ...(item.account !== undefined ? { account: item.account } : {}),
      ...(item.movedTo !== undefined ? { movedTo: item.movedTo } : {}),
    };
    const ids = record.movedTo
      ? [record.conversationId]
      : starDeletionConversationIds(record.conversationId, record.conversationUrl);
    records.push(...ids.map((conversationId) => ({ ...record, conversationId })));
  }
  return records;
}

export function mergeStarState(
  sources: readonly StarredMessagesData[],
  deletions: unknown,
  now: number,
): StarState {
  const tombstones = new Map<string, StarTombstone>();
  for (const item of normalizeStarTombstones(deletions)) {
    const key = identity(item.conversationId, item.turnId);
    const existing = tombstones.get(key);
    if (
      !existing ||
      item.starredAt > existing.starredAt ||
      (item.starredAt === existing.starredAt && item.deletedAt >= existing.deletedAt)
    ) {
      tombstones.set(key, item);
    }
  }
  const data = sources.reduce(
    (merged, source) => mergeStarredMessages(merged, source),
    normalizeStarredMessages(undefined),
  );
  for (const [conversationId, bucket] of Object.entries(data.messages)) {
    const remaining = bucket.filter((item) =>
      starDeletionConversationIds(conversationId, item.conversationUrl).every((id) => {
        const deletion = tombstones.get(identity(id, item.turnId));
        return !deletion || item.starredAt > deletion.starredAt;
      }),
    );
    if (remaining.length !== bucket.length) {
      if (remaining.length) data.messages[conversationId] = remaining;
      else delete data.messages[conversationId];
    }
  }
  return {
    data,
    tombstones: Array.from(tombstones.values()).filter(
      (item) => now - item.deletedAt <= RETENTION_MS,
    ),
  };
}
