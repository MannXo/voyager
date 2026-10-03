// @vitest-environment jsdom
// @vitest-environment-options { "url": "https://chatgpt.com/" }
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { StorageKeys } from '@/core/types/common';
import type { FolderData } from '@/core/types/folder';
import { ROOT_CONVERSATIONS_ID } from '@/features/folder/constants';
import { PluginScope } from '@/features/plugins/runtime/pluginScope';
import { initI18n } from '@/utils/i18n';

import { CHATGPT_FOLDER_CONFIG } from '../config';
import { activateChatGptFolders } from '../index';
import { type MemoryStorage, createMemoryStorage, settle } from './memoryStorage';

vi.mock('webextension-polyfill', () => ({
  default: {
    get storage() {
      return globalThis.chrome.storage;
    },
    runtime: { id: 'test-extension-id' },
    i18n: { getUILanguage: () => 'en' },
  },
}));

const A = '68a1f2c3-0b4d-8001-9e2f-1a2b3c4d5e6f';
const PANEL = '.gv-floating-folder-panel';
const FAB = '.gv-floating-fab';
const GEMINI_DATA: FolderData = {
  folders: [
    { id: 'g1', name: 'Gemini', parentId: null, isExpanded: true, createdAt: 1, updatedAt: 1 },
  ],
  folderContents: { g1: [], [ROOT_CONVERSATIONS_ID]: [] },
};

const originalAdd = EventTarget.prototype.addEventListener;
const originalRemove = EventTarget.prototype.removeEventListener;

type Registration = { owner: string; type: string; listener: unknown; capture: boolean };

/** Listeners added to `window` and `document` and not yet removed. */
function trackPageListeners(): { live: () => string[]; restore: () => void } {
  const live: Registration[] = [];
  const ownerOf = (target: EventTarget) =>
    target === window ? 'window' : target === document ? 'document' : null;
  const captureOf = (options?: boolean | EventListenerOptions) =>
    typeof options === 'boolean' ? options : Boolean(options?.capture);
  const add = vi
    .spyOn(EventTarget.prototype, 'addEventListener')
    .mockImplementation(function (this: EventTarget, type, listener, options) {
      const owner = ownerOf(this);
      const once = typeof options === 'object' && options?.once;
      if (owner && listener && !once) {
        live.push({ owner, type, listener, capture: captureOf(options) });
      }
      originalAdd.call(this, type, listener, options);
    });
  const remove = vi
    .spyOn(EventTarget.prototype, 'removeEventListener')
    .mockImplementation(function (this: EventTarget, type, listener, options) {
      const owner = ownerOf(this);
      const capture = captureOf(options);
      const index = live.findIndex(
        (entry) =>
          entry.owner === owner &&
          entry.type === type &&
          entry.listener === listener &&
          entry.capture === capture,
      );
      if (index >= 0) live.splice(index, 1);
      originalRemove.call(this, type, listener, options);
    });
  return {
    live: () => live.map((entry) => `${entry.owner}:${entry.type}`),
    restore: () => {
      add.mockRestore();
      remove.mockRestore();
    },
  };
}

let memory: MemoryStorage;
let originalStorage: typeof chrome.storage;
let scope: PluginScope;

beforeAll(async () => {
  // The content script initialises i18n on every plugin site before any plugin
  // starts; its one page-wide language listener is not this plugin's.
  memory = createMemoryStorage();
  originalStorage = globalThis.chrome.storage;
  globalThis.chrome.storage = memory.api;
  await initI18n();
  globalThis.chrome.storage = originalStorage;
});

beforeEach(() => {
  memory = createMemoryStorage();
  originalStorage = globalThis.chrome.storage;
  globalThis.chrome.storage = memory.api;
  localStorage.clear();
  memory.values.local.set(StorageKeys.FOLDER_DATA, structuredClone(GEMINI_DATA));
  memory.values.local.set(StorageKeys.FOLDER_DATA_AISTUDIO, structuredClone(GEMINI_DATA));
  memory.values.sync.set(StorageKeys.GV_ACCOUNT_ISOLATION_ENABLED, true);
  memory.values.sync.set(StorageKeys.GV_ACCOUNT_ISOLATION_ENABLED_GEMINI, true);
  history.replaceState(null, '', `/g/g-p-abc/c/${A}`);
  document.title = 'Trip plan';
  scope = new PluginScope();
});

afterEach(async () => {
  await scope.dispose();
  document.body.innerHTML = '';
  globalThis.chrome.storage = originalStorage;
  vi.restoreAllMocks();
});

function shadow(): ShadowRoot {
  const host = document.querySelector<HTMLElement>(PANEL);
  if (!host?.shadowRoot) throw new Error('panel is not open');
  return host.shadowRoot;
}

function press(element: Element, key: string): void {
  element.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }));
}

async function activate(): Promise<void> {
  await activateChatGptFolders(scope);
  await settle(20);
}

describe('ChatGPT folders plugin', () => {
  it('files the open conversation and writes only its own keys', async () => {
    const migrate = vi.spyOn(CHATGPT_FOLDER_CONFIG, 'migrateLegacyData');
    await activate();
    expect(document.querySelector(PANEL)).toBeNull();

    press(document.querySelector(FAB)!, 'Enter');
    // No Drive buttons: Drive sync does not carry ChatGPT folders.
    const header = Array.from(shadow().querySelectorAll('[class*="__header-actions"] button'));
    expect(header.map((button) => button.getAttribute('aria-label'))).toEqual([
      'Add current conversation',
      'Import folders',
      'Export folders',
      expect.any(String),
      expect.any(String),
    ]);
    shadow().querySelector<HTMLButtonElement>('[class*="icon-button--add-current"]')!.click();
    await settle(20);

    const bucket = memory.values.local.get(StorageKeys.FOLDER_DATA_CHATGPT) as FolderData;
    expect(bucket.folderContents[ROOT_CONVERSATIONS_ID]).toEqual([
      expect.objectContaining({
        conversationId: `chatgpt:conv:${A}`,
        title: 'Trip plan',
        url: `https://chatgpt.com/g/g-p-abc/c/${A}`,
      }),
    ]);
    expect(shadow().querySelector('[role="status"]')?.textContent).toBe('Added to folder.');
    expect(memory.values.local.get(StorageKeys.CHATGPT_FOLDER_PANEL)).toMatchObject({ open: true });

    expect(migrate).not.toHaveBeenCalled();
    expect(new Set(memory.writes.map((w) => `${w.area}:${w.key}`))).toEqual(
      new Set([
        `local:${StorageKeys.FOLDER_DATA_CHATGPT}`,
        `local:${StorageKeys.CHATGPT_FOLDER_PANEL}`,
      ]),
    );
    expect(memory.values.local.get(StorageKeys.FOLDER_DATA)).toEqual(GEMINI_DATA);
    expect(memory.values.local.get(StorageKeys.FOLDER_DATA_AISTUDIO)).toEqual(GEMINI_DATA);
  });

  it('refuses to file a temporary chat that the URL does not mark', async () => {
    memory.values.local.set(StorageKeys.CHATGPT_FOLDER_PANEL, { open: true });
    document.body.innerHTML =
      '<button data-testid="temporary-chat-toggle" aria-pressed="true"></button>';
    await activate();

    shadow().querySelector<HTMLButtonElement>('[class*="icon-button--add-current"]')!.click();
    await settle(20);

    expect(shadow().querySelector('[role="status"]')?.textContent).toBe(
      "Open a saved conversation first. Temporary chats can't be filed.",
    );
    expect(memory.writes.filter((w) => w.key === StorageKeys.FOLDER_DATA_CHATGPT)).toEqual([]);
  });

  it('asks before removing a filed conversation, and drops the question when turned off', async () => {
    const oneFiled: FolderData = {
      folders: [],
      folderContents: {
        [ROOT_CONVERSATIONS_ID]: [
          {
            conversationId: `chatgpt:conv:${A}`,
            title: 'Trip plan',
            url: `https://chatgpt.com/c/${A}`,
            addedAt: 1,
          },
        ],
      },
    };
    memory.values.local.set(StorageKeys.CHATGPT_FOLDER_PANEL, { open: true });
    memory.values.local.set(StorageKeys.FOLDER_DATA_CHATGPT, structuredClone(oneFiled));
    await activate();
    const filed = () =>
      (memory.values.local.get(StorageKeys.FOLDER_DATA_CHATGPT) as FolderData).folderContents[
        ROOT_CONVERSATIONS_ID
      ];
    const remove = () =>
      shadow().querySelector<HTMLButtonElement>('[class*="icon-button--remove"]')!.click();

    remove();
    await settle(20);
    const question = document.querySelector('.gv-folder-confirm-dialog');
    expect(question?.textContent).toContain('Trip plan');
    expect(filed()).toHaveLength(1);

    document.querySelector<HTMLButtonElement>('.gv-folder-confirm-yes')!.click();
    await settle(20);
    expect(filed()).toEqual([]);
    expect(document.querySelector('.gv-folder-confirm-dialog')).toBeNull();

    // Filed again from another tab; this time the plugin is turned off mid-question.
    memory.external('local', StorageKeys.FOLDER_DATA_CHATGPT, oneFiled);
    await settle(30);
    remove();
    await settle(20);
    expect(document.querySelector('.gv-folder-confirm-dialog')).not.toBeNull();

    await scope.dispose();
    expect(document.querySelector('.gv-folder-confirm-dialog')).toBeNull();
    expect(filed()).toHaveLength(1);
  });

  it('opens over stored folders named after inherited object keys', async () => {
    memory.values.local.set(StorageKeys.CHATGPT_FOLDER_PANEL, { open: true });
    memory.values.local.set(
      StorageKeys.FOLDER_DATA_CHATGPT,
      JSON.parse(
        '{"folders":[' +
          '{"id":"__proto__","name":"Proto","parentId":null,"isExpanded":true,"createdAt":1,"updatedAt":1},' +
          '{"id":"constructor","name":"Ctor","parentId":null,"isExpanded":true,"createdAt":1,"updatedAt":1}],' +
          '"folderContents":{}}',
      ),
    );
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});

    await activate();

    const text = shadow().textContent ?? '';
    expect(text).toContain('Proto');
    expect(text).toContain('Ctor');
    expect(errors).not.toHaveBeenCalled();
  });

  it('reopens the panel the user left open', async () => {
    memory.values.local.set(StorageKeys.CHATGPT_FOLDER_PANEL, { open: true });
    await activate();
    expect(document.querySelector(PANEL)).not.toBeNull();
  });

  it('stops answering popup folder requests when turned off', async () => {
    type Receiver = Parameters<typeof chrome.runtime.onMessage.addListener>[0];
    const receivers = new Set<Receiver>();
    vi.spyOn(chrome.runtime.onMessage, 'addListener').mockImplementation((listener) => {
      receivers.add(listener);
    });
    vi.spyOn(chrome.runtime.onMessage, 'removeListener').mockImplementation((listener) => {
      receivers.delete(listener);
    });
    const request = () => {
      let response: unknown;
      for (const receiver of receivers) {
        receiver({ type: 'gv.sync.requestData' }, { id: chrome.runtime.id }, (value: unknown) => {
          response = structuredClone(value);
        });
      }
      return response;
    };
    await activate();
    expect(request()).toMatchObject({ ok: true, data: { folders: [], folderContents: {} } });

    await scope.dispose();

    expect(request()).toBeUndefined();
  });

  it('leaves nothing behind when turned off', async () => {
    memory.values.local.set(StorageKeys.CHATGPT_FOLDER_PANEL, { open: true });
    const listeners = trackPageListeners();
    const storageListeners = memory.listeners.size;
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] });
    try {
      await activate();
      shadow().querySelector<HTMLButtonElement>('[class*="icon-button--add-current"]')!.click();
      await vi.advanceTimersByTimeAsync(0);
      expect(document.querySelector(FAB)).not.toBeNull();
      expect(memory.listeners.size).toBe(storageListeners + 1);

      await scope.dispose();

      expect(document.querySelector(FAB)).toBeNull();
      expect(document.querySelector(PANEL)).toBeNull();
      expect(memory.listeners.size).toBe(storageListeners);
      expect(listeners.live()).toEqual([]);
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
      listeners.restore();
    }
  });

  it('leaves nothing behind when turned off before its folders load', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    let bucketRequested = false;
    type Get = (keys?: unknown) => Promise<Record<string, unknown>>;
    const local = memory.api.local as unknown as { get: Get };
    const get = local.get;
    local.get = async (keys) => {
      const asked: unknown[] = typeof keys === 'string' ? [keys] : Array.isArray(keys) ? keys : [];
      if (asked.includes(StorageKeys.FOLDER_DATA_CHATGPT)) {
        bucketRequested = true;
        await gate;
      }
      return get(keys);
    };
    memory.values.local.set(StorageKeys.CHATGPT_FOLDER_PANEL, { open: true });
    const listeners = trackPageListeners();
    const storageListeners = memory.listeners.size;
    try {
      const activation = activateChatGptFolders(scope);
      await vi.waitFor(() => expect(bucketRequested).toBe(true));
      expect(document.querySelector(PANEL)).not.toBeNull();

      await scope.dispose();
      release();
      await activation;
      await settle(20);

      expect(document.querySelector(FAB)).toBeNull();
      expect(document.querySelector(PANEL)).toBeNull();
      expect(memory.listeners.size).toBe(storageListeners);
      expect(listeners.live()).toEqual([]);
      expect(memory.writes.filter((w) => w.key === StorageKeys.FOLDER_DATA_CHATGPT)).toEqual([]);
    } finally {
      listeners.restore();
    }
  });
});
