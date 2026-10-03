import type { LegacyFolderFence } from '@/features/folder/owner/legacyFolderFence';

import type { FolderData } from '../types';
import type { IFolderStorageAdapter } from './FolderStorageAdapter';

export class FencedFolderStorageAdapter implements IFolderStorageAdapter {
  private readonly initializations = new Map<string, Promise<void>>();
  constructor(
    private readonly storage: IFolderStorageAdapter,
    private readonly fence: LegacyFolderFence,
  ) {}

  async init(key: string): Promise<void> {
    if (!(await this.fence.check())) throw new Error('Legacy folder storage is fenced');
    const existing = this.initializations.get(key);
    if (existing) return existing;
    // Revisiting an account must not race its save queue with another migration.
    const initialization = this.storage.init(key).catch((error) => {
      this.initializations.delete(key);
      throw error;
    });
    this.initializations.set(key, initialization);
    return initialization;
  }

  async loadData(key: string): Promise<FolderData | null> {
    // Existing adapters mirror or migrate during load, so this is also a write boundary.
    if (!(await this.fence.check())) throw new Error('Legacy folder storage is fenced');
    const data = await this.storage.loadData(key);
    // A fence discovered after the read must preserve memory before recovery can replace it.
    if (!(await this.fence.check())) throw new Error('Legacy folder storage is fenced');
    return data;
  }

  async saveData(
    key: string,
    data: FolderData,
    companions?: Record<string, unknown>,
  ): Promise<boolean | void> {
    if (!(await this.fence.check())) return false;
    return companions
      ? this.storage.saveData(key, data, companions)
      : this.storage.saveData(key, data);
  }

  async removeData(key: string): Promise<void> {
    if (await this.fence.check()) await this.storage.removeData(key);
  }

  getBackendName(): string {
    return this.storage.getBackendName();
  }
}
