import React, { act } from 'react';
import { type Root, createRoot } from 'react-dom/client';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { type SyncState, DEFAULT_SYNC_STATE } from '@/core/types/sync';

import { CloudSyncSettings } from '../CloudSyncSettings';

vi.mock('@/contexts/LanguageContext', () => ({
  useLanguage: () => ({ language: 'en', setLanguage: vi.fn(), t: (key: string) => key }),
}));

vi.mock('@/core/utils/browser', () => ({
  getVoyagerBuildTarget: () => 'chrome',
  isSafari: () => false,
}));

const state: SyncState = {
  ...DEFAULT_SYNC_STATE,
  mode: 'manual',
  lastUploadTime: null,
  lastSyncTime: null,
  lastUploadTimeAIStudio: Date.now(),
  lastSyncTimeAIStudio: Date.now(),
};

function installChrome(tabUrl: string) {
  const sendMessage = vi.fn(async (message: { type?: string }) =>
    message.type === 'gv.sync.getState' ? { ok: true, state } : { ok: true },
  );
  const localGet = vi.fn().mockResolvedValue({});
  vi.stubGlobal('chrome', {
    runtime: { id: 'test-extension-id', sendMessage, lastError: null },
    tabs: {
      get: vi.fn(),
      query: vi.fn().mockResolvedValue([{ id: 3, url: tabUrl }]),
      sendMessage: vi.fn().mockResolvedValue(undefined),
    },
    storage: {
      local: { get: localGet, set: vi.fn(), remove: vi.fn() },
      sync: { get: vi.fn().mockResolvedValue({}), set: vi.fn(), remove: vi.fn() },
      onChanged: { addListener: vi.fn(), removeListener: vi.fn() },
    },
  });
  return { sendMessage, localGet };
}

describe('CloudSyncSettings platform routing', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    vi.unstubAllGlobals();
  });

  const mount = async () => {
    await act(async () => root.render(<CloudSyncSettings />));
    await act(async () => Promise.resolve());
  };

  it('renders no folder sync controls for a ChatGPT tab', async () => {
    const { sendMessage, localGet } = installChrome('https://chatgpt.com/c/abc');
    await mount();
    expect(container.innerHTML).toBe('');
    const types = sendMessage.mock.calls.map(([message]) => message.type);
    expect(types).not.toContain('gv.sync.upload');
    expect(types).not.toContain('gv.sync.download');
    expect(JSON.stringify(localGet.mock.calls)).not.toContain('gvFolderData');
  });

  it('shows each native platform its own sync timestamps', async () => {
    installChrome('https://aistudio.google.com/prompts/new_chat');
    await mount();
    let summary = container.querySelector('[data-testid="sync-platform-summary"]');
    expect(summary?.textContent).toContain('platformAIStudio');
    expect(summary?.textContent).toContain('lastUploaded');
    expect(summary?.textContent).toContain('lastSynced');
    expect(summary?.textContent).not.toContain('never');

    await act(async () => root.unmount());
    root = createRoot(container);
    installChrome('https://gemini.google.com/app');
    await mount();
    summary = container.querySelector('[data-testid="sync-platform-summary"]');
    expect(summary?.textContent).toContain('platformGemini');
    expect(summary?.textContent).toContain('neverUploaded');
    expect(summary?.textContent).toContain('neverSynced');
  });
});
