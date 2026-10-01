// @vitest-environment jsdom
// @vitest-environment-options { "url": "https://chatgpt.com/" }
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { StorageKeys } from '@/core/types/common';
import { PluginScope } from '@/features/plugins/runtime/pluginScope';
import { initI18n } from '@/utils/i18n';

import { CHATGPT_FOLDERS_GUIDE_DEBUG_EVENT, CHATGPT_FOLDERS_GUIDE_ID } from '../chatgptFolderGuide';
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
const ROWS = makeRows(6);
/** Longer than the coachmark's entrance/exit animation. */
const ANIMATION_MS = 260;
const RECENTS = '[data-chatgpt-project-conversation-drop-target]';

let memory: MemoryStorage;
let originalStorage: typeof chrome.storage;
let scope: PluginScope;
let sidebar: SidebarFixture;

async function nextPass(): Promise<void> {
  await settle(5);
  await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
  await settle(20);
}

const animation = () => new Promise<void>((resolve) => setTimeout(resolve, ANIMATION_MS));

function bubble(): HTMLElement | null {
  return document.querySelector<HTMLElement>('.gv-coach');
}

function seen(): unknown {
  return memory.values.sync.get(StorageKeys.COACHMARKS_SEEN);
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
  memory.values.sync.delete(StorageKeys.COACHMARKS_SEEN);
  originalStorage = globalThis.chrome.storage;
  globalThis.chrome.storage = memory.api;
  scope = new PluginScope();
  sidebar = mountSidebarFixture(ROWS);
});

afterEach(async () => {
  await scope.dispose();
  await animation();
  sidebar.destroy();
  document.body.replaceChildren();
  document.documentElement.removeAttribute('dir');
  globalThis.chrome.storage = originalStorage;
  vi.restoreAllMocks();
});

async function activate(): Promise<void> {
  await activateChatGptFolders(scope);
  await nextPass();
}

describe('ChatGPT folders sidebar guide', () => {
  it('points at the section once it has rendered, and shows only once', async () => {
    await activate();

    const shown = bubble();
    expect(shown?.textContent).toContain('Your folders are in the sidebar');
    expect(shown?.classList.contains('gv-coach--rtl')).toBe(false);
    expect(document.querySelector(SECTION)?.isConnected).toBe(true);

    shown!.querySelector<HTMLButtonElement>('.gv-coach-dismiss')!.click();
    await animation();
    expect(bubble()).toBeNull();
    expect(seen()).toEqual([CHATGPT_FOLDERS_GUIDE_ID]);

    await scope.dispose();
    scope = new PluginScope();
    await activate();
    sidebar.rerenderList();
    await nextPass();
    expect(bubble()).toBeNull();
  });

  it('waits for the section instead of showing without it', async () => {
    const recents = sidebar.sidebar.querySelector(RECENTS)!;
    const parent = recents.parentElement!;
    recents.remove();
    await activate();
    expect(document.querySelector(SECTION)).toBeNull();
    expect(bubble()).toBeNull();

    parent.append(recents);
    await nextPass();
    expect(document.querySelector(SECTION)?.isConnected).toBe(true);
    expect(bubble()).not.toBeNull();
  });

  it('never opens over an open menu, and shows after it closes', async () => {
    const menu = sidebar.openMenu(ROWS[1].id);
    await activate();
    sidebar.rerenderList();
    await nextPass();
    expect(bubble()).toBeNull();

    menu.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    await nextPass();
    sidebar.rerenderList();
    await nextPass();
    expect(bubble()).not.toBeNull();
  });

  it('waits while the section is naming a new folder', async () => {
    const menu = sidebar.openMenu(ROWS[1].id);
    await activate();
    const root = document.querySelector<HTMLElement>(SECTION)!.shadowRoot!;
    root.querySelector<HTMLButtonElement>('[class*="icon-button--create"]')!.click();
    menu.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    await nextPass();
    sidebar.rerenderList();
    await nextPass();
    expect(root.querySelector('input')).not.toBeNull();
    expect(bubble()).toBeNull();

    root
      .querySelector('input')!
      .dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    sidebar.rerenderList();
    await nextPass();
    expect(root.querySelector('input')).toBeNull();
    expect(bubble()).not.toBeNull();
  });

  it('closes unseen when ChatGPT drops the section, and comes back with it', async () => {
    await activate();
    expect(bubble()).not.toBeNull();

    const recents = sidebar.sidebar.querySelector(RECENTS)!;
    const parent = recents.parentElement!;
    recents.remove();
    await nextPass();
    await animation();
    expect(bubble()).toBeNull();
    expect(seen()).toBeUndefined();

    parent.append(recents);
    await nextPass();
    expect(bubble()).not.toBeNull();
  });

  it('closes unseen and leaves nothing behind when turned off', async () => {
    await activate();
    expect(bubble()).not.toBeNull();

    await scope.dispose();
    await animation();
    expect(bubble()).toBeNull();
    expect(document.querySelector('.gv-coach-scrim')).toBeNull();
    expect(seen()).toBeUndefined();
  });

  it('lays itself out right to left on an RTL page', async () => {
    document.documentElement.setAttribute('dir', 'rtl');
    await activate();
    expect(bubble()?.classList.contains('gv-coach--rtl')).toBe(true);
  });

  it('shows again from the debug event after it was seen', async () => {
    memory.values.sync.set(StorageKeys.COACHMARKS_SEEN, [CHATGPT_FOLDERS_GUIDE_ID]);
    await activate();
    expect(bubble()).toBeNull();

    document.dispatchEvent(new Event(CHATGPT_FOLDERS_GUIDE_DEBUG_EVENT));
    await nextPass();
    expect(bubble()).not.toBeNull();
  });
});
