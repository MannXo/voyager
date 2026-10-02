import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import browser from 'webextension-polyfill';

import { accountIsolationService } from '@/core/services/AccountIsolationService';

import { FolderRepository } from '../FolderRepository';
import { GEMINI_FOLDER_CONFIG } from '../platformFolderConfig';
import { LocalStorageFolderAdapter } from '../storage/FolderStorageAdapter';
import type { FolderData } from '../types';

vi.mock('webextension-polyfill', () => ({
  default: {
    storage: {
      local: { get: vi.fn(), set: vi.fn(), remove: vi.fn() },
      onChanged: { addListener: vi.fn(), removeListener: vi.fn() },
    },
    runtime: { id: 'test-extension-id' },
  },
}));

vi.mock('@/core/utils/browser', () => ({ isSafari: () => false, isFirefox: () => false }));

const KEY = 'gvFolderData';
const PRIMARY = 'gvBackup_gemini-folders_primary';
const EMERGENCY = 'gvBackup_gemini-folders_emergency';
const QUOTA = 5 * 1024 * 1024;

function library(): FolderData {
  const folders = Array.from({ length: 1000 }, (_, i) => ({
    id: `f-${i}`,
    name: `Folder ${i}`,
    parentId: null,
    isExpanded: true,
    sortIndex: i,
    createdAt: 1,
    updatedAt: 1,
  }));
  const folderContents = Object.fromEntries(
    folders.map((folder, i) => [
      folder.id,
      Array.from({ length: 10 }, (_, j) => {
        const id = (i * 10 + j).toString(16).padStart(12, '0');
        return {
          conversationId: `c_${id}`,
          title: `Conversation ${'x'.repeat(64)}`,
          url: `https://gemini.google.com/app/${id}`,
          addedAt: 1,
          sortIndex: j,
        };
      }),
    ]),
  );
  return { folders, folderContents };
}

describe('FolderRepository backup quota safety', () => {
  let durable: Record<string, unknown>;
  let values: Map<string, string>;
  let repository: FolderRepository;
  const onSaveFailed = vi.fn();
  const onRecovery = vi.fn();

  function createRepository(): FolderRepository {
    repository = new FolderRepository(GEMINI_FOLDER_CONFIG, new LocalStorageFolderAdapter(), {
      onChange: vi.fn(),
      onRecovery,
      onExternalChange: vi.fn(),
      onAccountReleased: vi.fn(),
      isEnabled: () => true,
      onSaveFailed,
    });
    return repository;
  }

  beforeEach(() => {
    vi.clearAllMocks();
    durable = {};
    values = new Map();
    localStorage.clear();
    const setItem = localStorage.setItem.bind(localStorage);
    vi.spyOn(localStorage, 'setItem').mockImplementation((key, value) => {
      const next = new Map(values).set(key, value);
      const size = [...next].reduce((sum, [name, stored]) => sum + name.length + stored.length, 0);
      if (size > QUOTA) throw new DOMException('Storage full', 'QuotaExceededError');
      setItem(key, value);
      values.set(key, value);
    });
    const get = async (keys?: unknown): Promise<Record<string, unknown>> => {
      const names =
        typeof keys === 'string' ? [keys] : Array.isArray(keys) ? keys : Object.keys(durable);
      return Object.fromEntries(
        names.filter((key) => key in durable).map((key) => [key, durable[key]]),
      );
    };
    const set = async (items: Record<string, unknown>) => {
      Object.assign(durable, items);
    };
    vi.mocked(browser.storage.local.get).mockImplementation(get);
    vi.mocked(browser.storage.local.set).mockImplementation(set);
    vi.mocked(chrome.storage.local.get).mockImplementation(get);
    vi.mocked(chrome.storage.local.set).mockImplementation(set);
    vi.spyOn(accountIsolationService, 'isIsolationEnabled').mockResolvedValue(false);
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    repository?.destroy();
    vi.restoreAllMocks();
  });

  it('saves 1k folders / 10k refs and recovers its emergency copy with localStorage still full', async () => {
    localStorage.setItem(KEY, JSON.stringify(library()));
    await createRepository().init();
    repository.data.folders[0].name = 'Changed';
    await expect(repository.saveData()).resolves.toBe(true);
    const expected = structuredClone(repository.data);

    expect(JSON.parse(localStorage.getItem(KEY)!)).toEqual(expected);
    expect(JSON.parse(localStorage.getItem(PRIMARY)!).data).toEqual(expected);
    expect(localStorage.getItem(EMERGENCY)).toBeNull();
    expect(JSON.parse(durable[EMERGENCY] as string).data).toEqual(expected);
    expect(onSaveFailed).not.toHaveBeenCalled();
    expect([...values.values()].reduce((sum, value) => sum + value.length, 0)).toBeGreaterThan(
      4_200_000,
    );

    repository.destroy();
    // Corrupt the primary without freeing space; the durable emergency still cannot fit.
    localStorage.setItem(PRIMARY, '!'.repeat(localStorage.getItem(PRIMARY)!.length));
    durable[KEY] = { ...expected, folders: 'corrupted' };
    await createRepository().init();

    expect(onRecovery).toHaveBeenCalledWith('recovered');
    expect(repository.data).toEqual(expected);
    expect(durable[KEY]).toEqual(expected);
    expect(localStorage.getItem(EMERGENCY)).toBeNull();
  });

  it('finishes the emergency fallback before reporting a completed save', async () => {
    localStorage.setItem(KEY, JSON.stringify(library()));
    await createRepository().init();
    let release!: () => void;
    const write = new Promise<void>((resolve) => {
      release = resolve;
    });
    vi.mocked(browser.storage.local.set).mockImplementation(async (items) => {
      if (EMERGENCY in items) await write;
      Object.assign(durable, items);
    });
    repository.data.folders[0].name = 'Changed';
    let settled = false;
    const saving = repository.saveData().then((saved) => {
      settled = true;
      return saved;
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(JSON.parse(localStorage.getItem(KEY)!).folders[0].name).toBe('Changed');
    expect(settled).toBe(false);

    release();
    await expect(saving).resolves.toBe(true);
    expect(settled).toBe(true);
    expect(JSON.parse(durable[EMERGENCY] as string).data).toEqual(repository.data);
  });

  it('keeps a successful user save and older primary when both backup stores fail', async () => {
    localStorage.setItem(KEY, JSON.stringify(library()));
    await createRepository().init();
    const oldPrimary = localStorage.getItem(PRIMARY);
    const setItem = vi.mocked(localStorage.setItem).getMockImplementation()!;
    vi.mocked(localStorage.setItem).mockImplementation((key, value) => {
      if (key.startsWith('gvBackup_')) throw new DOMException('Storage full', 'QuotaExceededError');
      setItem(key, value);
    });
    vi.mocked(browser.storage.local.set).mockRejectedValue(new Error('Extension quota full'));

    repository.data.folders[0].name = 'Changed';
    await expect(repository.saveData()).resolves.toBe(true);
    expect(JSON.parse(localStorage.getItem(KEY)!)).toEqual(repository.data);
    expect(durable[KEY]).toEqual(repository.data);
    expect(localStorage.getItem(PRIMARY)).toBe(oldPrimary);
    expect(onSaveFailed).not.toHaveBeenCalled();
  });
});
