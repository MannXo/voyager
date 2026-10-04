import { afterEach, expect, it, vi } from 'vitest';

import { accountIsolationService } from '@/core/services/AccountIsolationService';
import { StarredMessagesService } from '@/features/savedLibrary/StarredMessagesService';
import { TRANSLATIONS } from '@/utils/translations';

import { createSavedLibraryView } from '../savedLibraryView';

vi.mock('webextension-polyfill', () => ({ default: chrome }));

afterEach(() => {
  document.body.replaceChildren();
  vi.restoreAllMocks();
});

it('keeps a starred row after a failed removal and allows retry', async () => {
  vi.spyOn(StarredMessagesService, 'getAllStarredMessagesSorted').mockResolvedValue([
    {
      conversationId: 'gemini:conv:saved',
      conversationUrl: 'https://gemini.google.com/app/saved',
      turnId: 's-aaaaaaaaaaaaaaaa',
      content: 'Saved answer',
      starredAt: 100,
    },
  ]);
  vi.spyOn(accountIsolationService, 'resolveAccountScope').mockResolvedValue({
    accountKey: 'opaque-account',
    accountId: 1,
    routeUserId: '1',
    emailHash: null,
  });
  vi.mocked(chrome.runtime.sendMessage).mockImplementation((() =>
    Promise.resolve({ ok: true, records: [] })) as typeof chrome.runtime.sendMessage);
  const remove = vi
    .spyOn(StarredMessagesService, 'removeStarredMessage')
    .mockRejectedValueOnce(new Error('Storage unavailable'))
    .mockResolvedValue(undefined);
  const list = document.createElement('div');
  const notice = document.createElement('p');
  document.body.append(list, notice);
  const view = createSavedLibraryView({
    list,
    t: (key) => TRANSLATIONS.en[key],
    getQuery: () => '',
    isActive: () => true,
    setNotice: (text, kind) => {
      notice.textContent = text;
      notice.dataset.kind = kind;
    },
    beforeRender: () => {},
    onBack: () => {},
    rememberView: async () => {},
    onNavigated: () => {},
    highlightPlatform: 'gemini',
  });
  await view.load();
  const button = list.querySelector<HTMLButtonElement>('.gv-pm-starred-remove')!;

  button.click();
  await vi.waitFor(() => {
    expect(notice.textContent).toBe(TRANSLATIONS.en.pm_starred_load_error);
    expect(notice.dataset.kind).toBe('err');
  });
  expect(list.textContent).toContain('Saved answer');
  expect(button.isConnected).toBe(true);

  button.click();
  await vi.waitFor(() => expect(list.textContent).not.toContain('Saved answer'));
  expect(notice.textContent).toBe(TRANSLATIONS.en.pm_deleted);
  expect(notice.dataset.kind).toBe('ok');
  expect(remove).toHaveBeenCalledWith('gemini:conv:saved', 's-aaaaaaaaaaaaaaaa');
});
