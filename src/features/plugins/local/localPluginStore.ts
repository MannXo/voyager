/**
 * Storage for user-imported plugins, in `chrome.storage.local` under
 * `StorageKeys.PLUGIN_LOCAL_MANIFESTS` as `Record<'local.<id>', LocalPluginRecord>`.
 *
 * A record keeps the manifest exactly as imported (CSS inlined, id already
 * namespaced). It is NOT trusted on the way out: `LocalPluginSource` passes it
 * through `validateLocalManifest` on every read, so a stricter guard in a later
 * build also covers plugins imported before it.
 *
 * Content scripts read this directly per the content-script storage rule.
 */
import { logger } from '@/core/services/LoggerService';
import { StorageKeys } from '@/core/types/common';
import { isExtensionContextInvalidatedError } from '@/core/utils/extensionContext';

import { isLocalPluginId } from './localPluginId';

export interface LocalPluginRecord {
  /** Raw manifest as imported, CSS inlined; validated again on every read. */
  readonly manifest: Readonly<Record<string, unknown>>;
  readonly importedAt: number;
  readonly updatedAt: number;
}
export type LocalPluginRecordMap = Readonly<Record<string, LocalPluginRecord>>;

/** Upper bound on stored local plugins; protects storage and every page load. */
export const MAX_LOCAL_PLUGINS = 50;

const KEY = StorageKeys.PLUGIN_LOCAL_MANIFESTS;

function localArea(): chrome.storage.LocalStorageArea | undefined {
  const g = globalThis as { chrome?: typeof chrome };
  return g.chrome?.storage?.local;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function finiteOr(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

/** Keep well-formed `local.*` entries only; never trust the stored shape. */
export function sanitizeLocalPluginRecords(value: unknown): LocalPluginRecordMap {
  if (!isRecord(value)) return {};
  const records: Record<string, LocalPluginRecord> = {};
  for (const [id, entry] of Object.entries(value)) {
    if (!isLocalPluginId(id) || !isRecord(entry) || !isRecord(entry.manifest)) continue;
    if (entry.manifest.id !== id) continue;
    const importedAt = finiteOr(entry.importedAt, 0);
    records[id] = {
      manifest: entry.manifest,
      importedAt,
      updatedAt: finiteOr(entry.updatedAt, importedAt),
    };
    if (Object.keys(records).length >= MAX_LOCAL_PLUGINS) break;
  }
  return records;
}

export async function loadLocalPluginRecords(): Promise<LocalPluginRecordMap> {
  const local = localArea();
  if (!local) return {};
  try {
    const result = await local.get({ [KEY]: {} });
    return sanitizeLocalPluginRecords(result?.[KEY]);
  } catch (error) {
    if (!isExtensionContextInvalidatedError(error)) {
      logger.warn('loadLocalPluginRecords failed', { error: String(error) });
    }
    return {};
  }
}

/**
 * Store a VALIDATED manifest under its (namespaced) id, replacing any previous
 * version. Callers validate first: a failed import never reaches this, so the
 * previous version stays in place.
 */
export async function saveLocalPluginRecord(
  manifest: Readonly<Record<string, unknown>>,
  now: number = Date.now(),
): Promise<void> {
  const id = manifest.id;
  if (typeof id !== 'string' || !isLocalPluginId(id)) {
    throw new Error('local plugin id must be namespaced under local.');
  }
  const local = localArea();
  if (!local) throw new Error('extension storage is unavailable');
  const current = await loadLocalPluginRecords();
  const previous = current[id];
  if (!previous && Object.keys(current).length >= MAX_LOCAL_PLUGINS) {
    throw new Error(`at most ${MAX_LOCAL_PLUGINS} local plugins can be installed`);
  }
  const next: Record<string, LocalPluginRecord> = {
    ...current,
    [id]: { manifest, importedAt: previous?.importedAt ?? now, updatedAt: now },
  };
  await local.set({ [KEY]: next });
}

export async function removeLocalPluginRecord(id: string): Promise<void> {
  const local = localArea();
  if (!local) return;
  const current = await loadLocalPluginRecords();
  if (!(id in current)) return;
  const next: Record<string, LocalPluginRecord> = { ...current };
  delete next[id];
  await local.set({ [KEY]: next });
}

/** Subscribe to imports, updates and removals of local plugins. */
export function subscribeLocalPlugins(callback: () => void): () => void {
  const g = globalThis as { chrome?: typeof chrome };
  const onChanged = g.chrome?.storage?.onChanged;
  if (!onChanged) return () => {};
  const listener = (changes: Record<string, chrome.storage.StorageChange>, area: string): void => {
    if (area === 'local' && changes[KEY]) callback();
  };
  onChanged.addListener(listener);
  return () => {
    try {
      onChanged.removeListener(listener);
    } catch {
      // ignore — context may be gone
    }
  };
}
