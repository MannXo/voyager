import React, { act } from 'react';
import { type Root, createRoot } from 'react-dom/client';

import { afterEach, beforeEach, expect, it, vi } from 'vitest';

import { LanguageProvider } from '@/contexts/LanguageContext';
import { accountIsolationService } from '@/core/services/AccountIsolationService';
import { StorageKeys } from '@/core/types/common';
import { StarredMessagesService } from '@/features/savedLibrary/StarredMessagesService';
import { makeRecord } from '@/pages/content/highlight/__tests__/fixtures';
import { TRANSLATIONS } from '@/utils/translations';

import { StarredHistory } from '../StarredHistory';

vi.mock('webextension-polyfill', () => ({ default: chrome }));

let root: Root;
let container: HTMLElement;
let pageUrl: string;
beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  vi.clearAllMocks();
  pageUrl = 'https://claude.ai/chat/current';
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  vi.mocked(chrome.storage.sync.get).mockImplementation(async () => ({
    [StorageKeys.LANGUAGE]: 'en',
  }));
  vi.mocked(chrome.storage.local.get).mockImplementation(async () => ({}));
  vi.mocked(chrome.storage.local.set).mockResolvedValue();
  vi.mocked(chrome.tabs.query).mockImplementation(async () => [
    { id: 7, url: pageUrl } as chrome.tabs.Tab,
  ]);
  chrome.tabs.update = vi.fn().mockResolvedValue({});
  vi.mocked(chrome.tabs.create).mockImplementation(async () => ({}) as chrome.tabs.Tab);
  vi.mocked(chrome.tabs.sendMessage).mockImplementation(async () => ({ ok: false }));
  vi.mocked(chrome.runtime.sendMessage).mockImplementation(
    async (message: unknown, callback?: unknown) => {
      const type = (message as { type: string }).type;
      if (type === 'gv.starred.getAll') {
        const response = {
          ok: true,
          data: {
            messages: {
              'claude:conv:saved': [
                {
                  conversationId: 'claude:conv:saved',
                  conversationUrl: 'https://claude.ai/chat/saved',
                  turnId: 'turn-one',
                  content: 'Saved answer',
                  starredAt: 100,
                },
              ],
            },
          },
        };
        if (typeof callback === 'function') callback(response);
        return response;
      }
      return { ok: false, error: 'Storage unavailable' };
    },
  );
  vi.spyOn(window, 'close').mockImplementation(() => {});
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.restoreAllMocks();
});

async function mount() {
  await act(async () => {
    root.render(
      <LanguageProvider>
        <StarredHistory onClose={() => {}} />
      </LanguageProvider>,
    );
  });
}
async function viewHighlights() {
  const button = Array.from(container.querySelectorAll('button')).find((candidate) =>
    candidate.textContent?.includes(TRANSLATIONS.en.savedLibraryHighlights),
  )!;
  await act(async () => button.click());
}

it.each([
  'https://claude.ai/chat/current',
  'https://chatgpt.com/c/current',
  'https://chat.deepseek.com/a/chat/s/current',
])('Saved Library lists stars without a highlight load error on %s', async (url) => {
  pageUrl = url;
  await mount();
  expect(container.textContent).toContain('Saved answer');
  await viewHighlights();
  expect(container.textContent).toContain(TRANSLATIONS.en.savedLibraryNoHighlights);
  expect(container.textContent).not.toContain(TRANSLATIONS.en.pm_starred_load_error);
  expect(chrome.runtime.sendMessage).not.toHaveBeenCalledWith(
    expect.objectContaining({ type: 'gv.highlight.list' }),
  );
});

it.each([
  'https://gemini.google.com/u/1/app/current',
  'https://aistudio.google.com/u/1/prompts/current',
])('Saved Library still reports a real highlight load failure on %s', async (url) => {
  pageUrl = url;
  await mount();
  expect(container.textContent).toContain('Saved answer');
  await viewHighlights();
  expect(container.textContent).toContain(TRANSLATIONS.en.pm_starred_load_error);
  expect(chrome.runtime.sendMessage).toHaveBeenCalledWith(
    expect.objectContaining({ type: 'gv.highlight.list' }),
  );
});

it('opens a saved Claude star in the current Claude tab', async () => {
  await mount();
  const card = container.querySelector<HTMLElement>('[role="button"]')!;
  await act(async () => card.click());
  expect(chrome.tabs.update).toHaveBeenCalledWith(7, {
    url: 'https://claude.ai/chat/saved#gv-turn-turn-one',
  });
  expect(chrome.tabs.create).not.toHaveBeenCalled();
});

it('keeps a starred row after a failed removal and allows retry', async () => {
  const remove = vi
    .spyOn(StarredMessagesService, 'removeStarredMessage')
    .mockRejectedValueOnce(new Error('Storage unavailable'))
    .mockResolvedValue(undefined);
  vi.spyOn(console, 'error').mockImplementation(() => {});
  await mount();
  const button = container.querySelector<HTMLButtonElement>(
    `button[aria-label="${TRANSLATIONS.en.removeFromStarred}"]`,
  )!;

  await act(async () => button.click());
  expect(container.textContent).toContain('Saved answer');
  expect(container.querySelector('[role="alert"]')?.textContent).toBe(
    TRANSLATIONS.en.starredDeleteFailed,
  );
  expect(button.isConnected).toBe(true);

  await act(async () => button.click());
  expect(container.textContent).not.toContain('Saved answer');
  expect(container.querySelector('[role="alert"]')).toBeNull();
  expect(remove).toHaveBeenCalledWith('claude:conv:saved', 'turn-one');
});

it('keeps a highlight row and reports highlight removal failure when the request throws', async () => {
  pageUrl = 'https://gemini.google.com/u/1/app/current';
  vi.spyOn(StarredMessagesService, 'getAllStarredMessagesSorted').mockResolvedValue([]);
  vi.spyOn(accountIsolationService, 'resolveAccountScope').mockResolvedValue({
    accountKey: 'opaque-account',
    accountId: 1,
    routeUserId: '1',
    emailHash: null,
  });
  const highlight = makeRecord({
    quote: { exact: 'Highlighted answer', prefix: '', suffix: '' },
    position: { start: 0, end: 18 },
    sourceTextHash: 'text-hash',
  });
  vi.mocked(chrome.runtime.sendMessage).mockImplementation((async (message: { type: string }) => {
    if (message.type === 'gv.highlight.list') return { ok: true, records: [highlight] };
    throw new Error('Highlight storage unavailable');
  }) as typeof chrome.runtime.sendMessage);
  vi.spyOn(console, 'error').mockImplementation(() => {});
  await mount();
  const button = container.querySelector<HTMLButtonElement>(
    `button[aria-label="${TRANSLATIONS.en.pm_delete}"]`,
  )!;
  await act(async () => button.click());
  expect(container.querySelector('[role="alert"]')?.textContent).toBe(
    TRANSLATIONS.en.highlightDeleteFailed,
  );
  expect(container.textContent).toContain('Highlighted answer');
  expect(button.isConnected).toBe(true);
});
