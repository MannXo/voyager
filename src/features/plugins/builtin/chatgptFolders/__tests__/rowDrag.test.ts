// @vitest-environment jsdom
// @vitest-environment-options { "url": "https://chatgpt.com/" }
/**
 * Dragging a row of ChatGPT's own sidebar onto a Voyager folder, against the
 * real store, section and panel. jsdom has no DragEvent or DataTransfer, so a
 * drag is an Event carrying the shared tree driver's fake transfer.
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { StorageKeys } from '@/core/types/common';
import type { FolderData } from '@/core/types/folder';
import { ROOT_CONVERSATIONS_ID } from '@/features/folder/constants';
import { PluginScope } from '@/features/plugins/runtime/pluginScope';
import {
  type FakeTransfer,
  fakeTransfer,
  treeDriver,
} from '@/pages/content/folder/floatingTree/__tests__/treeDriver';
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

const KEY = StorageKeys.FOLDER_DATA_CHATGPT;
const ROWS = makeRows(4);
const TARGET = ROWS[2];
const FILED = {
  conversationId: `chatgpt:conv:${TARGET.id}`,
  title: TARGET.title,
  url: `https://chatgpt.com/c/${TARGET.id}`,
};
const DATA: FolderData = {
  folders: [
    {
      id: 'work',
      name: 'Work',
      parentId: null,
      isExpanded: true,
      sortIndex: 0,
      createdAt: 1,
      updatedAt: 1,
    },
    {
      id: 'trips',
      name: 'Trips',
      parentId: null,
      isExpanded: true,
      sortIndex: 1,
      createdAt: 1,
      updatedAt: 1,
    },
  ],
  folderContents: { work: [], trips: [], [ROOT_CONVERSATIONS_ID]: [] },
};

let memory: MemoryStorage;
let originalStorage: typeof chrome.storage;
let scope: PluginScope;
let sidebar: SidebarFixture;

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
  memory.values.local.set(KEY, structuredClone(DATA));
  scope = new PluginScope();
  sidebar = mountSidebarFixture(ROWS);
});

afterEach(async () => {
  await scope.dispose();
  sidebar.destroy();
  document.body.replaceChildren();
  globalThis.chrome.storage = originalStorage;
});

async function nextPass(): Promise<void> {
  await settle(5);
  await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
  await settle(20);
}

function shadowOf(selector: string): ShadowRoot {
  const host = document.querySelector<HTMLElement>(selector);
  if (!host?.shadowRoot) throw new Error(`${selector} is not mounted`);
  return host.shadowRoot;
}

async function activate() {
  await activateChatGptFolders(scope);
  await nextPass();
  const root = shadowOf('.gv-chatgpt-folder-section');
  return { view: treeDriver({ root, rootBucketId: ROOT_CONVERSATIONS_ID }), root };
}

function dragEvent(type: string, transfer: FakeTransfer): Event {
  const event = new Event(type, { bubbles: true, cancelable: true, composed: true });
  Object.defineProperty(event, 'dataTransfer', { value: transfer });
  return event;
}

function link(id: string): HTMLAnchorElement {
  return sidebar.row(id).querySelector('a')!;
}

/** Presses a row's title and starts a drag, as the browser does; returns what the drag carries. */
function dragSidebarRow(id: string): FakeTransfer {
  const title = link(id).querySelector('[data-thread-title]')!;
  title.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, button: 0 }));
  const transfer = fakeTransfer();
  // The link is the drag source: its title span is `draggable="false"`.
  link(id).dispatchEvent(dragEvent('dragstart', transfer));
  return transfer;
}

function endDrag(id: string, transfer: FakeTransfer): void {
  link(id).dispatchEvent(dragEvent('dragend', transfer));
}

function stored(): FolderData {
  return memory.values.local.get(KEY) as FolderData;
}

function folderWrites(): number {
  return memory.writes.filter((write) => write.area === 'local' && write.key === KEY).length;
}

function status(root: ShadowRoot): string {
  const line = root.querySelector<HTMLElement>('[role="status"]')!;
  return line.hidden ? '' : (line.textContent ?? '');
}

describe('dragging a ChatGPT sidebar row onto a folder', () => {
  it('files the row once into the sidebar section folder it is dropped on, as Move to folder does', async () => {
    const { view, root } = await activate();

    const transfer = dragSidebarRow(TARGET.id);
    expect(view.drop(view.folderRow('Trips'), transfer)).toBe(true);
    endDrag(TARGET.id, transfer);
    await nextPass();

    expect(stored().folderContents.trips).toEqual([expect.objectContaining(FILED)]);
    expect(stored().folderContents.work).toEqual([]);
    expect(view.outline()).toEqual(['Work', 'Trips', `  · ${TARGET.title}`]);
    expect(status(root)).toBe('Added to folder.');
    expect(link(TARGET.id).getAttribute('draggable')).toBe('false');
  });

  it('writes nothing and says so when the row is dropped on the folder it is already in', async () => {
    memory.values.local.set(KEY, {
      ...structuredClone(DATA),
      folderContents: { ...DATA.folderContents, trips: [{ ...FILED, addedAt: 1, sortIndex: 0 }] },
    });
    const { view, root } = await activate();
    const before = folderWrites();

    view.drop(view.folderRow('Trips'), dragSidebarRow(TARGET.id));
    await nextPass();

    expect(folderWrites()).toBe(before);
    expect(stored().folderContents.trips).toEqual([{ ...FILED, addedAt: 1, sortIndex: 0 }]);
    expect(status(root)).toBe('Already in this folder.');
  });

  it('files a row dropped on a folder in the floating panel', async () => {
    memory.values.local.set(StorageKeys.CHATGPT_FOLDER_PANEL, { open: true });
    await activate();
    const panel = treeDriver({
      root: shadowOf('.gv-floating-folder-panel'),
      rootBucketId: ROOT_CONVERSATIONS_ID,
    });

    panel.drop(panel.folderRow('Work'), dragSidebarRow(TARGET.id));
    await nextPass();

    expect(stored().folderContents.work).toEqual([expect.objectContaining(FILED)]);
  });

  it('still moves a folder row dropped on another folder', async () => {
    memory.values.local.set(KEY, {
      ...structuredClone(DATA),
      folderContents: { ...DATA.folderContents, work: [{ ...FILED, addedAt: 1, sortIndex: 0 }] },
    });
    const { view } = await activate();

    view.drop(view.folderRow('Trips'), view.dragRow('work', TARGET.title));
    await nextPass();

    expect(stored().folderContents.work).toEqual([]);
    expect(stored().folderContents.trips).toEqual([expect.objectContaining(FILED)]);
  });

  it.each([
    ['a javascript: URL', { ...FILED, url: 'javascript:alert(1)' }],
    [
      'a Gemini conversation',
      { conversationId: 'c_abc', url: 'https://gemini.google.com/app/abc' },
    ],
    ['a URL naming another conversation', { ...FILED, url: 'https://chatgpt.com/c/other-id' }],
    ['a ChatGPT link on another site', { ...FILED, url: `https://evil.example/c/${TARGET.id}` }],
  ])('files nothing for a dropped payload with %s', async (_kind, fields) => {
    const { view } = await activate();
    const before = folderWrites();
    const payload = { type: 'conversation', title: 'Dropped', ...fields };

    view.drop(
      view.folderRow('Work'),
      fakeTransfer({ 'application/json': JSON.stringify(payload) }),
    );
    await nextPass();

    expect(folderWrites()).toBe(before);
    expect(stored()).toEqual(DATA);
  });

  it('files nothing for a plain link dragged in from elsewhere', async () => {
    const { view } = await activate();
    const before = folderWrites();

    view.drop(
      view.folderRow('Work'),
      fakeTransfer({ 'text/uri-list': `https://chatgpt.com/c/${TARGET.id}` }),
    );
    await nextPass();

    expect(folderWrites()).toBe(before);
  });

  it('leaves conversation links outside the sidebar alone', async () => {
    await activate();
    const inChat = document.createElement('a');
    inChat.href = `/c/${TARGET.id}`;
    inChat.setAttribute('draggable', 'false');
    document.body.append(inChat);

    inChat.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, button: 0 }));
    const transfer = fakeTransfer();
    inChat.dispatchEvent(dragEvent('dragstart', transfer));

    expect(inChat.getAttribute('draggable')).toBe('false');
    expect(transfer.types).toEqual([]);
  });

  it.each(['pointerup', 'pointercancel'])(
    'gives a row link back its draggable when a press ends in %s without a drag',
    async (end) => {
      await activate();
      const row = link(TARGET.id);

      row.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, button: 0 }));
      expect(row.getAttribute('draggable')).toBe('true');
      row.dispatchEvent(new PointerEvent(end, { bubbles: true, button: 0 }));

      expect(row.getAttribute('draggable')).toBe('false');
    },
  );

  it('stops making rows draggable and restores a pressed one when turned off', async () => {
    await activate();
    const pressed = link(TARGET.id);
    pressed.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, button: 0 }));

    await scope.dispose();

    expect(pressed.getAttribute('draggable')).toBe('false');
    expect(dragSidebarRow(ROWS[0].id).types).toEqual([]);
    expect(link(ROWS[0].id).getAttribute('draggable')).toBe('false');
  });
});
