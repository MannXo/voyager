import { extractRouteUserIdFromUrl } from '@/core/services/AccountIsolationService';
import type { SyncAccountScope } from '@/core/types/sync';
import { hashString } from '@/core/utils/hash';

import { mergeStarredMessages, normalizeStarredMessages } from './starData';
import { normalizeStarTombstones, type StarState } from './starSyncData';
import type { StarredMessage, StarredMessagesData, StarTombstone } from './starTypes';

export const STARS_V2_FORMAT = 'gemini-voyager.stars.v2';
export interface StarsExportPayloadV2 {
  format: typeof STARS_V2_FORMAT;
  exportedAt: string;
  version: string;
  accountScope?: { accountHash: string };
  items: StarredMessage[];
  tombstones: StarTombstone[];
}
export interface StarSyncSources {
  v1?: unknown;
  v2?: unknown;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
const nonempty = (value: unknown): value is string => typeof value === 'string' && !!value;
const finite = (value: unknown): value is number =>
  typeof value === 'number' && Number.isFinite(value);
const optionalString = (value: unknown): boolean =>
  value === undefined || typeof value === 'string';

function itemsToData(items: StarredMessage[]): StarredMessagesData {
  const messages: Record<string, StarredMessage[]> = Object.create(null);
  for (const item of items) (messages[item.conversationId] ??= []).push(item);
  return normalizeStarredMessages({ messages });
}

export function filterStarStateByScope(
  state: StarState,
  scope: SyncAccountScope | null,
): StarState {
  const matches = (url: string): boolean => {
    if (!scope?.routeUserId) return true;
    const route = extractRouteUserIdFromUrl(url);
    return route === null || route === scope.routeUserId;
  };
  const messages: Record<string, StarredMessage[]> = Object.create(null);
  for (const [id, bucket] of Object.entries(state.data.messages)) {
    const filtered = bucket.filter((item) => matches(item.conversationUrl));
    if (filtered.length) messages[id] = filtered;
  }
  return {
    data: { messages },
    tombstones: state.tombstones.filter((item) => matches(item.conversationUrl)),
  };
}

export function decodeStarsV2(value: unknown, scope: SyncAccountScope | null): StarState {
  if (
    !isRecord(value) ||
    value.format !== STARS_V2_FORMAT ||
    typeof value.exportedAt !== 'string' ||
    !Number.isFinite(Date.parse(value.exportedAt)) ||
    typeof value.version !== 'string' ||
    !Array.isArray(value.items) ||
    !Array.isArray(value.tombstones) ||
    (scope
      ? !isRecord(value.accountScope) ||
        value.accountScope.accountHash !== hashString(scope.accountKey)
      : value.accountScope !== undefined)
  )
    throw new Error('Invalid stars v2 envelope or account scope');
  for (const item of value.items) {
    if (
      !isRecord(item) ||
      !nonempty(item.conversationId) ||
      !nonempty(item.turnId) ||
      typeof item.content !== 'string' ||
      typeof item.conversationUrl !== 'string' ||
      !finite(item.starredAt) ||
      !optionalString(item.account) ||
      !optionalString(item.conversationTitle) ||
      !optionalString(item.text)
    )
      throw new Error('Invalid stars v2 item');
  }
  for (const item of value.tombstones) {
    if (
      !isRecord(item) ||
      !nonempty(item.conversationId) ||
      !nonempty(item.turnId) ||
      typeof item.conversationUrl !== 'string' ||
      !finite(item.starredAt) ||
      !finite(item.deletedAt) ||
      !optionalString(item.account) ||
      (item.movedTo !== undefined && !nonempty(item.movedTo))
    )
      throw new Error('Invalid stars v2 deletion');
  }
  return filterStarStateByScope(
    {
      data: itemsToData(value.items as StarredMessage[]),
      tombstones: normalizeStarTombstones(value.tombstones),
    },
    scope,
  );
}

export function decodeStarSyncSources(
  sources: StarSyncSources,
  scope: SyncAccountScope | null,
): StarState {
  const v2 =
    sources.v2 == null
      ? { data: normalizeStarredMessages(undefined), tombstones: [] }
      : decodeStarsV2(sources.v2, scope);
  const v1 = sources.v1;
  if (
    v1 != null &&
    (!isRecord(v1) ||
      !isRecord(v1.data) ||
      !isRecord(v1.data.messages) ||
      ('format' in v1 && v1.format !== 'gemini-voyager.starred.v1'))
  )
    throw new Error('Invalid starred messages envelope');
  return filterStarStateByScope(
    {
      data: mergeStarredMessages(
        v2.data,
        normalizeStarredMessages(isRecord(v1) ? v1.data : undefined),
      ),
      tombstones: v2.tombstones,
    },
    scope,
  );
}

export function buildStarsV2(
  state: StarState,
  scope: SyncAccountScope | null,
  version: string,
  exportedAt = new Date().toISOString(),
): StarsExportPayloadV2 {
  const filtered = filterStarStateByScope(state, scope);
  return {
    format: STARS_V2_FORMAT,
    exportedAt,
    version,
    ...(scope ? { accountScope: { accountHash: hashString(scope.accountKey) } } : {}),
    items: Object.values(filtered.data.messages).flat(),
    tombstones: normalizeStarTombstones(filtered.tombstones),
  };
}
