import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { StorageKeys } from '@/core/types/common';

import { SIDEBAR_TREE_HOST_CLASS } from '../sidebarTree';
import { createFolderViewHarness, resetFolderViewBrowserMocks } from './folderViewHarness';
import { sidebarTree } from './sidebarTreeDriver';

vi.mock('webextension-polyfill', () => ({ default: chrome }));

vi.mock('@/utils/i18n', () => ({
  getTranslationSync: (key: string) => key,
  getTranslationSyncUnsafe: (key: string) => key,
  initI18n: () => Promise.resolve(),
}));

describe('folder tree indentation', () => {
  let harness: Awaited<ReturnType<typeof createFolderViewHarness>>;

  beforeEach(async () => {
    vi.useFakeTimers();
    resetFolderViewBrowserMocks();
    harness = await createFolderViewHarness({
      folders: ['root', 'child', 'legacy-deep'].map((id, index, ids) => ({
        id,
        name: id,
        parentId: index ? ids[index - 1] : null,
        isExpanded: true,
        createdAt: 1,
        updatedAt: 1,
      })),
      folderContents: {
        child: [{ conversationId: 'a', title: 'A', url: '/app/a', addedAt: 1 }],
        'legacy-deep': [{ conversationId: 'b', title: 'B', url: '/app/b', addedAt: 1 }],
      },
    });
  });

  afterEach(() => {
    harness?.destroy();
    document.body.innerHTML = '';
    localStorage.clear();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  /** The nesting step each tree level indents by. */
  const step = () =>
    harness.runtime
      .panel!.querySelector<HTMLElement>(`.${SIDEBAR_TREE_HOST_CLASS}`)!
      .style.getPropertyValue('--gv-tree-step');

  it('starts at the 12px step of the default indent', () => {
    expect(step()).toBe('12px');
  });

  // The setting runs from -8 to 32 on top of a 20px base step.
  it.each([
    [-40, '12px'],
    [64, '52px'],
    [0, '20px'],
    [16, '36px'],
    ['invalid', '12px'],
  ])('clamps indent %s to a %s step without touching data', (setting, expected) => {
    const originalData = structuredClone(harness.store.data);
    harness.treeView.applySettings(
      { [StorageKeys.GV_FOLDER_TREE_INDENT]: { newValue: setting } },
      'sync',
    );

    expect(step()).toBe(expected);
    expect(sidebarTree(harness.runtime.panel).outline()).toEqual([
      'root',
      '  child',
      '    legacy-deep',
      '      · B',
      '    · A',
    ]);
    expect(harness.store.data).toEqual(originalData);
  });
});
