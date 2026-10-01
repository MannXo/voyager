// @vitest-environment jsdom
// @vitest-environment-options { "url": "https://chatgpt.com/" }
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { StorageKeys } from '@/core/types/common';
import type { FolderData } from '@/core/types/folder';
import { ROOT_CONVERSATIONS_ID } from '@/features/folder/constants';
import { PluginScope } from '@/features/plugins/runtime/pluginScope';
import { initI18n } from '@/utils/i18n';

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

const ENTRY = '[data-gv-chatgpt-move-to-folder]';
const PICKER = '.gv-chatgpt-folder-picker';
const ROWS = makeRows(5);
const TARGET = ROWS[3];
const DATA: FolderData = {
  folders: [
    { id: 'f1', name: 'Work', parentId: null, isExpanded: true, createdAt: 1, updatedAt: 1 },
    { id: 'f2', name: 'Trips', parentId: 'f1', isExpanded: true, createdAt: 1, updatedAt: 1 },
  ],
  folderContents: { f1: [], f2: [], [ROOT_CONVERSATIONS_ID]: [] },
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

function labels(menu: Element): string[] {
  return [...menu.querySelectorAll('[role="menuitem"]')].map((item) => item.textContent ?? '');
}

function picker(): ShadowRoot {
  const host = document.querySelector<HTMLElement>(PICKER);
  if (!host?.shadowRoot) throw new Error('picker is not open');
  return host.shadowRoot;
}

function pick(name: string): void {
  const item = [...picker().querySelectorAll<HTMLButtonElement>('.item')].find(
    (button) => button.querySelector('.name')?.textContent === name,
  );
  if (!item) throw new Error(`no folder ${name}`);
  item.click();
}

function stored(folderId: string) {
  return (memory.values.local.get(StorageKeys.FOLDER_DATA_CHATGPT) as FolderData).folderContents[
    folderId
  ];
}

beforeAll(async () => {
  memory = createMemoryStorage();
  originalStorage = globalThis.chrome.storage;
  globalThis.chrome.storage = memory.api;
  await initI18n();
  globalThis.chrome.storage = originalStorage;
});

beforeEach(async () => {
  memory = createMemoryStorage();
  originalStorage = globalThis.chrome.storage;
  globalThis.chrome.storage = memory.api;
  memory.values.local.set(StorageKeys.FOLDER_DATA_CHATGPT, structuredClone(DATA));
  scope = new PluginScope();
  sidebar = mountSidebarFixture(ROWS);
  await activateChatGptFolders(scope);
  await nextPass();
});

afterEach(async () => {
  await scope.dispose();
  sidebar.destroy();
  document.body.replaceChildren();
  globalThis.chrome.storage = originalStorage;
});

describe('"Move to folder" in a sidebar row menu', () => {
  it('sits after Move to project once, and files the row into the picked folder', async () => {
    const menu = sidebar.openMenu(TARGET.id);
    await nextPass();
    // Another sidebar change while the menu is open checks it again.
    sidebar.rename(ROWS[0].id, 'Renamed meanwhile');
    await nextPass();

    expect(labels(menu)).toEqual([
      'Rename',
      'Pin',
      'Move to project',
      'Move to folder',
      'Share',
      'Archive',
      'Delete',
    ]);
    const entry = menu.querySelector<HTMLElement>(ENTRY)!;
    expect(entry.hasAttribute('data-radix-collection-item')).toBe(false);
    expect(entry.className).toBe('gv-test-native-menu-item');

    const escapes = vi.fn();
    menu.addEventListener('keydown', (event) => {
      if (event.key === 'Escape') escapes();
    });
    entry.click();
    expect(escapes).toHaveBeenCalledTimes(1);

    pick('Trips');
    await settle(20);
    expect(stored('f2')).toEqual([
      expect.objectContaining({
        conversationId: `chatgpt:conv:${TARGET.id}`,
        title: TARGET.title,
        url: `https://chatgpt.com/c/${TARGET.id}`,
      }),
    ]);
    expect(document.querySelector(PICKER)).toBeNull();
  });

  it('keeps the Project route of a row inside a Project', async () => {
    sidebar.move(TARGET.id, `/g/g-p-67ab12cd34-trip/c/${TARGET.id}`);
    const menu = sidebar.openMenu(TARGET.id);
    await nextPass();

    menu.querySelector<HTMLElement>(ENTRY)!.click();
    pick('Work');
    await settle(20);

    expect(stored('f1')[0].url).toBe(`https://chatgpt.com/g/g-p-67ab12cd34-trip/c/${TARGET.id}`);
  });

  it('reaches a menu whose content renders after its trigger opens', async () => {
    const menu = sidebar.openMenu(TARGET.id);
    const portal = menu.closest('body > *')!;
    portal.remove();
    await nextPass();
    expect(menu.querySelector(ENTRY)).toBeNull();

    document.body.append(portal);
    await nextPass();
    await nextPass();

    expect(menu.querySelector(ENTRY)).not.toBeNull();
  });

  it('stops waiting for a menu that never renders', async () => {
    const trigger = sidebar.row(TARGET.id).querySelector('button[aria-haspopup="menu"]')!;
    trigger.setAttribute('aria-expanded', 'true');
    for (let frame = 0; frame < 12; frame += 1) await nextPass();

    const frames = vi.spyOn(window, 'requestAnimationFrame');
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(frames).not.toHaveBeenCalled();
    frames.mockRestore();
  });

  it('closes the picker on Escape without filing anything', async () => {
    const menu = sidebar.openMenu(TARGET.id);
    await nextPass();
    menu.querySelector<HTMLElement>(ENTRY)!.click();
    const writes = memory.writes.length;

    picker()
      .querySelector('.dialog')!
      .dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    await settle(20);

    expect(document.querySelector(PICKER)).toBeNull();
    expect(memory.writes.length).toBe(writes);
  });

  it('narrows folders by path as the user types', async () => {
    const menu = sidebar.openMenu(TARGET.id);
    await nextPass();
    menu.querySelector<HTMLElement>(ENTRY)!.click();

    const search = picker().querySelector<HTMLInputElement>('.search')!;
    search.value = 'work / tri';
    search.dispatchEvent(new Event('input'));

    const shown = [...picker().querySelectorAll('.item')].map((item) =>
      item.getAttribute('aria-label'),
    );
    expect(shown).toEqual(['Work / Trips']);
  });

  it('leaves no entry or picker behind when turned off', async () => {
    const menu = sidebar.openMenu(TARGET.id);
    await nextPass();
    menu.querySelector<HTMLElement>(ENTRY)!.click();
    expect(document.querySelector(PICKER)).not.toBeNull();

    await scope.dispose();

    expect(menu.querySelector(ENTRY)).toBeNull();
    expect(document.querySelector(PICKER)).toBeNull();
  });
});
