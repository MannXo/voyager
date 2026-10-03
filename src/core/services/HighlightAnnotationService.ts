import type {
  HighlightAccountScope,
  HighlightClearMarkerV1,
  HighlightConversationBucketV1,
  HighlightCreateInput,
  HighlightImportStats,
  HighlightIndexV1,
  HighlightRecordV1,
  HighlightStoredAccountScope,
  HighlightUpdatePatch,
} from '@/core/types/highlight';
import {
  HIGHLIGHT_DEVICE_ID_KEY,
  HIGHLIGHT_SCHEMA_VERSION,
  isHighlightClearMarkerV1,
} from '@/core/types/highlight';
import { type StorageBudget, storageBudget } from '@/features/storage/storageBudget';

import {
  HighlightAnnotationError,
  anchorIdentity,
  compareClearMarkers,
  compareHighlightRecords,
  filterRecords,
  getHighlightAccountHash,
  getHighlightBucketStorageKey,
  getHighlightIndexStorageKey,
  isClearedByMarker,
  nextRevisionCounter,
  parseBucket,
  storedScope,
  updateIndexEntry,
  validateRecord,
} from './highlightAnnotationData';
import type { HighlightScope } from './highlightAnnotationData';
import { HighlightAnnotationStore } from './highlightAnnotationStore';
export {
  HighlightAnnotationError,
  compareHighlightRecords,
  createHighlightSourceTextHash,
  getHighlightAccountHash,
  getHighlightIndexStorageKey,
  getHighlightConversationKey,
  getHighlightBucketStorageKey,
} from './highlightAnnotationData';
export type { HighlightScope, HighlightAnnotationErrorCode } from './highlightAnnotationData';

export interface HighlightAddResult {
  record: HighlightRecordV1;
  duplicate: boolean;
}

export interface HighlightRemoveResult {
  removed: boolean;
  tombstone: boolean;
  record?: HighlightRecordV1;
}

export interface HighlightClearResult {
  removed: number;
  clearMarker: HighlightClearMarkerV1;
}

export interface HighlightClearAllAccountsResult {
  removed: number;
  accounts: Array<{
    accountScope: HighlightStoredAccountScope;
    clearMarker: HighlightClearMarkerV1;
  }>;
}

export interface HighlightAccountSnapshot {
  accountScope: HighlightStoredAccountScope;
  clearMarker?: HighlightClearMarkerV1;
  records: HighlightRecordV1[];
}

export interface HighlightImportMergeOptions {
  clearMarker?: HighlightClearMarkerV1;
}

export interface HighlightQueryOptions {
  includeDeleted?: boolean;
}

export interface HighlightStorageAdapter {
  get(keys: null | string | readonly string[]): Promise<Record<string, unknown>>;
  set(items: Record<string, unknown>): Promise<void>;
  remove(keys: string | readonly string[]): Promise<void>;
  getBytesInUse?(keys: null | string | readonly string[]): Promise<number>;
  /** null means the granted runtime permission removes the practical quota. */
  getEffectiveQuotaBytes?(): Promise<number | null>;
}

export interface HighlightAnnotationServiceDependencies {
  storage?: HighlightStorageAdapter;
  now?: () => number;
  randomUUID?: () => string;
  /** The background's storage budget: each commit checks and writes in one of its steps (F2). */
  budget?: Pick<StorageBudget, 'runChecked'>;
}

export class HighlightAnnotationService {
  private readonly store: HighlightAnnotationStore;
  private operationQueue: Promise<unknown> = Promise.resolve();

  constructor(dependencies: HighlightAnnotationServiceDependencies = {}) {
    this.store = new HighlightAnnotationStore(dependencies);
  }

  private serialize<T>(operation: () => Promise<T>): Promise<T> {
    const next = this.operationQueue.then(operation, operation);
    this.operationQueue = next.catch(() => undefined);
    return next;
  }

  private async getAllUnsafe(
    scopeInput: HighlightScope,
    options: HighlightQueryOptions,
  ): Promise<HighlightRecordV1[]> {
    const scope = storedScope(scopeInput);
    const index = await this.store.readIndex(scope);
    const buckets = await this.store.readBucketsFromIndex(scope, index);
    const records = Array.from(buckets.values()).flatMap(({ bucket }) =>
      Object.values(bucket.records),
    );
    return filterRecords(records, index.clearMarkers?.[scope.platform], options);
  }

  async getAll(
    scope: HighlightScope,
    options: HighlightQueryOptions = {},
  ): Promise<HighlightRecordV1[]> {
    return this.serialize(() => this.getAllUnsafe(scope, options));
  }

  async getConversation(
    scopeInput: HighlightScope,
    conversationId: string,
    options: HighlightQueryOptions = {},
  ): Promise<HighlightRecordV1[]> {
    return this.serialize(async () => {
      const scope = storedScope(scopeInput);
      const [index, bucket] = await Promise.all([
        this.store.readIndex(scope),
        this.store.readBucket(scope, conversationId),
      ]);
      return filterRecords(
        Object.values(bucket.records),
        index.clearMarkers?.[scope.platform],
        options,
      );
    });
  }

  async getAllAccounts(options: HighlightQueryOptions = {}): Promise<HighlightRecordV1[]> {
    return this.serialize(() => this.store.getAllAccounts(options));
  }

  async getAccountSnapshot(scopeInput: HighlightScope): Promise<HighlightAccountSnapshot> {
    return this.serialize(async () => {
      const scope = storedScope(scopeInput);
      const index = await this.store.readIndex(scope);
      const buckets = await this.store.readBucketsFromIndex(scope, index);
      const records = filterRecords(
        Array.from(buckets.values()).flatMap(({ bucket }) => Object.values(bucket.records)),
        index.clearMarkers?.[scope.platform],
        { includeDeleted: true },
      );
      return {
        accountScope: scope,
        clearMarker: index.clearMarkers?.[scope.platform],
        records,
      };
    });
  }

  /**
   * Claim highlights written before a route id/email was available. Older page
   * loads could resolve to the unscoped `default` account during startup and
   * later resolve the Saved Library to the real email account. Treat that
   * default bucket as one-time legacy data: merge it into the first resolved
   * account, then clear only the matching platform from the legacy bucket.
   */
  async claimLegacyDefaultHighlights(scope: HighlightAccountScope): Promise<number> {
    if (scope.accountKey === 'default') return 0;

    const legacyScope: HighlightAccountScope = {
      platform: scope.platform,
      accountKey: 'default',
      accountId: 0,
      routeUserId: null,
    };
    const snapshot = await this.getAccountSnapshot(legacyScope);
    const legacyRecords = snapshot.records.filter((record) => record.platform === scope.platform);
    if (legacyRecords.length === 0) return 0;

    const accountHash = getHighlightAccountHash(scope);
    await this.importMerge(
      scope,
      legacyRecords.map((record) => ({ ...record, accountHash })),
    );
    await this.clearAll(legacyScope);
    return legacyRecords.filter((record) => record.deletedAt === undefined).length;
  }

  async add(scopeInput: HighlightScope, input: HighlightCreateInput): Promise<HighlightAddResult> {
    return this.serialize(async () => {
      const scope = storedScope(scopeInput);
      if (!input.conversationId.trim()) {
        throw new HighlightAnnotationError('VALIDATION_FAILED', 'Conversation id is required');
      }

      const [index, bucket] = await Promise.all([
        this.store.readIndex(scope),
        this.store.readBucket(scope, input.conversationId),
      ]);
      const marker = index.clearMarkers?.[scope.platform];
      const identity = anchorIdentity(input);
      const duplicate = Object.values(bucket.records).find(
        (record) =>
          record.deletedAt === undefined &&
          !isClearedByMarker(record, marker) &&
          anchorIdentity(record) === identity,
      );
      if (duplicate) return { record: duplicate, duplicate: true };

      const device = await this.store.getDeviceId();
      const now = this.store.now;
      const record: HighlightRecordV1 = {
        id: this.store.generateUuid(),
        schemaVersion: HIGHLIGHT_SCHEMA_VERSION,
        platform: scope.platform,
        accountHash: scope.accountHash,
        conversationId: input.conversationId,
        conversationUrl: input.conversationUrl,
        ...(input.conversationTitle !== undefined
          ? { conversationTitle: input.conversationTitle }
          : {}),
        turnId: input.turnId,
        role: input.role,
        anchor: input.anchor,
        ...(input.note !== undefined && input.note !== '' ? { note: input.note } : {}),
        color: input.color ?? 'yellow',
        createdAt: now,
        updatedAt: now,
        revision: {
          counter: nextRevisionCounter(bucket, marker),
          deviceId: device.id,
        },
        ...(marker?.generation ? { clearGeneration: marker.generation.id } : {}),
      };
      validateRecord(record);

      const bucketKey = getHighlightBucketStorageKey(scope, input.conversationId);
      const nextBucket: HighlightConversationBucketV1 = {
        ...bucket,
        records: { ...bucket.records, [record.id]: record },
        updatedAt: now,
      };
      const nextIndex = updateIndexEntry(index, bucketKey, nextBucket, now);
      await this.store.commit({
        [getHighlightIndexStorageKey(scope)]: nextIndex,
        [bucketKey]: nextBucket,
        ...(device.needsWrite ? { [HIGHLIGHT_DEVICE_ID_KEY]: device.id } : {}),
      });
      return { record, duplicate: false };
    });
  }

  async update(
    scopeInput: HighlightScope,
    conversationId: string,
    id: string,
    patch: HighlightUpdatePatch,
  ): Promise<HighlightRecordV1> {
    return this.serialize(async () => {
      const scope = storedScope(scopeInput);
      const [index, bucket, device] = await Promise.all([
        this.store.readIndex(scope),
        this.store.readBucket(scope, conversationId),
        this.store.getDeviceId(),
      ]);
      const existing = bucket.records[id];
      if (!existing || existing.deletedAt !== undefined) {
        throw new HighlightAnnotationError('NOT_FOUND', 'Highlight record was not found', {
          conversationId,
          id,
        });
      }

      const now = this.store.now;
      const updated: HighlightRecordV1 = {
        ...existing,
        ...(patch.conversationUrl !== undefined ? { conversationUrl: patch.conversationUrl } : {}),
        ...(patch.turnId !== undefined ? { turnId: patch.turnId } : {}),
        ...(patch.role !== undefined ? { role: patch.role } : {}),
        ...(patch.anchor !== undefined ? { anchor: patch.anchor } : {}),
        ...(patch.color !== undefined ? { color: patch.color } : {}),
        updatedAt: now,
        revision: {
          counter: nextRevisionCounter(bucket, index.clearMarkers?.[scope.platform]),
          deviceId: device.id,
        },
      };
      if (patch.conversationTitle === null) delete updated.conversationTitle;
      else if (patch.conversationTitle !== undefined) {
        updated.conversationTitle = patch.conversationTitle;
      }
      if (patch.note === null || patch.note === '') delete updated.note;
      else if (patch.note !== undefined) updated.note = patch.note;
      validateRecord(updated);

      const updatedIdentity = anchorIdentity(updated);
      const duplicate = Object.values(bucket.records).find(
        (record) =>
          record.id !== id &&
          record.deletedAt === undefined &&
          anchorIdentity(record) === updatedIdentity,
      );
      if (duplicate) {
        throw new HighlightAnnotationError(
          'VALIDATION_FAILED',
          'Another highlight already uses this text anchor',
          { id, duplicateId: duplicate.id },
        );
      }

      const bucketKey = getHighlightBucketStorageKey(scope, conversationId);
      const nextBucket: HighlightConversationBucketV1 = {
        ...bucket,
        records: { ...bucket.records, [id]: updated },
        updatedAt: now,
      };
      const nextIndex = updateIndexEntry(index, bucketKey, nextBucket, now);
      await this.store.commit({
        [getHighlightIndexStorageKey(scope)]: nextIndex,
        [bucketKey]: nextBucket,
        ...(device.needsWrite ? { [HIGHLIGHT_DEVICE_ID_KEY]: device.id } : {}),
      });
      return updated;
    });
  }

  async remove(
    scopeInput: HighlightScope,
    conversationId: string,
    id: string,
    options: { tombstone?: boolean } = {},
  ): Promise<HighlightRemoveResult> {
    return this.serialize(async () => {
      const scope = storedScope(scopeInput);
      const [index, bucket] = await Promise.all([
        this.store.readIndex(scope),
        this.store.readBucket(scope, conversationId),
      ]);
      const existing = bucket.records[id];
      if (!existing) return { removed: false, tombstone: false };

      const now = this.store.now;
      const bucketKey = getHighlightBucketStorageKey(scope, conversationId);
      if (options.tombstone === true) {
        if (existing.deletedAt !== undefined) {
          return { removed: false, tombstone: true, record: existing };
        }
        const device = await this.store.getDeviceId();
        const tombstoneRecord: HighlightRecordV1 = {
          ...existing,
          anchor: {
            quote: { exact: 'x', prefix: '', suffix: '' },
            position: { start: 0, end: 1 },
            sourceTextHash: `deleted:${id}`,
          },
          updatedAt: now,
          deletedAt: now,
          revision: {
            counter: nextRevisionCounter(bucket, index.clearMarkers?.[scope.platform]),
            deviceId: device.id,
          },
        };
        delete tombstoneRecord.note;
        delete tombstoneRecord.conversationTitle;
        validateRecord(tombstoneRecord);
        const nextBucket: HighlightConversationBucketV1 = {
          ...bucket,
          records: { ...bucket.records, [id]: tombstoneRecord },
          updatedAt: now,
        };
        const nextIndex = updateIndexEntry(index, bucketKey, nextBucket, now);
        await this.store.commit(
          {
            [getHighlightIndexStorageKey(scope)]: nextIndex,
            [bucketKey]: nextBucket,
            ...(device.needsWrite ? { [HIGHLIGHT_DEVICE_ID_KEY]: device.id } : {}),
          },
          [],
          // Deletion must remain possible at the cap. The compact tombstone is
          // bounded and normally shrinks the bucket, but may add a few bytes to
          // an unusually tiny record.
          { allowOverCapGrowth: true },
        );
        return { removed: true, tombstone: true, record: tombstoneRecord };
      }

      const nextRecords = { ...bucket.records };
      delete nextRecords[id];
      const nextBucket: HighlightConversationBucketV1 = {
        ...bucket,
        records: nextRecords,
        updatedAt: now,
      };
      const nextIndex = updateIndexEntry(index, bucketKey, nextBucket, now);
      if (Object.keys(nextRecords).length === 0) {
        await this.store.commit(
          {
            [getHighlightIndexStorageKey(scope)]: nextIndex,
            // An empty write makes a crash between set/remove non-destructive.
            [bucketKey]: nextBucket,
          },
          [bucketKey],
        );
      } else {
        await this.store.commit({
          [getHighlightIndexStorageKey(scope)]: nextIndex,
          [bucketKey]: nextBucket,
        });
      }
      return { removed: true, tombstone: false };
    });
  }

  async clearAll(
    scopeInput: HighlightScope,
    options: { tombstone?: boolean } = {},
  ): Promise<HighlightClearResult> {
    return this.serialize(async () => {
      // A bounded account/platform clear marker is always kept. The option is
      // accepted for API symmetry with remove(), but clear never retains every
      // quote as an unbounded collection of tombstones.
      void options;
      const scope = storedScope(scopeInput);
      const index = await this.store.readIndex(scope);
      const buckets = await this.store.readBucketsFromIndex(scope, index);
      const device = await this.store.getDeviceId();
      const records = Array.from(buckets.values()).flatMap(({ bucket }) =>
        Object.values(bucket.records),
      );
      const now = this.store.now;
      const clearMarker: HighlightClearMarkerV1 = {
        clearedAt: now,
        revision: {
          counter:
            Math.max(
              index.clearMarkers?.[scope.platform]?.revision.counter ?? 0,
              ...records.map((record) => record.revision.counter),
            ) + 1,
          deviceId: device.id,
        },
        generation: {
          counter: (index.clearMarkers?.[scope.platform]?.generation?.counter ?? 0) + 1,
          id: this.store.generateUuid(),
        },
      };
      const conversations = Object.fromEntries(
        Object.entries(index.conversations).filter(
          ([, entry]) => entry.platform !== scope.platform,
        ),
      );
      const nextIndex: HighlightIndexV1 = {
        ...index,
        conversations,
        clearMarkers: {
          ...index.clearMarkers,
          [scope.platform]: clearMarker,
        },
        updatedAt: now,
      };
      await this.store.commit(
        {
          [getHighlightIndexStorageKey(scope)]: nextIndex,
          ...(device.needsWrite ? { [HIGHLIGHT_DEVICE_ID_KEY]: device.id } : {}),
        },
        Array.from(buckets.values()).map(({ key }) => key),
      );
      return {
        removed: records.filter((record) => record.deletedAt === undefined).length,
        clearMarker,
      };
    });
  }

  async clearAllAccounts(): Promise<HighlightClearAllAccountsResult> {
    return this.serialize(() => this.store.clearAllAccounts());
  }

  async importMerge(
    scopeInput: HighlightScope,
    importedRecords: readonly HighlightRecordV1[],
    options: HighlightImportMergeOptions = {},
  ): Promise<HighlightImportStats> {
    return this.serialize(async () => {
      const scope = storedScope(scopeInput);
      for (const record of importedRecords) {
        validateRecord(record);
        if (record.accountHash !== scope.accountHash || record.platform !== scope.platform) {
          throw new HighlightAnnotationError(
            'ACCOUNT_MISMATCH',
            'Imported highlight belongs to a different account or platform',
            {
              id: record.id,
              expectedAccountHash: scope.accountHash,
              actualAccountHash: record.accountHash,
              expectedPlatform: scope.platform,
              actualPlatform: record.platform,
            },
          );
        }
      }
      if (options.clearMarker !== undefined && !isHighlightClearMarkerV1(options.clearMarker)) {
        throw new HighlightAnnotationError('VALIDATION_FAILED', 'Imported clear marker is invalid');
      }

      const index = await this.store.readIndex(scope);
      const localMarker = index.clearMarkers?.[scope.platform];
      const importedMarker = options.clearMarker;
      const effectiveMarker =
        localMarker && importedMarker
          ? compareClearMarkers(localMarker, importedMarker) >= 0
            ? localMarker
            : importedMarker
          : (localMarker ?? importedMarker);

      const indexedBuckets = await this.store.readBucketsFromIndex(scope, index);
      const buckets = new Map<string, { key: string; bucket: HighlightConversationBucketV1 }>();
      for (const { key, bucket } of indexedBuckets.values()) {
        buckets.set(bucket.conversationId, { key, bucket });
      }

      const missingConversationIds = Array.from(
        new Set(importedRecords.map((record) => record.conversationId)),
      ).filter((conversationId) => !buckets.has(conversationId));
      const missingKeys = missingConversationIds.map((conversationId) =>
        getHighlightBucketStorageKey(scope, conversationId),
      );
      const missingRaw = missingKeys.length > 0 ? await this.store.storage.get(missingKeys) : {};
      missingConversationIds.forEach((conversationId, indexPosition) => {
        const key = missingKeys[indexPosition];
        buckets.set(conversationId, {
          key,
          bucket: parseBucket(missingRaw[key], scope, conversationId, this.store.now),
        });
      });

      // Compact anything covered by the winning bounded clear marker before
      // processing imported records. This prevents cleared data from being
      // resurrected and prevents per-record deletion history from growing.
      if (effectiveMarker) {
        for (const [conversationId, state] of buckets) {
          const records = Object.fromEntries(
            Object.entries(state.bucket.records).filter(
              ([, record]) => !isClearedByMarker(record, effectiveMarker),
            ),
          );
          buckets.set(conversationId, {
            ...state,
            bucket: { ...state.bucket, records },
          });
        }
      }

      let imported = 0;
      let updated = 0;
      let duplicates = 0;
      let skippedByClearMarker = 0;

      for (const incoming of importedRecords) {
        if (isClearedByMarker(incoming, effectiveMarker)) {
          skippedByClearMarker += 1;
          continue;
        }
        const state = buckets.get(incoming.conversationId);
        if (!state) {
          throw new HighlightAnnotationError('CORRUPT_DATA', 'Import bucket was not prepared', {
            conversationId: incoming.conversationId,
          });
        }
        const records = { ...state.bucket.records };
        const existingById = records[incoming.id];
        if (existingById) {
          if (compareHighlightRecords(incoming, existingById) > 0) {
            records[incoming.id] = incoming;
            updated += 1;
          } else {
            duplicates += 1;
            continue;
          }
        } else {
          const incomingIdentity = anchorIdentity(incoming);
          const existingAnchor = Object.values(records).find(
            (record) =>
              record.deletedAt === undefined &&
              incoming.deletedAt === undefined &&
              anchorIdentity(record) === incomingIdentity,
          );
          if (existingAnchor) {
            if (compareHighlightRecords(incoming, existingAnchor) > 0) {
              delete records[existingAnchor.id];
              records[incoming.id] = incoming;
              updated += 1;
            } else {
              duplicates += 1;
              continue;
            }
          } else {
            records[incoming.id] = incoming;
            imported += 1;
          }
        }
        buckets.set(incoming.conversationId, {
          ...state,
          bucket: { ...state.bucket, records, updatedAt: this.store.now },
        });
      }

      const now = this.store.now;
      let nextIndex: HighlightIndexV1 = {
        ...index,
        conversations: Object.fromEntries(
          Object.entries(index.conversations).filter(
            ([, entry]) => entry.platform !== scope.platform,
          ),
        ),
        clearMarkers: effectiveMarker
          ? { ...index.clearMarkers, [scope.platform]: effectiveMarker }
          : index.clearMarkers,
        updatedAt: now,
      };
      const setItems: Record<string, unknown> = {};
      const removeKeys: string[] = [];
      for (const state of buckets.values()) {
        const bucket = { ...state.bucket, updatedAt: now };
        nextIndex = updateIndexEntry(nextIndex, state.key, bucket, now);
        if (Object.keys(bucket.records).length === 0) removeKeys.push(state.key);
        else setItems[state.key] = bucket;
      }
      setItems[getHighlightIndexStorageKey(scope)] = nextIndex;
      await this.store.commit(setItems, removeKeys);

      const total = Array.from(buckets.values()).reduce(
        (sum, { bucket }) =>
          sum +
          Object.values(bucket.records).filter((record) => record.deletedAt === undefined).length,
        0,
      );
      return { imported, updated, duplicates, skippedByClearMarker, total };
    });
  }
}

export const highlightAnnotationService = new HighlightAnnotationService({
  budget: storageBudget,
});
