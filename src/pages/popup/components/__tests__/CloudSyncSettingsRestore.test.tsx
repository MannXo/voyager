import React, { act } from 'react';
import { type Root, createRoot } from 'react-dom/client';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { StorageKeys } from '@/core/types/common';
import type { SyncState } from '@/core/types/sync';
import { DEFAULT_SYNC_STATE } from '@/core/types/sync';

import { CloudSyncSettings } from '../CloudSyncSettings';

vi.mock('@/contexts/LanguageContext', () => ({
  useLanguage: () => ({
    language: 'en',
    setLanguage: vi.fn(),
    // Keys pass through, except the partial-restore template, so a test can
    // read which parts it names.
    t: (key: string) =>
      key === 'syncRestorePartial' ? 'Restored: {restored}. Not restored: {failed} ({error})' : key,
  }),
}));

vi.mock('@/core/utils/browser', () => ({
  getVoyagerBuildTarget: () => 'chrome',
  isSafari: () => false,
}));

type MockedChrome = typeof chrome;

const baseState: SyncState = {
  ...DEFAULT_SYNC_STATE,
  mode: 'manual',
  isAuthenticated: false,
};

function createChromeMock(sendMessage: ReturnType<typeof vi.fn>): MockedChrome {
  return {
    runtime: { sendMessage, lastError: null, id: 'test-extension-id' },
    tabs: {
      get: vi.fn().mockResolvedValue({ id: 1, url: 'https://gemini.google.com/app' }),
      query: vi.fn().mockResolvedValue([{ id: 1, url: 'https://gemini.google.com/app' }]),
      sendMessage: vi.fn().mockResolvedValue({
        ok: true,
        data: { folders: [], folderContents: {} },
      }),
    },
    storage: {
      local: {
        get: vi.fn().mockResolvedValue({}),
        set: vi.fn().mockResolvedValue(undefined),
        remove: vi.fn().mockResolvedValue(undefined),
      },
      sync: {
        get: vi.fn().mockResolvedValue({}),
        set: vi.fn().mockResolvedValue(undefined),
        remove: vi.fn().mockResolvedValue(undefined),
        clear: vi.fn().mockResolvedValue(undefined),
      },
      onChanged: { addListener: vi.fn(), removeListener: vi.fn() },
    },
  } as unknown as MockedChrome;
}

async function flushMicrotasks(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
  });
}

describe('CloudSyncSettings restore failures', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    container = document.createElement('div');
    document.body.appendChild(container);
  });

  afterEach(() => {
    if (root) {
      act(() => {
        root.unmount();
      });
    }
    document.body.innerHTML = '';
    vi.clearAllMocks();
    vi.restoreAllMocks();
  });

  it('fails the whole merge restore when local plugin state cannot be read', async () => {
    const sendMessageMock = vi.fn().mockImplementation((message: { type?: string }) => {
      if (message.type === 'gv.sync.getState') {
        return Promise.resolve({ ok: true, state: baseState });
      }
      if (message.type === 'gv.sync.download') {
        return Promise.resolve({
          ok: true,
          state: { ...baseState, isAuthenticated: true },
          data: {
            folders: { data: { folders: [], folderContents: {} } },
            prompts: { items: [] },
            settings: {
              format: 'gemini-voyager.settings.v1',
              exportedAt: new Date().toISOString(),
              version: '1.0.0',
              data: { [StorageKeys.MERMAID_ENABLED]: false },
            },
            plugins: {
              format: 'gemini-voyager.plugins.v1',
              exportedAt: new Date().toISOString(),
              version: '1.0.0',
              data: { cloud: { enabled: false, installedAt: 4 } },
            },
            starred: { data: { messages: {} } },
          },
        });
      }
      return Promise.resolve({ ok: true });
    });

    const chromeMock = createChromeMock(sendMessageMock);
    (chromeMock.storage.local.get as unknown as ReturnType<typeof vi.fn>).mockImplementation(
      async (keys: unknown) => {
        if (keys && typeof keys === 'object' && StorageKeys.PLUGINS_STATE in keys) {
          throw new Error('local read failed');
        }
        return {
          gvFolderData: { folders: [], folderContents: {} },
          gvPromptItems: [],
          geminiTimelineStarredMessages: { messages: {} },
          [StorageKeys.TIMELINE_HIERARCHY]: { conversations: {} },
        };
      },
    );
    (globalThis as { chrome: MockedChrome }).chrome = chromeMock;

    await act(async () => {
      root = createRoot(container);
      root.render(<CloudSyncSettings />);
    });
    await flushMicrotasks();

    const downloadButton = Array.from(container.querySelectorAll('button')).find((btn) =>
      (btn.textContent || '').includes('syncMerge'),
    );
    await act(async () => {
      downloadButton?.click();
    });
    await flushMicrotasks();

    // Nothing is written: no partial restore of plugins, settings or folders.
    expect(chromeMock.storage.local.set).not.toHaveBeenCalled();
    expect(chromeMock.storage.sync.set).not.toHaveBeenCalled();
    expect(container.textContent).toContain('syncError');
  });

  it('names the restored and the failed parts when a later write fails', async () => {
    const sendMessageMock = vi.fn().mockImplementation((message: { type?: string }) => {
      if (message.type === 'gv.sync.getState') {
        return Promise.resolve({ ok: true, state: baseState });
      }
      if (message.type === 'gv.sync.download') {
        return Promise.resolve({
          ok: true,
          state: { ...baseState, isAuthenticated: true },
          // The background already pulled highlights before the popup writes anything.
          highlights: { synced: true, count: 2 },
          data: {
            folders: { data: { folders: [], folderContents: {} } },
            prompts: { items: [] },
            settings: {
              format: 'gemini-voyager.settings.v1',
              exportedAt: new Date().toISOString(),
              version: '1.0.0',
              data: { [StorageKeys.MERMAID_ENABLED]: false },
            },
            plugins: {
              format: 'gemini-voyager.plugins.v1',
              exportedAt: new Date().toISOString(),
              version: '1.0.0',
              data: { cloud: { enabled: false, installedAt: 4 } },
            },
            starred: { data: { messages: {} } },
          },
        });
      }
      return Promise.resolve({ ok: true });
    });

    const chromeMock = createChromeMock(sendMessageMock);
    (chromeMock.storage.local.set as unknown as ReturnType<typeof vi.fn>).mockImplementation(
      async (items: Record<string, unknown>) => {
        if ('gvFolderData' in items) throw new Error('folders write failed');
      },
    );
    (globalThis as { chrome: MockedChrome }).chrome = chromeMock;

    await act(async () => {
      root = createRoot(container);
      root.render(<CloudSyncSettings />);
    });
    await flushMicrotasks();

    const downloadButton = Array.from(container.querySelectorAll('button')).find((btn) =>
      (btn.textContent || '').includes('syncMerge'),
    );
    await act(async () => {
      downloadButton?.click();
    });
    await flushMicrotasks();

    expect(chromeMock.storage.local.set).toHaveBeenCalledWith(
      expect.objectContaining({ [StorageKeys.PLUGINS_STATE]: expect.anything() }),
    );
    expect(chromeMock.storage.sync.set).toHaveBeenCalled();
    expect(container.textContent).toContain(
      'Restored: storageQuotaHighlights, pluginsTitle, storageQuotaSync. ' +
        'Not restored: folder_title, promptDataMigration (folders write failed)',
    );
  });
});
