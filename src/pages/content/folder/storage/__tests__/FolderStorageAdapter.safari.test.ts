import { beforeEach, describe, expect, it, vi } from 'vitest';
import browser from 'webextension-polyfill';

import type { FolderData } from '../../types';
import { SafariFolderAdapter } from '../FolderStorageAdapter';

const storageState = vi.hoisted(() => ({ values: {} as Record<string, unknown> }));

vi.mock('webextension-polyfill', () => ({
  default: {
    storage: {
      local: {
        get: vi.fn(async (key: string) => ({ [key]: storageState.values[key] })),
        set: vi.fn(async (items: Record<string, unknown>) => {
          Object.assign(storageState.values, items);
        }),
        remove: vi.fn(async (key: string) => {
          delete storageState.values[key];
        }),
      },
    },
  },
}));

const folderData: FolderData = {
  folders: [
    {
      id: 'folder-1',
      name: 'Research',
      parentId: null,
      isExpanded: true,
      createdAt: 1,
      updatedAt: 2,
    },
  ],
  folderContents: { 'folder-1': [] },
};

describe('SafariFolderAdapter', () => {
  beforeEach(() => {
    storageState.values = {};
    localStorage.clear();
    vi.clearAllMocks();
  });

  it('loads folder objects written by the cloud-sync popup', async () => {
    storageState.values.gvFolderData = folderData;

    await expect(new SafariFolderAdapter().loadData('gvFolderData')).resolves.toEqual(folderData);
  });

  it('keeps reading legacy JSON-string folder data', async () => {
    storageState.values.gvFolderData = JSON.stringify(folderData);

    await expect(new SafariFolderAdapter().loadData('gvFolderData')).resolves.toEqual(folderData);
  });

  it('stores folder data in the same object shape used by other browsers and the popup', async () => {
    await expect(new SafariFolderAdapter().saveData('gvFolderData', folderData)).resolves.toBe(
      true,
    );

    expect(storageState.values.gvFolderData).toEqual(folderData);
  });

  it('rejects a failed read instead of answering from the page copy or as absent', async () => {
    const adapter = new SafariFolderAdapter();
    const unavailable = new Error('storage unavailable');
    vi.mocked(browser.storage.local.get)
      .mockRejectedValueOnce(unavailable)
      .mockRejectedValueOnce(unavailable);
    vi.spyOn(console, 'error').mockImplementation(() => {});

    await expect(adapter.loadData('gvFolderData')).rejects.toThrow('storage unavailable');
    localStorage.setItem('gvFolderData', JSON.stringify(folderData));
    await expect(adapter.loadData('gvFolderData')).rejects.toThrow('storage unavailable');
  });
});
