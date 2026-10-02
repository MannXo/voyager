/**
 * The owner's backup slots of one K (DESIGN-v2 §6.6). Optional copies (`last`,
 * `prior`) never block or fail an edit; `preBulk` is required before a bulk op.
 * Every copy asks `admitCopy` first: the hook where the background
 * StorageBudget (addendum P3P4 R6.1) plugs in once its review is resolved.
 */
import type { FolderData } from '@/core/types/folder';

import {
  type BackupSlot,
  type FolderOwnerMeta,
  type FolderOwnerStorageArea,
  type ReadyState,
  ownerBackupKey,
  parseStoredData,
} from './folderOwnerState';

export const ROTATE_LAST_MS = 10 * 60 * 1000;
export const ROTATE_PRIOR_MS = 24 * 60 * 60 * 1000;
/** A commit that drops this many conversation references takes a `preBulk` first. */
export const PRE_BULK_REFERENCE_DROP = 20;

export interface BackupEntry {
  savedAt: number;
  rev: number;
  reason: 'rotation' | 'preBulk' | 'foreign';
  sourceHash: string;
  value: unknown;
}

/** Whether a copy of `bytes` may be written to `slot`; the StorageBudget's `copy` admission. */
export type AdmitCopy = (key: string, slot: BackupSlot, bytes: number) => Promise<boolean>;

export const admitEveryCopy: AdmitCopy = () => Promise.resolve(true);

async function writeSlot(
  area: FolderOwnerStorageArea,
  admitCopy: AdmitCopy,
  key: string,
  slot: BackupSlot,
  entry: BackupEntry,
): Promise<boolean> {
  try {
    if (!(await admitCopy(key, slot, JSON.stringify(entry).length))) return false;
    await area.set({ [ownerBackupKey(key, slot)]: entry });
    return true;
  } catch {
    return false;
  }
}

/** The slot's data; `null` when it is absent or not folder data, `undefined` when unreadable. */
export async function readSlot(
  area: FolderOwnerStorageArea,
  key: string,
  slot: BackupSlot,
): Promise<FolderData | null | undefined> {
  const slotKey = ownerBackupKey(key, slot);
  let stored: Record<string, unknown>;
  try {
    stored = await area.get([slotKey]);
  } catch {
    return undefined;
  }
  const entry = stored[slotKey] as Partial<BackupEntry> | undefined;
  return entry && typeof entry === 'object' ? parseStoredData(entry.value) : null;
}

const entryOf = (state: ReadyState, reason: BackupEntry['reason'], now: number): BackupEntry => ({
  savedAt: now,
  rev: state.meta.rev,
  reason,
  sourceHash: state.hash,
  value: state.data,
});

/** Writes `preBulk` = the state before the bulk op; `false` refuses the op (`backup_failed`). */
export function writePreBulk(
  area: FolderOwnerStorageArea,
  admitCopy: AdmitCopy,
  key: string,
  state: ReadyState,
  now: number,
): Promise<boolean> {
  return writeSlot(area, admitCopy, key, 'preBulk', entryOf(state, 'preBulk', now));
}

/**
 * Time-based rotation before a data commit: `last` at most every 10 min and
 * `prior` (the old `last`) at most daily. The deadlines live in meta, so a
 * worker restart neither forces nor skips a rotation. Returns the meta to commit.
 */
export async function rotateBackups(
  area: FolderOwnerStorageArea,
  admitCopy: AdmitCopy,
  key: string,
  state: ReadyState,
  meta: FolderOwnerMeta,
  now: number,
): Promise<FolderOwnerMeta> {
  const backups = { ...meta.backups };
  if (!state.data || now < (backups.lastAt ?? -Infinity) + ROTATE_LAST_MS) return meta;
  if (now >= (backups.priorAt ?? -Infinity) + ROTATE_PRIOR_MS) {
    const lastKey = ownerBackupKey(key, 'last');
    const old = await area.get([lastKey]).catch(() => ({}) as Record<string, unknown>);
    const last = (old as Record<string, unknown>)[lastKey] as BackupEntry | undefined;
    if (last && (await writeSlot(area, admitCopy, key, 'prior', last))) backups.priorAt = now;
  }
  if (await writeSlot(area, admitCopy, key, 'last', entryOf(state, 'rotation', now))) {
    backups.lastAt = now;
  }
  return { ...meta, backups };
}

/**
 * Keeps a copy of a value a foreign writer put in K (§6.4, T1c). The event's
 * value is captured before the owner's next commit can overwrite it; an owner
 * commit, recognised by its hash, is never copied.
 */
export async function keepForeignCopy(
  area: FolderOwnerStorageArea,
  key: string,
  value: unknown,
  sourceHash: string,
  now: number,
): Promise<void> {
  const entry: BackupEntry = { savedAt: now, rev: -1, reason: 'foreign', sourceHash, value };
  try {
    await area.set({ [ownerBackupKey(key, 'foreign')]: entry });
  } catch {
    // Best effort: the next resolution still adopts or quarantines what K holds.
  }
}

const referenceCount = (data: FolderData): number =>
  Object.values(data.folderContents).reduce((sum, bucket) => sum + bucket.length, 0);

/** Whether `next` removes a folder that holds conversations, or 20 or more references (§6.6). */
export function dropsEnoughForPreBulk(prev: FolderData | null, next: FolderData | null): boolean {
  if (!prev || !next) return false;
  const kept = new Set(next.folders.map((folder) => folder.id));
  const removedFull = prev.folders.some(
    (folder) => !kept.has(folder.id) && (prev.folderContents[folder.id]?.length ?? 0) > 0,
  );
  return removedFull || referenceCount(prev) - referenceCount(next) >= PRE_BULK_REFERENCE_DROP;
}
