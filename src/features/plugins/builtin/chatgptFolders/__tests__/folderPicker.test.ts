import { afterEach, describe, expect, it, vi } from 'vitest';

import type { Folder, FolderData } from '@/core/types/folder';
import { sortFolders } from '@/features/folder/model/folderData';

import { FOLDER_PICKER_CLASS, openFolderPicker } from '../chatgptFolderPicker';

// The picker's listing and search before it read the folder index, copied verbatim.
function oldNormalizePath(value: string): string {
  return value
    .trim()
    .toLocaleLowerCase()
    .replace(/\s*\/\s*/g, '/');
}

function oldListFolders(folders: readonly Folder[]) {
  const options: Array<{ folder: Folder; level: number; path: string }> = [];
  const visit = (parentId: string | null, level: number, parentPath: string, seen: Set<string>) => {
    for (const folder of sortFolders(folders.filter((item) => item.parentId === parentId))) {
      if (seen.has(folder.id)) continue;
      const path = parentPath ? `${parentPath} / ${folder.name}` : folder.name;
      options.push({ folder, level, path });
      visit(folder.id, level + 1, path, new Set([...seen, folder.id]));
    }
  };
  visit(null, 0, '', new Set());
  return options;
}

type Row = { id: string; padding: string; label: string; path: string | null; name: string };

function expectedRows(folders: readonly Folder[], query: string): Row[] {
  const normalized = oldNormalizePath(query);
  return oldListFolders(folders)
    .filter((option) => oldNormalizePath(option.path).includes(normalized))
    .map(({ folder, level, path }) => ({
      id: folder.id,
      padding: `${level * 16 + 12}px`,
      label: path,
      path: level > 0 ? path : null,
      name: folder.name,
    }));
}

function root(): ShadowRoot {
  const host = document.querySelector<HTMLElement>(`.${FOLDER_PICKER_CLASS}`);
  if (!host?.shadowRoot) throw new Error('picker is not open');
  return host.shadowRoot;
}

function renderedRows(): Row[] {
  return [...root().querySelectorAll<HTMLButtonElement>('.item')].map((item) => ({
    id: item.dataset.folderId ?? '',
    padding: item.style.paddingInlineStart,
    label: item.getAttribute('aria-label') ?? '',
    path: item.querySelector('.path')?.textContent ?? null,
    name: item.querySelector('.name')?.textContent ?? '',
  }));
}

function type(query: string): void {
  const search = root().querySelector<HTMLInputElement>('.search')!;
  search.value = query;
  search.dispatchEvent(new Event('input'));
}

function seeded(seed: number): () => number {
  let state = seed;
  return () => {
    state = (state * 1103515245 + 12345) % 2147483648;
    return state / 2147483648;
  };
}

const NAMES = ['Work', 'work', 'Folder 2', 'folder 10', 'A / B', '  Spaced  ', 'Ä', 'x'];

/** Repeated ids, `null`/`undefined`/`''`/orphan/self parents, cycles, mixed sortIndex. */
function randomFolders(seed: number, size: number): Folder[] {
  const random = seeded(seed);
  const pick = <T>(items: readonly T[]): T => items[Math.floor(random() * items.length)];
  const ids = Array.from({ length: Math.max(2, Math.floor(size * 0.8)) }, (_, i) => `f${i}`);
  return Array.from({ length: size }, (_, i) => {
    const id = pick(ids);
    const roll = random();
    const parentId =
      roll < 0.25
        ? null
        : roll < 0.3
          ? (undefined as unknown as null)
          : roll < 0.35
            ? ''
            : roll < 0.4
              ? 'ghost'
              : roll < 0.43
                ? id
                : pick(ids);
    const indexRoll = random();
    return {
      id,
      name: `${pick(NAMES)}${random() < 0.4 ? ` ${i}` : ''}`,
      parentId,
      isExpanded: true,
      pinned: random() < 0.2 || undefined,
      sortIndex: indexRoll < 0.3 ? undefined : indexRoll < 0.4 ? -1 : Math.floor(random() * 4),
      createdAt: 1,
      updatedAt: 1,
    };
  });
}

const QUERIES = ['', 'w', 'WORK', ' work / folder ', 'a/b', 'folder 1', 'spaced', 'ä', 'zzz'];

afterEach(() => {
  for (const host of document.querySelectorAll(`.${FOLDER_PICKER_CLASS}`)) host.remove();
});

describe('ChatGPT folder picker listing', () => {
  it.each(Array.from({ length: 40 }, (_, i) => i))(
    'lists and searches random folders #%i as before',
    (seed) => {
      const folders = randomFolders(seed + 1, 3 + seed * 2);
      const data: FolderData = { folders, folderContents: {} };
      openFolderPicker(data, () => {});
      for (const query of [...QUERIES, '', ...[...QUERIES].reverse()]) {
        type(query);
        expect(renderedRows(), query).toEqual(expectedRows(folders, query));
        expect(!!root().querySelector('.empty')).toBe(expectedRows(folders, query).length === 0);
      }
    },
  );

  it('lists each record of a repeated id under its own parent, and cuts a path back to itself', () => {
    const folders: Folder[] = [
      { id: 'a', name: 'A1', parentId: null, isExpanded: true, createdAt: 1, updatedAt: 1 },
      { id: 'b', name: 'B', parentId: 'a', isExpanded: true, createdAt: 1, updatedAt: 1 },
      { id: 'a', name: 'A2', parentId: 'b', isExpanded: true, createdAt: 1, updatedAt: 1 },
      { id: 'c', name: 'C', parentId: 'ghost', isExpanded: true, createdAt: 1, updatedAt: 1 },
    ];
    openFolderPicker({ folders, folderContents: {} }, () => {});
    expect(renderedRows().map((row) => row.label)).toEqual(['A1', 'A1 / B']);
  });

  it('selects the folder of a row reused across searches', () => {
    const onSelect = vi.fn();
    const folders = randomFolders(5, 12);
    openFolderPicker({ folders, folderContents: {} }, onSelect);
    const first = root().querySelector<HTMLButtonElement>('.item')!;
    type('zzz');
    type('');
    expect(root().querySelector('.item')).toBe(first);
    first.click();
    expect(onSelect).toHaveBeenCalledTimes(1);
    expect(onSelect).toHaveBeenCalledWith(first.dataset.folderId);
    expect(document.querySelector(`.${FOLDER_PICKER_CLASS}`)).toBeNull();
  });
});
