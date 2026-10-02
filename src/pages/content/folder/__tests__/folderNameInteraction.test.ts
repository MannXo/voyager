import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { deepActiveElement } from '../floatingTree/__tests__/treeDriver';
import { createFolderViewHarness, resetFolderViewBrowserMocks } from './folderViewHarness';
import { sidebarTree } from './sidebarTreeDriver';

vi.mock('webextension-polyfill', () => ({ default: chrome }));

vi.mock('@/utils/i18n', () => ({
  getTranslationSync: (key: string) => key,
  getTranslationSyncUnsafe: (key: string) => key,
  initI18n: () => Promise.resolve(),
}));

describe('folder name click/double-click interaction', () => {
  let harness: Awaited<ReturnType<typeof createFolderViewHarness>>;

  beforeEach(async () => {
    vi.useFakeTimers();
    vi.clearAllMocks();
    resetFolderViewBrowserMocks();
    harness = await createFolderViewHarness({
      folders: [
        {
          id: 'folder-1',
          name: 'Folder 1',
          parentId: null,
          isExpanded: false,
          createdAt: 1,
          updatedAt: 1,
        },
      ],
      folderContents: {},
    });
  });

  afterEach(() => {
    harness?.destroy();
    document.body.innerHTML = '';
    localStorage.clear();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  const tree = () => sidebarTree(harness.runtime.panel);
  const clickName = (detail: number) =>
    tree()
      .folderNameElement('Folder 1')
      .dispatchEvent(
        new MouseEvent('click', { bubbles: true, cancelable: true, composed: true, detail }),
      );

  it('toggles folder on single click after delay', () => {
    clickName(1);

    vi.advanceTimersByTime(219);
    expect(harness.store.data.folders[0].isExpanded).toBe(false);
    expect(tree().isExpanded('Folder 1')).toBe(false);

    vi.advanceTimersByTime(1);
    expect(harness.store.data.folders[0].isExpanded).toBe(true);
    expect(tree().isExpanded('Folder 1')).toBe(true);
    expect(tree().nameInput()).toBeNull();
  });

  it('renames folder on double click without toggle flicker', async () => {
    clickName(1);
    clickName(2);
    tree().startRename('Folder 1');

    vi.advanceTimersByTime(220);
    // The name field replaces the name; the folder stays collapsed.
    expect(harness.store.data.folders[0].isExpanded).toBe(false);
    await vi.advanceTimersByTimeAsync(20);
    const input = tree().nameInput()!;
    expect(input.value).toBe('Folder 1');
    expect(deepActiveElement()).toBe(input);
    tree().typeName('  Renamed  ');
    tree().pressInInput('Enter');
    await vi.advanceTimersByTimeAsync(0);

    expect(harness.store.data.folders[0]).toMatchObject({ name: 'Renamed', isExpanded: false });
    expect(harness.saved.folders[0].name).toBe('Renamed');
    expect(harness.adapter.saveData).toHaveBeenCalledTimes(1);
    expect(tree().nameInput()).toBeNull();
    expect(tree().folderNames()).toEqual(['Renamed']);
  });
});
