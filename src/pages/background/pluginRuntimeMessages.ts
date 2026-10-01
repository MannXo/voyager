/**
 * Background handlers for plugin runtime messages from content scripts and the
 * popup. Returns null for any other message so the caller keeps routing it.
 */
import { parseHostCatalogRefreshPayload } from '@/features/plugins/remote/hostCatalogRefresh';
import {
  PLUGIN_CATALOG_REFRESH_MESSAGE,
  PLUGIN_CONTENT_SCRIPT_SYNC_MESSAGE,
  PLUGIN_SET_SETTING_MESSAGE,
} from '@/features/plugins/runtime/messages';
import { parsePluginSettingRequest } from '@/features/plugins/storage/pluginSettingRequest';
import { setPluginSetting } from '@/features/plugins/storage/pluginState';

export interface PluginRuntimeMessageDeps {
  /** The serialized dynamic content-script registration sync. */
  syncContentScripts(): Promise<void>;
  /** The single remote catalog refresher. */
  refreshCatalog(host: string, force: boolean): Promise<unknown>;
}

const INVALID_PAYLOAD = { ok: false, error: 'invalid_payload' } as const;

export function handlePluginRuntimeMessage(
  message: unknown,
  deps: PluginRuntimeMessageDeps,
): Promise<unknown> | null {
  if (typeof message !== 'object' || message === null) return null;
  const { type, payload } = message as { type?: unknown; payload?: unknown };

  if (type === PLUGIN_CONTENT_SCRIPT_SYNC_MESSAGE) {
    return deps.syncContentScripts().then(() => ({ ok: true }));
  }
  if (type === PLUGIN_CATALOG_REFRESH_MESSAGE) {
    const request = parseHostCatalogRefreshPayload(payload);
    if (!request) return Promise.resolve(INVALID_PAYLOAD);
    return deps.refreshCatalog(request.host, request.force);
  }
  if (type === PLUGIN_SET_SETTING_MESSAGE) {
    // Written here, under the plugin-storage lock the popup shares; a content
    // script's own write could not be serialized with a local-plugin import.
    const request = parsePluginSettingRequest(payload);
    if (!request) return Promise.resolve(INVALID_PAYLOAD);
    return setPluginSetting(request.id, request.key, request.value).then(() => ({ ok: true }));
  }
  return null;
}
