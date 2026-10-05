import { afterEach, describe, expect, it, vi } from 'vitest';

import { handlePageRuntimeMessage } from '@/pages/background/pageRuntimeMessages';
import { isHandledBackgroundRuntimeMessage } from '@/pages/background/runtimeMessageRouting';

import { LIBRARY_OPEN_MESSAGE, LIBRARY_PAGE_PATH, openLibraryPage } from '../openLibraryPage';

afterEach(() => vi.restoreAllMocks());

describe('saved library launcher', () => {
  it('opens only the bundled page even when a content script supplies another URL', async () => {
    vi.mocked(chrome.runtime.sendMessage).mockImplementation((async (message: { type: string }) =>
      handlePageRuntimeMessage(
        {
          ...message,
          url: 'https://untrusted.example/',
          payload: { url: 'https://elsewhere.example/' },
        },
        { tab: { id: 7, url: 'https://gemini.google.com/app' } as chrome.tabs.Tab },
      )) as typeof chrome.runtime.sendMessage);

    await openLibraryPage();

    expect(chrome.runtime.sendMessage).toHaveBeenCalledWith({ type: LIBRARY_OPEN_MESSAGE });
    expect(chrome.tabs.create).toHaveBeenCalledOnce();
    expect(chrome.tabs.create).toHaveBeenCalledWith({
      url: `chrome-extension://test-extension-id/${LIBRARY_PAGE_PATH}`,
    });
    expect(isHandledBackgroundRuntimeMessage({ type: LIBRARY_OPEN_MESSAGE })).toBe(true);
    expect(isHandledBackgroundRuntimeMessage({ type: `${LIBRARY_OPEN_MESSAGE}.unknown` })).toBe(
      false,
    );
  });

  it('reports failure when the browser refuses to open the Library tab', async () => {
    vi.mocked(chrome.tabs.create).mockRejectedValueOnce(new Error('Tabs unavailable'));
    vi.mocked(chrome.runtime.sendMessage).mockImplementation((async (message: { type: string }) =>
      handlePageRuntimeMessage(message, {})) as typeof chrome.runtime.sendMessage);
    await expect(openLibraryPage()).rejects.toThrow('Failed to open saved library');
  });

  it.each([undefined, null, {}, { ok: false }, { ok: 'true' }])(
    'requires a positive acknowledgement before reporting launch success (%j)',
    async (response) => {
      vi.mocked(chrome.runtime.sendMessage).mockImplementationOnce(
        (async () => response) as typeof chrome.runtime.sendMessage,
      );
      await expect(openLibraryPage()).rejects.toThrow();
    },
  );

  it('propagates an unavailable background without reporting success', async () => {
    vi.mocked(chrome.runtime.sendMessage).mockRejectedValueOnce(new Error('Context invalidated'));
    await expect(openLibraryPage()).rejects.toThrow('Context invalidated');
  });
});
