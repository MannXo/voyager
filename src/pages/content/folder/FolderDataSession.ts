import { type AccountScope, buildScopedStorageKey } from '@/core/services/AccountIsolationService';
import { DataBackupService } from '@/core/services/DataBackupService';

import type { FolderData } from './types';

/** Owns one account's live data, recovery slots, and pending writes. */
export class FolderDataSession {
  data: FolderData = { folders: [], folderContents: {} };
  ready = false;
  loadVersion = 0;
  loadsInFlight = 0;
  saveInProgress = false;
  activeSave: Promise<boolean> | null = null;
  replacingData = false;
  pendingSave: FolderData | null = null;
  /** Another context wrote this bucket; reload once this session is active and idle. */
  reconcilePending = false;
  /** Counts observed external writes, so a load knows whether one arrived during its read. */
  externalWrites = 0;
  /** Numbers each write attempt in start order; writes of one session run one at a time. */
  writeGen = 0;
  /**
   * The generation of a failed write that carried a local edit, while memory still holds that
   * edit: it is newer than every backup. Null once a later write or applied load supersedes it.
   */
  failedEditGen: number | null = null;
  /** `externalWrites` when a reload was last requested for this session. */
  reconcileAttemptedAt = 0;
  /** What this context last read from or wrote to storage: the base for merging debounced edits. */
  baseline: FolderData | null = null;
  pendingSaveCompletion: {
    promise: Promise<boolean>;
    resolve: (saved: boolean) => void;
  } | null = null;
  readonly backup: DataBackupService<FolderData>;
  private active = true;

  constructor(
    readonly storageKey: string,
    namespace: string,
    public accountScope: AccountScope | null,
    validateData: (data: unknown) => boolean,
  ) {
    // Global recovery slots have no account owner. Keep them compatible only
    // when isolation is off; never migrate or remove them during account setup.
    this.backup = new DataBackupService<FolderData>(
      accountScope ? buildScopedStorageKey(namespace, accountScope.accountKey) : namespace,
      validateData,
    );
  }

  /** An operation that started at write generation `gen` succeeded; it supersedes older failures only. */
  settleFailedEdit(gen: number): void {
    if (this.failedEditGen !== null && this.failedEditGen <= gen) this.failedEditGen = null;
  }

  markReady(): void {
    this.ready = true;
    if (this.active) this.backup.setupBeforeUnloadBackup(() => this.data);
  }

  activate(): void {
    this.active = true;
    if (this.ready) this.markReady();
  }

  deactivate(): void {
    this.active = false;
    // Invalidates reads already in flight without discarding pending writes.
    this.loadVersion += 1;
    this.backup.destroy();
  }
}
