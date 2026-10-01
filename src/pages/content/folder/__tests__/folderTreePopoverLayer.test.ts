/**
 * The folder menu in a body-level popover layer, for a tree whose container
 * transforms or clips it (AI Studio's nav). The layer must behave like the
 * in-tree menu: same actions, outside click and Escape close it, and it goes
 * away with the tree.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

import { POPOVER_LAYER_HOST_CLASS } from '../floatingTree/popoverLayer';
import { type TreeActions, cls } from '../floatingTree/shared';
import { type FolderTreeController, mountFolderTree } from '../floatingTree/treeController';
import type { FolderData } from '../types';

vi.mock('@/utils/i18n', () => ({ getTranslationSyncUnsafe: (key: string) => key }));

const SURFACE_MARKER = 'data-gv-shadow-surface';
const mounted: Array<{ tree: FolderTreeController; host: HTMLElement }> = [];

afterEach(() => {
  for (const { tree, host } of mounted.splice(0)) {
    tree.destroy();
    host.remove();
  }
  document.documentElement.removeAttribute('data-gv-scheme');
  document.body.classList.remove('gv-rtl');
});

const data: FolderData = {
  folders: [
    { id: 'a', name: 'Alpha', parentId: null, isExpanded: true, createdAt: 1, updatedAt: 1 },
    { id: 'b', name: 'Beta', parentId: null, isExpanded: true, createdAt: 2, updatedAt: 2 },
  ],
  folderContents: { a: [], b: [] },
};

function mount(options: { layer?: boolean; actions?: TreeActions } = {}) {
  const host = document.createElement('div');
  const root = host.attachShadow({ mode: 'open' });
  const body = document.createElement('div');
  root.appendChild(body);
  document.body.appendChild(host);
  const tree = mountFolderTree({
    body,
    boundary: host,
    focusRoot: root,
    data,
    rootBucketId: 'root',
    conversationSortMode: 'manual',
    actions: options.actions ?? {},
    site: { folderMenuButton: { labelKey: 'folder_settings' } },
    ...(options.layer === false ? {} : { popoverLayer: { css: '' } }),
  });
  mounted.push({ tree, host });
  return { root, tree };
}

const layers = () => document.querySelectorAll<HTMLElement>(`.${POPOVER_LAYER_HOST_CLASS}`);
const layerRoot = () => layers()[0].shadowRoot!;
const menuIn = (root: ShadowRoot) => root.querySelector<HTMLElement>(`.${cls('context-menu')}`);

function menuButton(root: ShadowRoot, folderId: string): HTMLButtonElement {
  return root
    .querySelector(`.${cls('folder-header')}[data-folder-id="${folderId}"]`)!
    .querySelector<HTMLButtonElement>(`.${cls('icon-button--menu')}`)!;
}

/** A pointer click on the ⋮ button; `detail: 0` is Enter or Space on it. */
function openMenu(root: ShadowRoot, folderId: string, detail = 1): void {
  menuButton(root, folderId).dispatchEvent(
    new MouseEvent('click', { bubbles: true, composed: true, detail }),
  );
}

function menuItem(labelKey: string): HTMLButtonElement {
  return Array.from(layerRoot().querySelectorAll<HTMLButtonElement>(`.${cls('menu-item')}`)).find(
    (item) => item.textContent === labelKey,
  )!;
}

const escape = () =>
  document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));

describe('folder menu in a popover layer', () => {
  it('renders the menu in a surface on document.body instead of in the tree', () => {
    const { root } = mount();
    openMenu(root, 'a');

    expect(layers()).toHaveLength(1);
    expect(layers()[0].parentElement).toBe(document.body);
    expect(menuIn(layerRoot())).not.toBeNull();
    expect(menuIn(root)).toBeNull();
  });

  it('marks the layer for the key guard and mirrors the page scheme and direction', () => {
    document.documentElement.setAttribute('data-gv-scheme', 'dark');
    document.body.classList.add('gv-rtl');
    mount();
    const host = layers()[0];

    expect(host.hasAttribute(SURFACE_MARKER)).toBe(true);
    expect(host.getAttribute('data-gv-scheme')).toBe('dark');
    expect(host.hasAttribute('data-gv-rtl')).toBe(true);
  });

  it('runs the chosen action from the layer', () => {
    const onToggleFolderPinned = vi.fn();
    const { root } = mount({ actions: { onToggleFolderPinned } });
    openMenu(root, 'b');
    menuItem('floatingPanelPinFolder').click();

    expect(onToggleFolderPinned).toHaveBeenCalledWith('b');
    expect(menuIn(layerRoot())).toBeNull();
  });

  it('stays open for a click on the menu outside its items, and closes for one outside', () => {
    const { root } = mount();
    openMenu(root, 'a');

    layerRoot()
      .querySelector<HTMLElement>(`.${cls('menu-divider')}`)!
      .dispatchEvent(new MouseEvent('click', { bubbles: true, composed: true }));
    expect(menuIn(layerRoot())).not.toBeNull();

    document.body.click();
    expect(menuIn(layerRoot())).toBeNull();
  });

  it('closes on Escape', () => {
    const { root } = mount();
    openMenu(root, 'a');
    escape();

    expect(menuIn(layerRoot())).toBeNull();
  });

  it('takes focus when opened from the keyboard, and gives it back on Escape', () => {
    const { root } = mount();
    openMenu(root, 'a', 0);

    expect(layerRoot().activeElement).toBe(layerRoot().querySelector(`.${cls('menu-item')}`));
    escape();
    expect(root.activeElement).toBe(menuButton(root, 'a'));
  });

  it('leaves focus alone when opened with the pointer', () => {
    const { root } = mount();
    openMenu(root, 'a');

    expect(layerRoot().activeElement).toBeNull();
  });

  it('empties the layer when another account resets the tree', () => {
    const { root, tree } = mount();
    openMenu(root, 'a');
    tree.reset({ folders: [], folderContents: {} });

    expect(menuIn(layerRoot())).toBeNull();
  });

  it('removes its layer with the tree, every time', () => {
    for (let index = 0; index < 3; index++) {
      const { root } = mount();
      openMenu(root, 'a');
      const { tree, host } = mounted.pop()!;
      tree.destroy();
      host.remove();
    }

    expect(layers()).toHaveLength(0);
  });
});

describe('folder menu without a popover layer', () => {
  it('stays in the tree and adds nothing to the page', () => {
    const { root } = mount({ layer: false });
    openMenu(root, 'a');

    expect(menuIn(root)).not.toBeNull();
    expect(layers()).toHaveLength(0);
  });

  it('also closes on Escape', () => {
    const { root } = mount({ layer: false });
    openMenu(root, 'a');
    escape();

    expect(menuIn(root)).toBeNull();
  });
});
