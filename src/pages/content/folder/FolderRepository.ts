import browser, { type Storage } from 'webextension-polyfill';

import {
  type AccountContext,
  type AccountScope,
  accountIsolationService,
  buildScopedStorageKey,
  detectAccountContextFromDocument,
} from '@/core/services/AccountIsolationService';
import { cloneFolderData, validateFolderData } from '@/features/folder/model/folderData';

import { FolderDataSession } from './FolderDataSession';
import { GEMINI_FOLDER_CONFIG, type PlatformFolderConfig } from './platformFolderConfig';
import type { IFolderStorageAdapter } from './storage/FolderStorageAdapter';
import type { FolderData } from './types';

/** Growing gaps between account-scope retries, in ms. Length caps the attempts. */
const ACCOUNT_SCOPE_RETRY_DELAYS = [400, 1200, 3000] as const;
const IS_DEBUG = false;
const SAVE_DEBOUNCE_MS = 300;
const STORAGE_ECHO_SUPPRESS_WINDOW_MS = 2000;

export type FolderStoreChange =
  | 'account'
  | 'data'
  | 'title'
  | 'activity'
  | 'loaded'
  | 'saved'
  | 'availability';

export interface FolderRepositoryHooks {
  onChange: (reason: FolderStoreChange) => void;
  /** A failed load restored backup data, kept in-memory data, or reset to empty. */
  onRecovery: (result: 'recovered' | 'kept' | 'lost') => void;
  /** Another context wrote the active bucket. Resolved at call time by the owner. */
  onExternalChange: () => void;
  /** The active account was released; runs before the `account` change. */
  onAccountReleased: () => void;
  /** Whether the folder feature is enabled, which gates the isolation-switch repaint. */
  isEnabled: () => boolean;
  /** The final write of a save chain failed while its session is current. */
  onSaveFailed?: () => void;
  /** A write settled, either way, for the current session outside a draft replacement. */
  onPersistSettled?: () => void;
  /** A session was bound for `context`, which is `null` while isolation is off. */
  onAccountBound?: (context: AccountContext | null) => void;
}

function isDebugEnabled(flag: string): boolean {
  try {
    // Enable by setting localStorage.<debugFlag> = '1'
    return IS_DEBUG || localStorage.getItem(flag) === '1';
  } catch {
    // Ignore - localStorage may not be available in some contexts (e.g. incognito mode)
    return IS_DEBUG;
  }
}

function createDebugLog(config: PlatformFolderConfig, write: 'log' | 'warn') {
  return (...args: unknown[]): void => {
    if (isDebugEnabled(config.debugFlag)) {
      console[write](config.logPrefix, ...args);
    }
  };
}

export const folderDebug = createDebugLog(GEMINI_FOLDER_CONFIG, 'log');
export const folderDebugWarn = createDebugLog(GEMINI_FOLDER_CONFIG, 'warn');

/**
 * Owns one platform's folder persistence: account sessions, load, recovery,
 * serialized saves, draft replacement, storage echoes and account-scope retry.
 */
export class FolderRepository {
  private readonly storageInitializations = new Map<string, Promise<void>>();
  private dataSession: FolderDataSession | null;
  private readonly dataSessions = new Map<string, FolderDataSession>();
  private unresolvedData: FolderData = { folders: [], folderContents: {} };
  private accountScopeRequest = 0;
  private accountScopeRetry: number | null = null;
  private accountScopeRetryAttempt = 0;
  private accountScopeRetrying = false;
  private isolationEnabled = false;
  private resolvedAccountScope: AccountScope | null = null;
  private activeStorageKey: string;
  private destroyed = false;
  private pendingStorageEchoes = 0;
  private lastStorageEchoArmedAt = 0;
  private saveDebounceTimer: number | null = null;
  private beforeUnloadFlushHandler: (() => void) | null = null;
  private readonly tag: string;
  private readonly debug: (...args: unknown[]) => void;
  private readonly debugWarn: (...args: unknown[]) => void;
  private readonly storageChangeHandler = (
    changes: Record<string, Storage.StorageChange>,
    area: string,
  ): void => {
    if (this.destroyed) return;
    if (area === 'local' && changes[this.activeStorageKey]) {
      if (!this.consumeStorageEchoSuppression()) this.hooks.onExternalChange();
    }
    if (area === 'sync' && this.config.isolationSettingKeys.some((key) => changes[key])) {
      void accountIsolationService
        .isIsolationEnabled({
          platform: this.config.platform,
          pageUrl: window.location.href,
        })
        .then((enabled) => this.setAccountIsolationEnabled(enabled));
    }
  };

  constructor(
    private readonly config: PlatformFolderConfig,
    private readonly storage: IFolderStorageAdapter,
    private readonly hooks: FolderRepositoryHooks,
  ) {
    this.dataSession = new FolderDataSession(
      config.storageKey,
      config.backupNamespace,
      null,
      validateFolderData,
    );
    this.activeStorageKey = config.storageKey;
    this.tag = config.logPrefix;
    this.debug = createDebugLog(config, 'log');
    this.debugWarn = createDebugLog(config, 'warn');
  }

  get data(): FolderData {
    return this.dataSession?.data ?? this.unresolvedData;
  }
  set data(value: FolderData) {
    if (this.dataSession) this.dataSession.data = value;
    else this.unresolvedData = value;
  }
  get session(): FolderDataSession | null {
    return this.dataSession;
  }
  get canEdit(): boolean {
    return !this.destroyed && this.dataSession?.ready === true && !this.dataSession.replacingData;
  }
  get activation(): number {
    return this.accountScopeRequest;
  }
  get storageKey(): string {
    return this.activeStorageKey;
  }
  get accountScope(): AccountScope | null {
    return this.resolvedAccountScope;
  }
  get accountIsolationEnabled(): boolean {
    return this.isolationEnabled;
  }
  get isDestroyed(): boolean {
    return this.destroyed;
  }

  async init(): Promise<void> {
    await this.initializeStorage(this.config.storageKey);
    if (this.destroyed) return;
    this.beforeUnloadFlushHandler = () => this.flushPendingSaveData();
    window.addEventListener('beforeunload', this.beforeUnloadFlushHandler);
    await this.loadAccountIsolationSetting();
    if (this.destroyed) return;
    await this.refreshAccountScope();
    await this.loadData();
    this.watchStorage();
  }

  /** Reload on writes to the active bucket from other contexts. */
  watchStorage(): void {
    if (!this.destroyed) browser.storage.onChanged.addListener(this.storageChangeHandler);
  }

  /**
   * Release the active session without destroying the repository: edits stop,
   * in-flight scope work goes stale, and a later `refreshAccountScope` resumes.
   */
  suspend(): void {
    this.clearAccountScopeRetry();
    this.dataSession?.deactivate();
    this.accountScopeRequest += 1;
  }

  destroy(): void {
    // The flush must precede `destroyed`, which gates `saveData`; the retry
    // timer is cancelled straight after so a pending resolution cannot rearm.
    this.flushPendingSaveData();
    this.destroyed = true;
    this.clearAccountScopeRetry();
    this.dataSession?.deactivate();
    this.accountScopeRequest += 1;
    browser.storage.onChanged.removeListener(this.storageChangeHandler);
    if (this.beforeUnloadFlushHandler)
      window.removeEventListener('beforeunload', this.beforeUnloadFlushHandler);
    this.beforeUnloadFlushHandler = null;
  }

  /** Record the isolation switch without rebinding; the caller refreshes the scope. */
  setAccountIsolationFlag(enabled: boolean): void {
    this.isolationEnabled = enabled;
  }

  async setAccountIsolationEnabled(enabled: boolean): Promise<void> {
    if (this.destroyed || enabled === this.isolationEnabled) return;
    this.isolationEnabled = enabled;
    await this.refreshAccountScope();
    await this.loadData();
    if (this.hooks.isEnabled()) this.hooks.onChange('data');
  }

  private initializeStorage(key: string): Promise<void> {
    const existing = this.storageInitializations.get(key);
    if (existing) return existing;
    // init() performs a best-effort migration that can write to storage. Run it
    // once per key so revisiting an account cannot race that account's save queue.
    const initialization = this.storage.init(key).catch((error) => {
      this.storageInitializations.delete(key);
      throw error;
    });
    this.storageInitializations.set(key, initialization);
    return initialization;
  }

  async loadData(): Promise<void> {
    const session = this.dataSession;
    if (!session) return;
    // A returning account may still own a queued edit that is newer than disk.
    if ((session.saveInProgress || session.replacingData) && session.ready) return;
    const version = ++session.loadVersion;
    const isCurrent = () =>
      this.dataSession === session && session.loadVersion === version && !this.destroyed;
    try {
      // On Safari, restore recovery backups from the durable mirror before any
      // recoverFromBackup() can run (localStorage may have been ITP-evicted).
      await session.backup.ensureHydrated();
      if (!isCurrent()) return;

      let loadedData = await this.storage.loadData(session.storageKey);
      if (!isCurrent()) return;

      if (!loadedData && session.accountScope) {
        loadedData = await this.migrateLegacyFolderDataToScopedStorage(session, version);
        if (!isCurrent()) return;
      }

      if (loadedData && validateFolderData(loadedData)) {
        // Validate and repair data integrity
        this.data = this.config.normalize(loadedData);

        // Clean up orphaned folderContents (folders that no longer exist)
        if (this.config.pruneOrphanBuckets) {
          const validFolderIds = new Set(this.data.folders.map((f) => f.id));
          validFolderIds.add(this.config.rootBucketId); // Keep root conversations
          Object.keys(this.data.folderContents).forEach((folderId) => {
            if (!validFolderIds.has(folderId)) {
              this.debugWarn(`Removing orphaned folderContents for: ${folderId}`);
              delete this.data.folderContents[folderId];
            }
          });
        }

        // Create primary backup on successful load
        session.backup.createPrimaryBackup(this.data);
        session.markReady();

        this.debug('Data loaded and validated successfully');
      } else if (loadedData) {
        // Data exists but validation failed - this is a real corruption case
        console.warn(
          `${this.tag} Storage returned invalid data structure, attempting recovery from backup`,
        );
        await this.attemptDataRecovery({ reason: 'corrupted', originalData: loadedData }, session);
      } else if (this.config.recoverMissingData) {
        console.warn(`${this.tag} Storage returned no data, attempting recovery from backup`);
        await this.attemptDataRecovery(null, session);
      } else {
        // No data found - likely a first-time user
        console.log(
          `${this.tag} No folder data found, initializing empty state (likely first-time user)`,
        );
        this.data = { folders: [], folderContents: {} };
        session.markReady();
        // No notification needed - this is expected for new users
      }
    } catch (error) {
      if (!isCurrent()) return;
      console.error(`${this.tag} Load data error:`, error);

      // CRITICAL: Do NOT clear data on error - this causes data loss!
      // Instead, try to recover from backup or keep existing data
      await this.attemptDataRecovery(error, session);
    } finally {
      if (isCurrent() && session.ready) {
        this.hooks.onChange('loaded');
      }
    }
  }

  private async migrateLegacyFolderDataToScopedStorage(
    session: FolderDataSession,
    version: number,
  ): Promise<FolderData | null> {
    try {
      const legacyData = await this.storage.loadData(this.config.storageKey);
      if (
        this.dataSession !== session ||
        session.loadVersion !== version ||
        !legacyData ||
        !validateFolderData(legacyData)
      ) {
        return null;
      }

      const migratedData = this.config.normalize(
        this.config.migrateLegacyData(legacyData, session.accountScope),
      );
      session.data = migratedData;
      session.markReady();
      session.activeSave = this.persistDataSession(session, cloneFolderData(session.data));
      const saved = await session.activeSave;
      if (!saved) {
        console.warn(`${this.tag} Failed to persist scoped migration data`);
      }
      this.debug(
        'Migrated legacy folder data to scoped storage:',
        session.storageKey,
        migratedData.folders.length,
      );
      return migratedData;
    } catch (error) {
      console.error(`${this.tag} Failed to migrate legacy folder data:`, error);
      return null;
    }
  }

  private async attemptDataRecovery(error: unknown, session: FolderDataSession): Promise<void> {
    if (this.dataSession !== session) return;
    console.warn(`${this.tag} Attempting data recovery after load failure`);

    // Step 1: Try to restore from localStorage backups (primary, emergency, beforeUnload)
    const recovered = session.backup.recoverFromBackup();
    if (recovered && validateFolderData(recovered)) {
      this.data = this.config.normalize(recovered);
      session.markReady();
      console.warn(`${this.tag} Data recovered from localStorage backup`);
      this.hooks.onRecovery('recovered');
      // Save recovered data to persistent storage
      await this.saveData();
      return; // Successfully recovered, no need to continue
    }

    // Step 2: If current this.data already has valid structure, keep it
    if (validateFolderData(this.data) && this.data.folders.length > 0) {
      console.warn(`${this.tag} Keeping existing in-memory data after load error`);
      this.data = this.config.normalize(this.data);
      session.markReady();
      this.hooks.onRecovery('kept');
      return;
    }

    // Step 3: Last resort - initialize empty data and log critical error
    console.error(`${this.tag} CRITICAL: Unable to recover data, initializing empty state`);
    console.error(`${this.tag} Original error:`, error);
    this.data = { folders: [], folderContents: {} };
    session.markReady();

    // Show user notification about data loss
    this.hooks.onRecovery('lost');
  }

  scheduleSaveData(): void {
    if (!this.canEdit) return;
    if (this.saveDebounceTimer !== null) {
      window.clearTimeout(this.saveDebounceTimer);
    }
    this.saveDebounceTimer = window.setTimeout(() => {
      this.saveDebounceTimer = null;
      void this.saveData();
    }, SAVE_DEBOUNCE_MS);
  }

  flushPendingSaveData(): void {
    if (this.saveDebounceTimer === null) return;
    window.clearTimeout(this.saveDebounceTimer);
    this.saveDebounceTimer = null;
    void this.saveData();
  }

  private armStorageEchoSuppression(): void {
    this.pendingStorageEchoes += 1;
    this.lastStorageEchoArmedAt = Date.now();
  }

  private consumeStorageEchoSuppression(): boolean {
    if (this.pendingStorageEchoes <= 0) return false;
    if (Date.now() - this.lastStorageEchoArmedAt > STORAGE_ECHO_SUPPRESS_WINDOW_MS) {
      this.pendingStorageEchoes = 0;
      return false;
    }
    this.pendingStorageEchoes -= 1;
    return true;
  }

  /**
   * Persist a draft without exposing it to edits, exports or recovery before success.
   * `companions` are other storage keys written in the same atomic storage call.
   */
  async replaceData(data: FolderData, companions?: Record<string, unknown>): Promise<boolean> {
    const session = this.dataSession;
    const activation = this.accountScopeRequest;
    if (!session || !this.canEdit) return false;
    const snapshot = this.config.normalize(cloneFolderData(data));

    this.flushPendingSaveData();
    session.replacingData = true;
    session.loadVersion += 1;
    this.hooks.onChange('availability');
    let saved = false;
    try {
      // Finish accepted edits first. A draft must not replace their coalesced tail.
      const pending = session.pendingSaveCompletion?.promise ?? session.activeSave;
      if (pending) await pending;
      if (this.destroyed || this.dataSession !== session || this.accountScopeRequest !== activation)
        return false;

      session.activeSave = this.persistDataSession(session, snapshot, companions);
      saved = await session.activeSave;
      // An issued write still belongs to this session if the user has since left it.
      if (saved) session.data = snapshot;
      return saved;
    } finally {
      session.replacingData = false;
      if (this.dataSession === session && !this.destroyed) {
        this.hooks.onChange(saved ? 'data' : 'availability');
      } else if (!session.saveInProgress) {
        this.dataSessions.delete(session.storageKey);
      }
    }
  }

  async saveData(): Promise<boolean> {
    const session = this.dataSession;
    if (!session || !this.canEdit) return false;
    try {
      this.data = this.config.normalize(this.data);
      const snapshot = cloneFolderData(session.data);
      // A mutation supersedes any storage read already in flight for this session.
      session.loadVersion += 1;
      session.markReady();
      session.backup.createEmergencyBackup(snapshot);
      if (session.saveInProgress) {
        session.pendingSave = snapshot;
        // Calls coalesced into this trailing snapshot share its storage result.
        if (!session.pendingSaveCompletion) {
          let resolve!: (saved: boolean) => void;
          const promise = new Promise<boolean>((complete) => {
            resolve = complete;
          });
          session.pendingSaveCompletion = { promise, resolve };
        }
        this.debug('Save already in progress, queueing one trailing save');
        return session.pendingSaveCompletion.promise;
      }

      session.activeSave = this.persistDataSession(session, snapshot);
      return session.activeSave;
    } catch (error) {
      console.error(`${this.tag} Save data error:`, error);
      this.hooks.onSaveFailed?.();
      return false;
    }
  }

  private writeSnapshot(
    key: string,
    snapshot: FolderData,
    companions: Record<string, unknown> | undefined,
  ): Promise<boolean> {
    return companions
      ? this.storage.saveData(key, snapshot, companions)
      : this.storage.saveData(key, snapshot);
  }

  private async persistDataSession(
    session: FolderDataSession,
    snapshot: FolderData,
    companions?: Record<string, unknown>,
  ): Promise<boolean> {
    this.dataSessions.set(session.storageKey, session);
    session.saveInProgress = true;
    let success = false;

    try {
      // Additional safety check: warn if saving empty data
      if (
        this.config.checkEmptyOverwrite &&
        snapshot.folders.length === 0 &&
        Object.keys(snapshot.folderContents).length === 0
      ) {
        // Check if we're about to overwrite non-empty data
        const existingData = await this.storage.loadData(session.storageKey);
        if (
          existingData &&
          (existingData.folders.length > 0 || Object.keys(existingData.folderContents).length > 0)
        ) {
          console.warn(
            `${this.tag} WARNING: Attempting to save empty data over existing non-empty data`,
          );
          console.warn(`${this.tag} This may indicate a bug.`);
          // Still proceed, but log it prominently
        }
      }

      // Save via storage adapter (handles both Safari and non-Safari).
      // Each write mirrors into chrome.storage.local and echoes back through
      // storage.onChanged in this same context — arm suppression so the echo
      // doesn't trigger a redundant full reload (see storageChangeHandler).
      if (this.dataSession === session) this.armStorageEchoSuppression();
      success = await this.writeSnapshot(session.storageKey, snapshot, companions);

      // Retry once if the first attempt fails (for transient errors)
      if (!success && this.config.retryFailedSave) {
        console.warn(`${this.tag} Save failed, retrying once...`);
        if (this.dataSession === session) this.armStorageEchoSuppression();
        success = await this.writeSnapshot(session.storageKey, snapshot, companions);
      }

      if (success) {
        // Create primary backup AFTER successful save
        session.backup.createPrimaryBackup(snapshot);
        this.debug('Data saved successfully');
        // Centralised floating-panel sync. Any code path that persists folder
        // data (sidebar actions, cloud download, native menu → "Move to
        // folder", etc.) ends up here, so one hook keeps the floating view
        // live without every call site having to remember.
        if (this.dataSession === session && !this.destroyed) {
          this.hooks.onChange('saved');
        }
      } else {
        console.error(`${this.tag} Save failed after retry`);
      }
    } catch (error) {
      console.error(`${this.tag} Save data error:`, error);
      success = false;
    } finally {
      // A newer queued snapshot can still persist this edit; report only a final failure.
      if (!success && this.dataSession === session && !session.pendingSave) {
        this.hooks.onSaveFailed?.();
      }
      session.saveInProgress = false;
      const pending = session.pendingSave;
      const completion = session.pendingSaveCompletion;
      session.pendingSave = null;
      session.pendingSaveCompletion = null;
      if (pending) {
        session.activeSave = this.persistDataSession(session, pending);
        void session.activeSave.then((saved) => completion?.resolve(saved));
      } else {
        session.activeSave = null;
        if (this.dataSession !== session && !session.replacingData) {
          this.dataSessions.delete(session.storageKey);
        }
      }
    }
    if (this.dataSession === session && !session.replacingData) {
      this.hooks.onPersistSettled?.();
    }

    return success;
  }

  private async loadAccountIsolationSetting(): Promise<void> {
    try {
      this.isolationEnabled = await accountIsolationService.isIsolationEnabled({
        platform: this.config.platform,
        pageUrl: window.location.href,
      });
      this.debug('Loaded account isolation setting:', this.isolationEnabled);
    } catch (error) {
      console.error(`${this.tag} Failed to load account isolation setting:`, error);
      this.isolationEnabled = false;
    }
  }

  async refreshAccountScope(): Promise<void> {
    const request = ++this.accountScopeRequest;
    this.clearAccountScopeRetry();
    if (!this.accountScopeRetrying) this.accountScopeRetryAttempt = 0;
    const previous = this.dataSession;
    // Flush the old account's pending debounce before releasing its data owner.
    this.flushPendingSaveData();
    previous?.deactivate();
    if (previous && !previous.saveInProgress && !previous.replacingData) {
      this.dataSessions.delete(previous.storageKey);
    }
    this.dataSession = null;
    this.unresolvedData = { folders: [], folderContents: {} };
    this.resolvedAccountScope = null;
    this.activeStorageKey = '';
    this.pendingStorageEchoes = 0;
    this.hooks.onAccountReleased();
    this.hooks.onChange('account');
    try {
      let resolvedScope: AccountScope | null = null;
      let context: AccountContext | null = null;
      if (this.isolationEnabled) {
        context = detectAccountContextFromDocument(window.location.href, document);
        resolvedScope = await accountIsolationService.resolveAccountScope({
          pageUrl: window.location.href,
          routeUserId: context.routeUserId,
          email: context.email,
        });
      }
      if (request !== this.accountScopeRequest || this.destroyed) return;
      const storageKey = resolvedScope
        ? buildScopedStorageKey(this.config.storageKey, resolvedScope.accountKey)
        : this.config.storageKey;
      await this.initializeStorage(storageKey);
      if (request !== this.accountScopeRequest || this.destroyed) return;
      const session =
        this.dataSessions.get(storageKey) ??
        (previous?.storageKey === storageKey
          ? previous
          : new FolderDataSession(
              storageKey,
              this.config.backupNamespace,
              resolvedScope,
              validateFolderData,
            ));
      this.dataSessions.set(storageKey, session);
      session.accountScope = resolvedScope;
      this.dataSession = session;
      this.resolvedAccountScope = resolvedScope;
      this.activeStorageKey = storageKey;
      this.hooks.onAccountBound?.(context);
      session.activate();
      this.accountScopeRetryAttempt = 0;
      if (session.ready) {
        this.hooks.onChange('title');
        this.hooks.onChange('loaded');
      }
    } catch (error) {
      console.error(`${this.tag} Failed to resolve account scope:`, error);
      // Keep persistence unbound on failure. A global fallback has no known owner.
      this.scheduleAccountScopeRetry(request);
    }
  }

  /**
   * Re-attempt a failed scope resolution a few times, with growing gaps.
   *
   * Firefox is the only target that resolves the scope through the background
   * page (`AccountIsolationService.shouldResolveScopeInBackground`), so a
   * background that is not listening yet — right after an extension update, say
   * — fails the whole round trip. An unbound store is not inert: the panel
   * renders empty and `saveData` drops every edit while still repainting it, so
   * a folder the user creates looks saved and is gone on reload. Binding to the
   * global bucket instead is not an option, because an ownerless bucket can
   * belong to another account (see `.github/docs/regressions/state-identity-sync.md`).
   */
  private scheduleAccountScopeRetry(request: number): void {
    if (this.destroyed || request !== this.accountScopeRequest) return;
    const delay = ACCOUNT_SCOPE_RETRY_DELAYS[this.accountScopeRetryAttempt];
    if (delay === undefined) return;
    this.accountScopeRetryAttempt += 1;
    this.accountScopeRetry = window.setTimeout(() => {
      this.accountScopeRetry = null;
      if (this.destroyed || request !== this.accountScopeRequest) return;
      void this.retryAccountScope();
    }, delay);
  }

  private async retryAccountScope(): Promise<void> {
    this.accountScopeRetrying = true;
    try {
      await this.refreshAccountScope();
    } finally {
      this.accountScopeRetrying = false;
    }
    if (this.destroyed || !this.dataSession) return;
    await this.loadData();
    if (this.destroyed) return;
    this.hooks.onChange('title');
    this.hooks.onChange('data');
  }

  private clearAccountScopeRetry(): void {
    if (this.accountScopeRetry === null) return;
    window.clearTimeout(this.accountScopeRetry);
    this.accountScopeRetry = null;
  }
}
