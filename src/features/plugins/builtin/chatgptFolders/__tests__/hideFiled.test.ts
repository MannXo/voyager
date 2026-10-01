// @vitest-environment jsdom
// @vitest-environment-options { "url": "https://chatgpt.com/" }
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { StorageKeys } from '@/core/types/common';
import type { FolderData } from '@/core/types/folder';
import { ROOT_CONVERSATIONS_ID } from '@/features/folder/constants';
import { PluginScope } from '@/features/plugins/runtime/pluginScope';
import { initI18n } from '@/utils/i18n';

import { HIDE_FILED_SETTING, hideFiledRowsCss } from '../chatgptHideFiled';
import { activateChatGptFolders } from '../index';
import { type SidebarFixture, makeRows, mountSidebarFixture } from './chatgptSidebarFixture';
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

const STYLE = 'style[data-gv-chatgpt-hide-filed]';
const ROWS = makeRows(6);

let memory: MemoryStorage;
let originalStorage: typeof chrome.storage;
let scope: PluginScope;
let sidebar: SidebarFixture;

function filed(...rows: typeof ROWS): FolderData {
  return {
    folders: [],
    folderContents: {
      [ROOT_CONVERSATIONS_ID]: rows.map((row) => ({
        conversationId: `chatgpt:conv:${row.id}`,
        title: row.title,
        url: `https://chatgpt.com/c/${row.id}`,
        addedAt: 1,
      })),
    },
  };
}

/** The injected rule's selector; jsdom does not cascade `:has()`, so tests match it. */
function hiddenSelector(): string {
  const css = document.querySelector(STYLE)?.textContent ?? '';
  return css.slice(0, css.lastIndexOf('{')).trim();
}

function hiddenIds(): string[] {
  const selector = hiddenSelector();
  if (!selector) return [];
  return [...document.querySelectorAll(selector)].map((row) =>
    row.getAttribute('data-sidebar-chatgpt-conversation-key')!.replace('chatgpt:conversation:', ''),
  );
}

beforeAll(async () => {
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
  scope = new PluginScope();
  sidebar = mountSidebarFixture(ROWS);
});

afterEach(async () => {
  await scope.dispose();
  sidebar.destroy();
  document.head.querySelectorAll(STYLE).forEach((style) => style.remove());
  document.body.replaceChildren();
  globalThis.chrome.storage = originalStorage;
});

describe('hiding filed chats in Recents', () => {
  it('hides only filed rows, and keeps the open conversation visible', async () => {
    memory.values.local.set(StorageKeys.FOLDER_DATA_CHATGPT, filed(ROWS[1], ROWS[3]));
    sidebar.setActive(ROWS[3].id);

    await activateChatGptFolders(scope, { [HIDE_FILED_SETTING]: true });
    await settle(20);

    expect(hiddenIds()).toEqual([ROWS[1].id]);
  });

  it('follows filing and covers rows from later history pages', async () => {
    memory.values.local.set(StorageKeys.FOLDER_DATA_CHATGPT, filed(ROWS[1]));
    await activateChatGptFolders(scope, { [HIDE_FILED_SETTING]: true });
    await settle(20);
    const later = makeRows(2, 40);

    memory.external('local', StorageKeys.FOLDER_DATA_CHATGPT, filed(ROWS[1], later[1]));
    await settle(30);
    sidebar.appendPage(later);

    expect(hiddenIds().sort()).toEqual([ROWS[1].id, later[1].id].sort());
  });

  it('keeps a filed chat visible inside its Project', async () => {
    memory.values.local.set(StorageKeys.FOLDER_DATA_CHATGPT, filed(ROWS[2]));
    const project = sidebar.sidebar.querySelector(
      '[data-app-action-sidebar-section-heading="Projects"] [role="list"]',
    )!;
    const inProject = sidebar.row(ROWS[2].id).cloneNode(true) as HTMLElement;
    inProject.querySelector('a')!.setAttribute('href', `/g/g-p-67ab12cd34-trip/c/${ROWS[2].id}`);
    project.append(inProject);

    await activateChatGptFolders(scope, { [HIDE_FILED_SETTING]: true });
    await settle(20);

    expect(hiddenIds()).toEqual([ROWS[2].id]);
    expect(project.contains(document.querySelectorAll(hiddenSelector())[0])).toBe(false);
  });

  it('hides nothing unless the setting is on, and removes its rule when turned off', async () => {
    memory.values.local.set(StorageKeys.FOLDER_DATA_CHATGPT, filed(ROWS[1]));
    await activateChatGptFolders(scope);
    await settle(20);
    expect(document.querySelector(STYLE)).toBeNull();

    await scope.dispose();
    scope = new PluginScope();
    await activateChatGptFolders(scope, { [HIDE_FILED_SETTING]: true });
    await settle(20);
    expect(hiddenIds()).toEqual([ROWS[1].id]);

    await scope.dispose();
    expect(document.querySelector(STYLE)).toBeNull();
  });

  it('never writes an id that could break out of the selector', () => {
    expect(hideFiledRowsCss(['abc"], body { display: none } a[x="'])).toBe('');
    expect(hideFiledRowsCss([])).toBe('');
  });
});
