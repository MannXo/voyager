/**
 * DataBackupService - Robust multi-layer backup system for preventing data loss
 *
 * This service provides a reliable backup mechanism using localStorage with an extension-storage fallback.
 * It implements multiple backup layers with timestamp validation to prevent data loss in scenarios
 * like network disconnections, page refreshes, and browser crashes.
 *
 * Backup Strategy:
 * 1. Primary Backup - Updated on every successful save
 * 2. Emergency Backup - Snapshot before each save operation
 * 3. BeforeUnload Backup - Created when user leaves the page
 *
 * Recovery Priority:
 * 1. Primary backup (most recent)
 * 2. Emergency backup (pre-save snapshot)
 * 3. BeforeUnload backup (page exit snapshot)
 * 4. In-memory data (current session)
 */
import browser from 'webextension-polyfill';

import { isSafari } from '@/core/utils/browser';
import { requestBudgetCopy } from '@/features/storage/budgetCopyMessage';

/** Recovery waits this long for backup writes in flight, then reads what landed. */
const PENDING_WRITE_WAIT_MS = 2000;

interface QueuedExtensionWrite {
  /** `null` removes the slot's extension-storage copy. */
  value: string | null;
  version: number;
  settle: Array<(saved: boolean) => void>;
}

export interface BackupMetadata {
  timestamp: string;
  version: string;
  dataSize: number;
  itemCount: number;
}

export interface BackupData<T> {
  data: T;
  metadata: BackupMetadata;
}

export class DataBackupService<T = unknown> {
  private readonly primaryKey: string;
  private readonly emergencyKey: string;
  private readonly beforeUnloadKey: string;
  private readonly metadataKey: string;
  // Recovery backups expire after this window. The Safari durable mirror exists
  // precisely to survive ~7-day ITP localStorage eviction, so a 7-day TTL would
  // reject exactly the backups it just restored when a user returns on day 8+.
  // Use a much longer window on Safari (the mirror in browser.storage.local is
  // not ITP-evicted); keep the original 7 days elsewhere.
  private readonly maxBackupAge: number = (isSafari() ? 180 : 7) * 24 * 60 * 60 * 1000;
  private beforeUnloadHandler: (() => void) | null = null;

  // Safari always mirrors backups to survive ITP eviction. Other browsers use
  // the same durable slots only when page localStorage is full or unavailable.
  private readonly useDurableMirror: boolean = isSafari();
  /** Extension-storage copies this context has read or written, for recovery. */
  private readonly durableBackups = new Map<string, string>();
  /** Writes run one at a time; a newer value replaces a queued one for the same slot. */
  private readonly queuedWrites = new Map<string, QueuedExtensionWrite>();
  private draining: Promise<void> | null = null;
  /** Backup work recovery waits for: queued writes, unload copies and stale-copy removals. */
  private readonly inFlight = new Set<Promise<unknown>>();
  /** Bumped per write, so a superseded write neither lands late nor updates the cache. */
  private readonly slotVersions = new Map<string, number>();

  constructor(
    private readonly namespace: string,
    private readonly validateData: (data: T) => boolean = () => true,
  ) {
    this.primaryKey = `gvBackup_${namespace}_primary`;
    this.emergencyKey = `gvBackup_${namespace}_emergency`;
    this.beforeUnloadKey = `gvBackup_${namespace}_beforeUnload`;
    this.metadataKey = `gvBackup_${namespace}_metadata`;
  }

  /** Read durable slots before recovery, even when they cannot fit in localStorage. */
  async ensureHydrated(): Promise<void> {
    await this.settlePendingWrites();
    await this.hydrateFromDurableStore();
  }

  /** Wait for backup writes in flight, but a hung write must not block recovery. */
  private async settlePendingWrites(): Promise<void> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<void>((resolve) => {
      timer = setTimeout(resolve, PENDING_WRITE_WAIT_MS);
    });
    const settled = (async () => {
      while (this.inFlight.size > 0) await Promise.all(this.inFlight);
    })();
    try {
      await Promise.race([settled, timeout]);
    } finally {
      clearTimeout(timer);
    }
  }

  private track<P extends Promise<unknown>>(work: P): P {
    this.inFlight.add(work);
    void work.finally(() => this.inFlight.delete(work));
    return work;
  }

  private nextVersion(key: string): number {
    const version = (this.slotVersions.get(key) ?? 0) + 1;
    this.slotVersions.set(key, version);
    return version;
  }

  /**
   * Queue a copy or removal for one slot. Queued writes run in order, so an
   * older copy never lands after a newer one.
   */
  private queueExtensionWrite(key: string, value: string | null): Promise<boolean> {
    const version = this.nextVersion(key);
    const replaced = this.queuedWrites.get(key);
    this.queuedWrites.delete(key);
    return new Promise((resolve) => {
      this.queuedWrites.set(key, {
        value,
        version,
        settle: [...(replaced?.settle ?? []), resolve],
      });
      this.draining ??= this.track(this.drainQueuedWrites());
    });
  }

  private async drainQueuedWrites(): Promise<void> {
    for (let next = this.queuedWrites.entries().next(); !next.done;) {
      const [key, write] = next.value;
      this.queuedWrites.delete(key);
      const saved =
        write.value === null
          ? await this.removeExtensionCopy(key, write.version)
          : await this.putExtensionCopy(key, write.value, write.version);
      for (const settle of write.settle) settle(saved);
      next = this.queuedWrites.entries().next();
    }
    this.draining = null;
  }

  /**
   * The background writes the copy inside its storage budget, which skips one
   * that would not leave the reserve free (addendum P3P4 R6.1). The message is
   * sent before any await, so an unloading page still dispatches it.
   */
  private async putExtensionCopy(key: string, value: string, version: number): Promise<boolean> {
    const saved = await requestBudgetCopy(key, value);
    if (!saved) {
      console.warn(`[BackupService:${this.namespace}] Skipped ${key}: extension copy not admitted`);
      return false;
    }
    if (this.slotVersions.get(key) === version) this.durableBackups.set(key, value);
    return true;
  }

  private async removeExtensionCopy(key: string, version: number): Promise<boolean> {
    try {
      await browser.storage.local.remove(key);
      if (this.slotVersions.get(key) === version) this.durableBackups.delete(key);
      return true;
    } catch (error) {
      console.warn(`[BackupService:${this.namespace}] Durable copy removal failed:`, error);
      return false;
    }
  }

  /**
   * Send a copy now, ahead of queued writes, which an unloading page cannot wait
   * for. The background admits it against the slot's bytes when it writes (F3).
   */
  private writeExtensionCopyNow(key: string, value: string): Promise<boolean> {
    const version = this.nextVersion(key);
    const replaced = this.queuedWrites.get(key);
    this.queuedWrites.delete(key);
    const write = this.putExtensionCopy(key, value, version);
    for (const settle of replaced?.settle ?? []) void write.then(settle);
    return this.track(write);
  }

  /**
   * Write a slot to localStorage, and to extension storage when Safari mirrors it
   * or page storage rejected it. An older extension copy left beside a newer page
   * copy is harmless: recovery takes the newest valid copy of each slot, and
   * another tab may have just written a newer one there.
   */
  private async writeBackup(key: string, serialized: string, now = false): Promise<boolean> {
    let localSaved = false;
    try {
      // setItem is atomic on failure: never remove the previous backup to make room.
      localStorage.setItem(key, serialized);
      localSaved = true;
    } catch (error) {
      console.warn(`[BackupService:${this.namespace}] Local backup write failed:`, error);
    }
    if (localSaved && !this.useDurableMirror) return true;
    const durableSaved = await (now
      ? this.writeExtensionCopyNow(key, serialized)
      : this.queueExtensionWrite(key, serialized));
    return localSaved || durableSaved;
  }

  /**
   * Restore any backup slots that localStorage lost (e.g. Safari ITP eviction)
   * from Safari's durable mirror. Quota fallbacks on other browsers stay in
   * extension storage, leaving page storage space for live folder data.
   */
  private async hydrateFromDurableStore(): Promise<void> {
    try {
      const keys = [this.primaryKey, this.emergencyKey, this.beforeUnloadKey, this.metadataKey];
      const stored = await browser.storage.local.get(keys);
      for (const key of keys) {
        const value = stored[key];
        if (typeof value !== 'string') {
          this.durableBackups.delete(key);
          continue;
        }
        this.durableBackups.set(key, value);
        if (!this.useDurableMirror) continue;
        try {
          if (localStorage.getItem(key) === null) {
            localStorage.setItem(key, value);
          }
        } catch {
          // localStorage unavailable in this context; nothing to restore into.
        }
      }
    } catch (error) {
      console.warn(`[BackupService:${this.namespace}] Durable hydrate failed:`, error);
    }
  }

  /**
   * Create a primary backup (called after successful save)
   */
  async createPrimaryBackup(data: T): Promise<boolean> {
    try {
      const backup = this.createBackupData(data);
      const serialized = JSON.stringify(backup);
      if (!(await this.writeBackup(this.primaryKey, serialized))) return false;
      this.updateMetadata('primary', backup.metadata);
      console.log(`[BackupService:${this.namespace}] Primary backup created`);
      return true;
    } catch (error) {
      console.error(`[BackupService:${this.namespace}] Failed to create primary backup:`, error);
      return false;
    }
  }

  /**
   * Create an emergency backup (called before save operation)
   */
  async createEmergencyBackup(data: T): Promise<boolean> {
    try {
      const backup = this.createBackupData(data);
      const serialized = JSON.stringify(backup);
      if (!(await this.writeBackup(this.emergencyKey, serialized))) return false;
      console.log(`[BackupService:${this.namespace}] Emergency backup created`);
      return true;
    } catch (error) {
      console.error(`[BackupService:${this.namespace}] Failed to create emergency backup:`, error);
      return false;
    }
  }

  /**
   * Create a beforeUnload backup (called when page is about to close)
   */
  private async createBeforeUnloadBackup(data: T): Promise<boolean> {
    try {
      const backup = this.createBackupData(data);
      const serialized = JSON.stringify(backup);
      if (!(await this.writeBackup(this.beforeUnloadKey, serialized, true))) return false;
      console.log(`[BackupService:${this.namespace}] BeforeUnload backup created`);
      return true;
    } catch (error) {
      console.error(
        `[BackupService:${this.namespace}] Failed to create beforeUnload backup:`,
        error,
      );
      return false;
    }
  }

  /**
   * Setup automatic beforeUnload backup
   */
  setupBeforeUnloadBackup(getDataFn: () => T): void {
    if (this.beforeUnloadHandler) {
      window.removeEventListener('beforeunload', this.beforeUnloadHandler);
    }

    this.beforeUnloadHandler = () => {
      try {
        const data = getDataFn();
        void this.createBeforeUnloadBackup(data);
      } catch (error) {
        console.error(`[BackupService:${this.namespace}] BeforeUnload handler error:`, error);
      }
    };

    window.addEventListener('beforeunload', this.beforeUnloadHandler);
  }

  /**
   * Attempt to recover data from backups
   * Priority: primary > emergency > beforeUnload
   */
  recoverFromBackup(): T | null {
    console.warn(`[BackupService:${this.namespace}] Attempting data recovery...`);

    // Try primary backup first
    const primary = this.loadBackup(this.primaryKey, 'primary');
    if (primary) return primary;

    // Try emergency backup
    const emergency = this.loadBackup(this.emergencyKey, 'emergency');
    if (emergency) return emergency;

    // Try beforeUnload backup
    const beforeUnload = this.loadBackup(this.beforeUnloadKey, 'beforeUnload');
    if (beforeUnload) return beforeUnload;

    console.error(`[BackupService:${this.namespace}] All backup recovery attempts failed`);
    return null;
  }

  /**
   * Load a specific backup
   */
  private loadBackup(key: string, type: string): T | null {
    const candidates: BackupData<T>[] = [];
    let localValue: string | null = null;
    try {
      localValue = localStorage.getItem(key);
    } catch {
      // Recovery can still use extension storage when page storage is unavailable.
    }
    for (const value of [localValue, this.durableBackups.get(key)]) {
      if (!value) continue;
      try {
        const backup: BackupData<T> = JSON.parse(value);
        if (this.isBackupValid(backup) && this.validateData(backup.data)) candidates.push(backup);
      } catch (error) {
        console.warn(`[BackupService:${this.namespace}] Invalid ${type} backup:`, error);
      }
    }
    // Keep slot priority, but prefer the newest valid copy within each slot.
    candidates.sort((a, b) => Date.parse(b.metadata.timestamp) - Date.parse(a.metadata.timestamp));
    return candidates[0]?.data ?? null;
  }

  /**
   * Create backup data with metadata
   */
  private createBackupData(data: T): BackupData<T> {
    const dataStr = JSON.stringify(data);
    const itemCount = this.getItemCount(data);

    return {
      data,
      metadata: {
        timestamp: new Date().toISOString(),
        version: '1.0',
        dataSize: dataStr.length,
        itemCount,
      },
    };
  }

  /**
   * Check if backup is within valid time range
   */
  private isBackupValid(backup: BackupData<T>): boolean {
    try {
      const backupTime = new Date(backup.metadata.timestamp).getTime();
      const age = Date.now() - backupTime;

      if (!Number.isFinite(age) || age < 0) {
        console.warn(`[BackupService:${this.namespace}] Backup has future timestamp`);
        return false;
      }

      if (age > this.maxBackupAge) {
        console.warn(
          `[BackupService:${this.namespace}] Backup is too old: ${Math.floor(age / (24 * 60 * 60 * 1000))} days`,
        );
        return false;
      }

      return true;
    } catch {
      return false;
    }
  }

  /**
   * Get item count from data (for logging)
   */
  private getItemCount(data: T): number {
    try {
      if (typeof data === 'object' && data !== null) {
        if ('folders' in data && Array.isArray((data as Record<string, unknown>).folders)) {
          return ((data as Record<string, unknown>).folders as unknown[]).length;
        }
        if (Array.isArray(data)) {
          return data.length;
        }
        return Object.keys(data).length;
      }
      return 0;
    } catch {
      return 0;
    }
  }

  /**
   * Update metadata tracking
   */
  private updateMetadata(type: string, metadata: BackupMetadata): void {
    try {
      const allMetadata = this.getAllMetadata();
      allMetadata[type] = metadata;
      const serialized = JSON.stringify(allMetadata);
      localStorage.setItem(this.metadataKey, serialized);
      if (this.useDurableMirror) void this.queueExtensionWrite(this.metadataKey, serialized);
    } catch (error) {
      console.warn(`[BackupService:${this.namespace}] Failed to update metadata:`, error);
    }
  }

  /**
   * Get all backup metadata
   */
  getAllMetadata(): Record<string, BackupMetadata> {
    try {
      const metadataStr = localStorage.getItem(this.metadataKey);
      return metadataStr ? JSON.parse(metadataStr) : {};
    } catch {
      return {};
    }
  }

  /**
   * Clear all backups (for testing or cleanup)
   */
  clearAllBackups(): void {
    try {
      localStorage.removeItem(this.primaryKey);
      localStorage.removeItem(this.emergencyKey);
      localStorage.removeItem(this.beforeUnloadKey);
      localStorage.removeItem(this.metadataKey);
      this.durableBackups.clear();
      for (const key of [
        this.primaryKey,
        this.emergencyKey,
        this.beforeUnloadKey,
        this.metadataKey,
      ]) {
        void this.queueExtensionWrite(key, null);
      }
      console.log(`[BackupService:${this.namespace}] All backups cleared`);
    } catch (error) {
      console.error(`[BackupService:${this.namespace}] Failed to clear backups:`, error);
    }
  }

  /**
   * Cleanup - remove event listeners
   */
  destroy(): void {
    if (this.beforeUnloadHandler) {
      window.removeEventListener('beforeunload', this.beforeUnloadHandler);
      this.beforeUnloadHandler = null;
    }
  }
}
