import { type Mock, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { StorageKeys } from '@/core/types/common';
import {
  PLUGIN_CATALOG_REFRESH_MESSAGE,
  PLUGIN_CONTENT_SCRIPT_SYNC_MESSAGE,
  PLUGIN_SET_SETTING_MESSAGE,
} from '@/features/plugins/runtime/messages';
import { requestPluginSetting } from '@/features/plugins/storage/pluginSettingRequest';

import { handlePluginRuntimeMessage } from '../pluginRuntimeMessages';
import { isHandledBackgroundRuntimeMessage } from '../runtimeMessageRouting';

const STATE = StorageKeys.PLUGINS_STATE;
let memory: Record<string, unknown>;

function deps() {
  return {
    syncContentScripts: vi.fn().mockResolvedValue(undefined),
    refreshCatalog: vi.fn().mockResolvedValue({ ok: true, status: 'unchanged' }),
  };
}

beforeEach(() => {
  memory = {};
  (chrome.storage.local.get as unknown as Mock).mockImplementation(
    async (defaults: Record<string, unknown>) => {
      const out: Record<string, unknown> = {};
      for (const [key, fallback] of Object.entries(defaults)) {
        out[key] = key in memory ? structuredClone(memory[key]) : fallback;
      }
      return out;
    },
  );
  (chrome.storage.local.set as unknown as Mock).mockImplementation(
    async (items: Record<string, unknown>) => {
      Object.assign(memory, structuredClone(items));
    },
  );
});

afterEach(() => {
  (chrome.storage.local.get as unknown as Mock).mockReset();
  (chrome.storage.local.set as unknown as Mock).mockReset();
});

describe('plugin setting writes from content scripts', () => {
  it('sends the setting to the background instead of writing storage itself', async () => {
    const sendMessage = chrome.runtime.sendMessage as unknown as Mock;
    sendMessage.mockResolvedValue({ ok: true });
    await requestPluginSetting('voyager.claude-timeline', 'compactView', true);
    expect(sendMessage).toHaveBeenCalledWith({
      type: PLUGIN_SET_SETTING_MESSAGE,
      payload: { id: 'voyager.claude-timeline', key: 'compactView', value: true },
    });
    expect(chrome.storage.local.set).not.toHaveBeenCalled();
  });

  it('is a handled background message type', () => {
    expect(isHandledBackgroundRuntimeMessage({ type: PLUGIN_SET_SETTING_MESSAGE })).toBe(true);
  });

  it('stores the setting and keeps the enable state', async () => {
    memory[STATE] = {
      'voyager.claude-timeline': { enabled: true, installedAt: 1 },
      'local.me.wide': { enabled: false, installedAt: 2 },
    };
    const response = await handlePluginRuntimeMessage(
      {
        type: PLUGIN_SET_SETTING_MESSAGE,
        payload: { id: 'voyager.claude-timeline', key: 'compactView', value: true },
      },
      deps(),
    );
    expect(response).toEqual({ ok: true });
    expect(memory[STATE]).toEqual({
      'voyager.claude-timeline': { enabled: true, installedAt: 1, settings: { compactView: true } },
      'local.me.wide': { enabled: false, installedAt: 2 },
    });
  });

  it('never switches a plugin on', async () => {
    memory[STATE] = { 'local.me.wide': { enabled: false, installedAt: 2 } };
    await handlePluginRuntimeMessage(
      {
        type: PLUGIN_SET_SETTING_MESSAGE,
        payload: { id: 'local.me.wide', key: 'enabled', value: true },
      },
      deps(),
    );
    await handlePluginRuntimeMessage(
      {
        type: PLUGIN_SET_SETTING_MESSAGE,
        payload: { id: 'local.me.new', key: 'compact', value: true },
      },
      deps(),
    );
    const state = memory[STATE] as Record<string, { enabled: boolean }>;
    expect(state['local.me.wide'].enabled).toBe(false);
    expect(state['local.me.new'].enabled).toBe(false);
  });

  it.each([
    null,
    { id: 'voyager.x', key: 'k' },
    { id: '', key: 'k', value: 1 },
    { id: '__proto__', key: 'k', value: 1 },
    { id: 'voyager.x', key: 'constructor', value: 1 },
    { id: 'voyager.x', key: 'k', value: { nested: true } },
    { id: 'voyager.x', key: 'k', value: Number.NaN },
  ])('rejects a malformed setting payload %#', async (payload) => {
    memory[STATE] = { 'voyager.x': { enabled: true, installedAt: 1 } };
    const response = await handlePluginRuntimeMessage(
      { type: PLUGIN_SET_SETTING_MESSAGE, payload },
      deps(),
    );
    expect(response).toEqual({ ok: false, error: 'invalid_payload' });
    expect(chrome.storage.local.set).not.toHaveBeenCalled();
  });
});

describe('other plugin background messages', () => {
  it('repairs content-script registration through the serialized sync', async () => {
    const d = deps();
    const response = await handlePluginRuntimeMessage(
      { type: PLUGIN_CONTENT_SCRIPT_SYNC_MESSAGE },
      d,
    );
    expect(d.syncContentScripts).toHaveBeenCalledTimes(1);
    expect(response).toEqual({ ok: true });
  });

  it('routes catalog checks through the single refresher', async () => {
    const d = deps();
    const response = await handlePluginRuntimeMessage(
      { type: PLUGIN_CATALOG_REFRESH_MESSAGE, payload: { host: 'claude.ai', force: true } },
      d,
    );
    expect(d.refreshCatalog).toHaveBeenCalledWith('claude.ai', true);
    expect(response).toEqual({ ok: true, status: 'unchanged' });
    expect(
      await handlePluginRuntimeMessage({ type: PLUGIN_CATALOG_REFRESH_MESSAGE, payload: {} }, d),
    ).toEqual({ ok: false, error: 'invalid_payload' });
  });

  it('leaves every other message to the caller', () => {
    expect(handlePluginRuntimeMessage({ type: 'gv.account.resolve' }, deps())).toBeNull();
    expect(handlePluginRuntimeMessage(null, deps())).toBeNull();
  });
});
