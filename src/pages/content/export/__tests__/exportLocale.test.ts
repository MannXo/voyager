import { afterEach, describe, expect, it, vi } from 'vitest';

import { StorageKeys } from '@/core/types/common';

import { watchExportLanguage } from '../exportLocale';

type Listener = (changes: Record<string, chrome.storage.StorageChange>, area: string) => void;

function registeredListener(): Listener {
  const calls = vi.mocked(chrome.storage.onChanged.addListener).mock.calls;
  return calls[calls.length - 1][0] as Listener;
}

describe('watchExportLanguage', () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it('reports a language switched in sync storage and ignores other changes', () => {
    const onChange = vi.fn();
    watchExportLanguage(onChange);
    const listener = registeredListener();

    listener({ [StorageKeys.LANGUAGE]: { newValue: 'zh_TW' } }, 'local');
    listener({ other: { newValue: 'fr' } }, 'sync');
    listener({ [StorageKeys.LANGUAGE]: { newValue: 'ja' } }, 'sync');

    expect(onChange.mock.calls).toEqual([['ja']]);
  });

  it('stops listening once stopped', () => {
    const stop = watchExportLanguage(() => {});
    const listener = registeredListener();

    stop();

    expect(chrome.storage.onChanged.removeListener).toHaveBeenCalledWith(listener);
  });
});
