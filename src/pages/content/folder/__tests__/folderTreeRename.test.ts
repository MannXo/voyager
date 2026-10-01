/**
 * Inline rename in the shared folder tree. While the input has focus, the
 * controller defers renders, so the folder the form was opened on can be
 * stale by the time the user submits. The owner compares against live data.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

import { cls } from '../floatingTree/shared';
import { type FolderTreeController, mountFolderTree } from '../floatingTree/treeController';
import type { FolderData } from '../types';

vi.mock('@/utils/i18n', () => ({ getTranslationSyncUnsafe: (key: string) => key }));

const mounted: Array<{ tree: FolderTreeController; host: HTMLElement }> = [];

afterEach(() => {
  for (const { tree, host } of mounted.splice(0)) {
    tree.destroy();
    host.remove();
  }
});

function named(name: string): FolderData {
  return {
    folders: [{ id: 'a', name, parentId: null, isExpanded: true, createdAt: 1, updatedAt: 1 }],
    folderContents: { a: [] },
  };
}

function mount(data: FolderData, onRenameFolder: (id: string, name: string) => void) {
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
    actions: { onRenameFolder },
  });
  mounted.push({ tree, host });
  return { root, tree };
}

function openRename(root: ShadowRoot): HTMLInputElement {
  root
    .querySelector<HTMLElement>(`.${cls('folder-name')}`)!
    .dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
  const input = root.querySelector<HTMLInputElement>(`.${cls('inline-input')}`)!;
  input.focus();
  return input;
}

function submit(input: HTMLInputElement, value: string): void {
  input.value = value;
  input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
}

describe('inline rename', () => {
  it('asks for the typed name even when it matches the name the form opened with', () => {
    const onRenameFolder = vi.fn();
    const { root, tree } = mount(named('Draft'), onRenameFolder);
    const input = openRename(root);

    // Another tab renames the folder while the form is open; the render waits.
    tree.update(named('Synced'));
    submit(input, 'Draft');

    expect(onRenameFolder).toHaveBeenCalledWith('a', 'Draft');
  });

  it('leaves an unchanged name to the owner to ignore', () => {
    const onRenameFolder = vi.fn();
    const { root } = mount(named('Same'), onRenameFolder);
    submit(openRename(root), 'Same');

    expect(onRenameFolder).toHaveBeenCalledWith('a', 'Same');
  });

  it('does not ask for an empty name', () => {
    const onRenameFolder = vi.fn();
    const { root } = mount(named('Kept'), onRenameFolder);
    submit(openRename(root), '   ');

    expect(onRenameFolder).not.toHaveBeenCalled();
  });
});
