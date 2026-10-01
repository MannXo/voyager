import { StorageKeys } from '@/core/types/common';
import type { PluginManifest } from '@/features/plugins/types';

/**
 * The plugins the user turned on, from the catalog `loadCatalog` returns.
 * Plugin enable state (storage.local) is the single source of truth; content
 * script registrations and permissions are derived from it.
 */
export async function loadEnabledPlugins(
  loadCatalog: () => Promise<readonly PluginManifest[]>,
): Promise<PluginManifest[]> {
  let state: unknown = {};
  try {
    const stored = await chrome.storage.local.get({ [StorageKeys.PLUGINS_STATE]: {} });
    state = stored?.[StorageKeys.PLUGINS_STATE];
  } catch {
    return [];
  }
  const enabledIds = new Set<string>();
  if (state && typeof state === 'object' && !Array.isArray(state)) {
    for (const [id, entry] of Object.entries(state as Record<string, { enabled?: boolean }>)) {
      if (entry && entry.enabled === true) enabledIds.add(id);
    }
  }
  const catalog = await loadCatalog();
  return catalog.filter((plugin) => enabledIds.has(plugin.id));
}
