/**
 * Persistence for the research pack in `chrome.storage.local`.
 *
 * Scope: one pack per browser profile while account isolation is off, which
 * is what lets a user carry it from one conversation (or account) to the next.
 * When the user turns account isolation on for the platform, each account gets
 * its own pack under `buildScopedStorageKey`, matching how folders behave.
 * The pack is never synced to Drive or included in backups.
 */
import { buildScopedStorageKey } from '@/core/services/AccountIsolationService';
import { StorageKeys } from '@/core/types/common';

import { createEmptyPack, isNewerPackVersion, parsePack } from './packModel';
import type { ResearchPack } from './types';

export interface ResearchPackStorageArea {
  get(key: string): Promise<Record<string, unknown>>;
  set(items: Record<string, unknown>): Promise<void>;
}

export interface ResearchPackKeyDeps {
  isIsolationEnabled: () => Promise<boolean>;
  /** Resolves the current account's key; only called when isolation is on. */
  resolveAccountKey: () => Promise<string>;
}

/** The storage key for the current page: global, or per account under isolation. */
export async function resolveResearchPackStorageKey(deps: ResearchPackKeyDeps): Promise<string> {
  if (!(await deps.isIsolationEnabled())) return StorageKeys.RESEARCH_PACK;
  return buildScopedStorageKey(StorageKeys.RESEARCH_PACK, await deps.resolveAccountKey());
}

/** True for the global pack key and every account-scoped variant of it. */
export function isResearchPackStorageKey(key: string): boolean {
  return key === StorageKeys.RESEARCH_PACK || key.startsWith(`${StorageKeys.RESEARCH_PACK}:acct:`);
}

export interface ResearchPackUpdate<T> {
  pack: ResearchPack;
  result: T;
}

export interface ResearchPackStore {
  load(): Promise<ResearchPack>;
  /**
   * Read, transform and write back in one serialized step. The write is
   * skipped when the transform returns the same pack, and when the stored pack
   * was written by a newer build.
   */
  update<T>(
    transform: (pack: ResearchPack) => ResearchPackUpdate<T>,
  ): Promise<ResearchPackUpdate<T>>;
}

export function createResearchPackStore(options: {
  area: ResearchPackStorageArea;
  resolveKey: () => Promise<string>;
}): ResearchPackStore {
  let queue: Promise<unknown> = Promise.resolve();

  const serialize = <T>(operation: () => Promise<T>): Promise<T> => {
    const next = queue.then(operation, operation);
    queue = next.catch(() => undefined);
    return next;
  };

  const readRaw = async (): Promise<{ key: string; raw: unknown }> => {
    const key = await options.resolveKey();
    const stored = await options.area.get(key);
    return { key, raw: stored?.[key] };
  };

  return {
    async load() {
      try {
        const { raw } = await readRaw();
        return parsePack(raw);
      } catch {
        return createEmptyPack();
      }
    },
    update(transform) {
      return serialize(async () => {
        const { key, raw } = await readRaw();
        const current = parsePack(raw);
        const next = transform(current);
        if (next.pack !== current && !isNewerPackVersion(raw)) {
          await options.area.set({ [key]: next.pack });
        }
        return next;
      });
    },
  };
}
