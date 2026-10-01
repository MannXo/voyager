/**
 * The shared folder tree on stored or imported data whose folder structure is
 * not clean. Every folder must render exactly once, so neither it nor the
 * conversations it holds go missing.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

import { cls } from '../floatingTree/shared';
import { type FolderTreeController, mountFolderTree } from '../floatingTree/treeController';
import type { Folder, FolderData } from '../types';

vi.mock('@/utils/i18n', () => ({ getTranslationSyncUnsafe: (key: string) => key }));

const ROOT = 'root-bucket';
const mounted: Array<{ tree: FolderTreeController; host: HTMLElement }> = [];

afterEach(() => {
  for (const { tree, host } of mounted.splice(0)) {
    tree.destroy();
    host.remove();
  }
});

function folder(id: string, parentId: unknown, extra: Partial<Folder> = {}): Folder {
  return {
    id,
    name: `Name ${id}`,
    parentId: parentId as string | null,
    isExpanded: true,
    createdAt: 1,
    updatedAt: 1,
    ...extra,
  };
}

function withoutParent(id: string): Folder {
  const { parentId: _omitted, ...rest } = folder(id, null);
  return rest as Folder;
}

function mount(data: FolderData): ShadowRoot {
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
    rootBucketId: ROOT,
    conversationSortMode: 'manual',
    actions: {},
  });
  mounted.push({ tree, host });
  return root;
}

/** Rendered folders as `depth:id`, in document order. */
function rendered(root: ShadowRoot): string[] {
  return Array.from(
    root.querySelectorAll<HTMLElement>(`.${cls('folder')}`),
    (node) =>
      `${node.dataset.depth}:${node.querySelector(`.${cls('folder-header')}`)?.getAttribute('data-folder-id')}`,
  );
}

function bucketsOf(...ids: string[]): FolderData['folderContents'] {
  return Object.fromEntries(
    ids.map((id) => [
      id,
      [{ conversationId: `in-${id}`, title: `In ${id}`, url: `https://x.test/${id}`, addedAt: 1 }],
    ]),
  );
}

const shownConversations = (root: ShadowRoot) =>
  Array.from(
    root.querySelectorAll<HTMLElement>(`.${cls('conv')}`),
    (row) => row.dataset.conversationId,
  ).sort();

describe('folders without a usable parent', () => {
  it('renders a folder whose parent is null, missing or empty at the root', () => {
    const root = mount({
      folders: [folder('a', null), withoutParent('b'), folder('c', '')],
      folderContents: bucketsOf('a', 'b', 'c'),
    });
    expect(rendered(root)).toEqual(['0:a', '0:b', '0:c']);
    expect(shownConversations(root)).toEqual(['in-a', 'in-b', 'in-c']);
  });

  it('renders a folder whose parent no longer exists at the root, with its subfolders', () => {
    const root = mount({
      folders: [folder('orphan', 'deleted-parent'), folder('child', 'orphan')],
      folderContents: bucketsOf('orphan', 'child'),
    });
    expect(rendered(root)).toEqual(['0:orphan', '1:child']);
    expect(shownConversations(root)).toEqual(['in-child', 'in-orphan']);
  });
});
