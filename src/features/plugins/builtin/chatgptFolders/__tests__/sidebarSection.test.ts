// @vitest-environment jsdom
// @vitest-environment-options { "url": "https://chatgpt.com/" }
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { StorageKeys } from '@/core/types/common';
import type { FolderData } from '@/core/types/folder';
import { ROOT_CONVERSATIONS_ID } from '@/features/folder/constants';
import { FolderImportExportService } from '@/features/folder/services/FolderImportExportService';
import { PluginScope } from '@/features/plugins/runtime/pluginScope';
import { openMenu } from '@/pages/content/folder/floatingTree/__tests__/treeDriver';
import { initI18n, getTranslationSyncUnsafe as t } from '@/utils/i18n';

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

const SECTION = '.gv-chatgpt-folder-section';
const FAB = '.gv-floating-fab';
const PANEL = '.gv-floating-folder-panel';
const ROWS = makeRows(10);
const FILED = ROWS[4];
const DATA: FolderData = {
  folders: [
    { id: 'f1', name: 'Work', parentId: null, isExpanded: true, createdAt: 1, updatedAt: 1 },
  ],
  folderContents: {
    f1: [
      {
        conversationId: `chatgpt:conv:${FILED.id}`,
        title: FILED.title,
        url: `https://chatgpt.com/c/${FILED.id}`,
        addedAt: 1,
      },
    ],
    [ROOT_CONVERSATIONS_ID]: [],
  },
};

let memory: MemoryStorage;
let originalStorage: typeof chrome.storage;
let scope: PluginScope;
let sidebar: SidebarFixture;

async function nextPass(): Promise<void> {
  await settle(5);
  await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
  await settle(20);
}

function sections(): HTMLElement[] {
  return [...document.querySelectorAll<HTMLElement>(SECTION)];
}

function section(): HTMLElement {
  const [only, ...rest] = sections();
  expect(rest).toEqual([]);
  return only;
}

function recents(): Element {
  return sidebar.sidebar.querySelector('[data-chatgpt-project-conversation-drop-target]')!;
}

function expectAboveRecents(): void {
  const host = section();
  expect(host.nextElementSibling).toBe(recents());
  expect(sidebar.sidebar.contains(host)).toBe(true);
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
  memory.values.local.set(StorageKeys.FOLDER_DATA_CHATGPT, structuredClone(DATA));
  scope = new PluginScope();
  sidebar = mountSidebarFixture(ROWS);
});

afterEach(async () => {
  await scope.dispose();
  sidebar.destroy();
  document.body.replaceChildren();
  globalThis.chrome.storage = originalStorage;
  vi.restoreAllMocks();
});

async function activate(): Promise<void> {
  await activateChatGptFolders(scope);
  await nextPass();
}

describe('ChatGPT folder section in the sidebar', () => {
  it('shows the folders just above Recents, outside its Project drop target', async () => {
    await activate();

    expectAboveRecents();
    expect(recents().contains(section())).toBe(false);
    expect(section().shadowRoot?.textContent).toContain('Work');
    expect(section().shadowRoot?.textContent).toContain(FILED.title);
  });

  it('comes back when a React re-render drops it', async () => {
    await activate();

    section().remove();
    await nextPass();

    expectAboveRecents();
  });

  it('moves into a remounted sidebar', async () => {
    await activate();
    const before = section();

    sidebar.replaceSidebar();
    await nextPass();

    expectAboveRecents();
    expect(section()).toBe(before);
  });

  it('stays put while history pages load and the list re-renders', async () => {
    await activate();
    const before = section();

    sidebar.appendPage(makeRows(10, 10));
    sidebar.rerenderList();
    await nextPass();

    expectAboveRecents();
    expect(section()).toBe(before);
  });

  it('settles instead of re-inserting itself after every sidebar change', async () => {
    await activate();
    const moves: MutationRecord[] = [];
    const observer = new MutationObserver((records) => moves.push(...records));
    observer.observe(section().parentElement!, { childList: true });

    sidebar.rename(ROWS[0].id, 'Touch the sidebar');
    for (let frame = 0; frame < 4; frame += 1) await nextPass();
    observer.disconnect();

    expect(moves).toEqual([]);
    expectAboveRecents();
  });

  it('removes a copy ChatGPT cloned with its own nodes', async () => {
    await activate();
    const clone = section().cloneNode(true) as HTMLElement;
    recents().parentElement!.insertBefore(clone, recents());
    expect(sections()).toHaveLength(2);

    sidebar.rename(ROWS[0].id, 'Touch the sidebar');
    await nextPass();

    expectAboveRecents();
    expect(clone.isConnected).toBe(false);
  });

  it('offers the floating button, not an unasked-for panel, while the sidebar is gone', async () => {
    await activate();

    sidebar.removeSidebar();
    await nextPass();
    await nextPass();

    expect(sections().filter((host) => host.isConnected)).toEqual([]);
    expect(document.querySelector(FAB)).not.toBeNull();
    expect(document.querySelector(PANEL)).toBeNull();

    document.body.append(sidebar.sidebar);
    await nextPass();
    expectAboveRecents();
    expect(document.querySelector(FAB)).toBeNull();
  });

  it('sidebar mode does not also show the floating folder button', async () => {
    memory.values.local.set(StorageKeys.CHATGPT_FOLDER_PANEL, { open: true });
    await activate();

    expectAboveRecents();
    expect(document.querySelector(FAB)).toBeNull();
    expect(document.querySelector(PANEL)).toBeNull();

    // The panel left open comes back with the button when the section cannot show.
    sidebar.removeSidebar();
    await nextPass();
    expect(document.querySelector(FAB)).not.toBeNull();
    expect(document.querySelector(PANEL)).not.toBeNull();

    document.body.append(sidebar.sidebar);
    await nextPass();
    expect(document.querySelector(FAB)).toBeNull();
    expect(document.querySelector(PANEL)).toBeNull();
    expect(memory.values.local.get(StorageKeys.CHATGPT_FOLDER_PANEL)).toMatchObject({
      open: true,
    });
  });

  it('exports from its own header and confirms it there', async () => {
    const download = vi
      .spyOn(FolderImportExportService, 'downloadJSON')
      .mockImplementation(() => {});
    await activate();

    section()
      .shadowRoot!.querySelector<HTMLButtonElement>('button[aria-label="Export folders"]')!
      .click();

    expect(download).toHaveBeenCalledTimes(1);
    const status = section().shadowRoot!.querySelector<HTMLElement>('[role="status"]')!;
    expect(status.hidden).toBe(false);
    expect(status.textContent).toBe(t('folder_export_success'));
  });

  it('creates and saves a folder from its own header', async () => {
    await activate();

    const create = section().shadowRoot!.querySelector<HTMLButtonElement>(
      '[class*="icon-button--create"]',
    )!;
    create.click();
    const input = section().shadowRoot!.querySelector<HTMLInputElement>('input')!;
    input.value = 'Ideas';
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    await settle(20);

    const saved = memory.values.local.get(StorageKeys.FOLDER_DATA_CHATGPT) as FolderData;
    expect(saved.folders.map((folder) => folder.name)).toContain('Ideas');
    expect(section().shadowRoot?.textContent).toContain('Ideas');
  });

  it('confirms "Add current conversation here" in the section while the panel is closed', async () => {
    await activate();
    const root = section().shadowRoot!;
    const status = root.querySelector<HTMLElement>('[role="status"]')!;
    const addCurrentHere = async (): Promise<void> => {
      root
        .querySelector('[data-folder-id="f1"]')!
        .dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true }));
      await settle(5);
      [...openMenu()!.querySelectorAll<HTMLElement>('button')]
        .find((button) => button.textContent?.includes('Add current conversation here'))!
        .click();
      await settle(20);
    };
    expect(document.querySelector('.gv-floating-folder-panel')).toBeNull();

    history.pushState(null, '', `/c/${ROWS[2].id}`);
    try {
      await addCurrentHere();
      expect(status.hidden).toBe(false);
      expect(status.textContent).toBe('Added to folder.');
      const saved = memory.values.local.get(StorageKeys.FOLDER_DATA_CHATGPT) as FolderData;
      expect(saved.folderContents.f1.map((c) => c.conversationId)).toContain(
        `chatgpt:conv:${ROWS[2].id}`,
      );
    } finally {
      history.pushState(null, '', '/');
    }

    await addCurrentHere();
    expect(status.textContent).toBe(
      "Open a saved conversation first. Temporary chats can't be filed.",
    );
  });

  it('marks the filed conversation the page has open, and follows the route', async () => {
    await activate();
    const filedTitle = () =>
      [...section().shadowRoot!.querySelectorAll<HTMLElement>('[class*="__conv-title"]')].find(
        (title) => title.textContent === FILED.title,
      )!;
    expect(filedTitle().getAttribute('aria-current')).toBeNull();

    try {
      history.pushState(null, '', `/c/${FILED.id}`);
      sidebar.setActive(FILED.id);
      await nextPass();
      expect(filedTitle().getAttribute('aria-current')).toBe('page');

      history.pushState(null, '', `/c/${ROWS[2].id}`);
      sidebar.setActive(ROWS[2].id);
      await nextPass();
      expect(filedTitle().getAttribute('aria-current')).toBeNull();
    } finally {
      history.pushState(null, '', '/');
    }
  });

  it('opens a filed conversation through its sidebar link', async () => {
    await activate();
    const link = sidebar.row(FILED.id).querySelector('a')!;
    const clicked = vi.fn((event: Event) => event.preventDefault());
    link.addEventListener('click', clicked);

    const row = [
      ...section().shadowRoot!.querySelectorAll<HTMLElement>('[class*="__conv-title"]'),
    ].find((title) => title.textContent === FILED.title)!;
    row.click();
    await settle(20);

    expect(clicked).toHaveBeenCalledTimes(1);
  });

  it('leaves the sidebar as it found it when turned off', async () => {
    await activate();
    await scope.dispose();

    expect(sections()).toEqual([]);
    sidebar.rerenderList();
    await nextPass();
    expect(sections()).toEqual([]);
  });
});
