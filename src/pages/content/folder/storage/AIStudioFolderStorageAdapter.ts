import type { FolderData } from '../types';
import type { IFolderStorageAdapter } from './FolderStorageAdapter';

/**
 * AI Studio folder data lives only in `chrome.storage.local`, on every browser.
 * Never route AI Studio through `createFolderStorageAdapter()`: its default
 * adapter mirrors into page localStorage, and AI Studio has never written
 * folder data there.
 *
 * Writes reject instead of resolving `false`, as the direct
 * `chrome.storage.local.set` call they replace did.
 */
export class AIStudioFolderStorageAdapter implements IFolderStorageAdapter {
  async init(): Promise<void> {
    // Nothing to migrate per key; the sync → local copy runs in the manager's init.
  }

  async loadData(key: string): Promise<FolderData | null> {
    const result = await chrome.storage.local.get(key);
    return (result[key] as FolderData | undefined) ?? null;
  }

  /**
   * `companions` share the folder write's `set` call, so they land together or not
   * at all. Returns the `set` promise itself: wrapping it would settle the write a
   * microtask later than the direct call it replaces.
   */
  saveData(key: string, data: FolderData, companions?: Record<string, unknown>): Promise<void> {
    return chrome.storage.local.set({ [key]: data, ...companions });
  }

  async removeData(key: string): Promise<void> {
    await chrome.storage.local.remove(key);
  }

  getBackendName(): string {
    return 'chrome.storage.local (AI Studio)';
  }
}
