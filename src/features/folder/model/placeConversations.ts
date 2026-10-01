import type { ConversationReference, FolderData } from '@/core/types/folder';

import { normalizeFolderData } from './folderData';

/** How placed records are ordered in the target bucket. */
export type ConversationPlacement =
  /** After the bucket's highest `sortIndex`, in incoming order. */
  | 'append'
  /** First, shifting the bucket down; Gemini data is normalized first so every index is numeric. */
  | 'top'
  /** As the records carry it: a moved record keeps its index, and AI Studio records have none. */
  | 'keep';

export interface PlaceConversationsOptions {
  /** The bucket that receives the records: a folder id or the platform's root bucket. */
  target: string;
  placement: ConversationPlacement;
  /** Buckets the placed conversations leave: one source bucket, or every bucket but the target. */
  removeFrom?: { bucket: string } | 'everywhere';
  /** Whether a conversation the target already holds still leaves `removeFrom`. */
  removeWhenPresent?: boolean;
}

export interface ConversationPlacementResult {
  data: FolderData;
  /** Copies of the records that entered the target, as stored. */
  added: ConversationReference[];
}

/**
 * Place built conversation records into one bucket. Pure: the input is never
 * mutated and every stored record is a fresh object, so no record is shared
 * between buckets. Identity is the exact `conversationId`; a record the target
 * already holds is kept as stored. Callers build records and own side effects.
 */
export function placeConversations(
  data: FolderData,
  records: readonly ConversationReference[],
  options: PlaceConversationsOptions,
): ConversationPlacementResult {
  const { target, placement, removeFrom, removeWhenPresent = false } = options;
  const held = new Set((data.folderContents[target] ?? []).map((c) => c.conversationId));
  const added: ConversationReference[] = [];
  const leaving = new Set<string>();
  for (const record of records) {
    if (held.has(record.conversationId)) {
      if (removeWhenPresent) leaving.add(record.conversationId);
      continue;
    }
    held.add(record.conversationId);
    leaving.add(record.conversationId);
    added.push({ ...record });
  }

  // A new record claims index 0 and the bucket shifts down. The recency
  // fallback alone is not enough: normalization would give the newest record
  // 0, colliding with an existing 0, and the stable sort would then keep the
  // new record below it. Normalizing first gives every existing record a
  // numeric index, so `?? 0` cannot fold unindexed records onto the old 0.
  const base = placement === 'top' && added.length > 0 ? normalizeFolderData(data) : data;
  const folderContents = { ...base.folderContents };
  const existing = folderContents[target] ?? [];
  if (placement === 'append') {
    let max = existing.reduce((highest, c) => Math.max(highest, c.sortIndex ?? -1), -1);
    for (const record of added) record.sortIndex = ++max;
    folderContents[target] = [...existing, ...added];
  } else if (placement === 'top' && added.length > 0) {
    added.forEach((record, index) => (record.sortIndex = index));
    const shifted = existing.map((c) => ({ ...c, sortIndex: (c.sortIndex ?? 0) + added.length }));
    folderContents[target] = [...shifted, ...added];
  } else {
    folderContents[target] = [...existing, ...added];
  }

  const sources =
    removeFrom === 'everywhere'
      ? Object.keys(folderContents)
      : removeFrom && Object.hasOwn(folderContents, removeFrom.bucket)
        ? [removeFrom.bucket]
        : [];
  for (const source of sources) {
    if (source === target) continue;
    folderContents[source] = folderContents[source].filter((c) => !leaving.has(c.conversationId));
  }

  return { data: { ...base, folderContents }, added };
}
