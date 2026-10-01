import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { StorageKeys } from '@/core/types/common';

import { startPromptManager } from '../index';

vi.mock('webextension-polyfill', () => ({ default: globalThis.chrome }));

const prompts = [
  { id: 'a', name: 'Alpha', text: 'Alpha body', tags: [], createdAt: 2 },
  { id: 'b', name: 'Beta', text: 'Beta body', tags: [], createdAt: 1 },
];

let manager: Awaited<ReturnType<typeof startPromptManager>> | undefined;
/** Every text Prompt Manager's notice showed, in order. */
let notices: string[];
let observer: MutationObserver | undefined;

function storageGet(values: Record<string, unknown>): typeof chrome.storage.sync.get {
  const get = (
    keys: string | string[] | Record<string, unknown> | null = null,
    callback?: (items: Record<string, unknown>) => void,
  ): Promise<Record<string, unknown>> => {
    const names =
      keys === null
        ? Object.keys(values)
        : typeof keys === 'string'
          ? [keys]
          : Array.isArray(keys)
            ? keys
            : Object.keys(keys);
    const result = Object.fromEntries(
      names
        .filter((key) => values[key] !== undefined)
        .map((key) => [key, structuredClone(values[key])]),
    );
    callback?.(result);
    return Promise.resolve(result);
  };
  return get as typeof chrome.storage.sync.get;
}

async function openPanel(): Promise<void> {
  manager = await startPromptManager();
  document.querySelector<HTMLButtonElement>('#gv-pm-trigger')!.click();
  const notice = document.querySelector('.gv-pm-notice')!;
  observer = new MutationObserver(() => {
    if (notice.textContent) notices.push(notice.textContent);
  });
  observer.observe(notice, { childList: true, characterData: true, subtree: true });
}

/** The prompts listed, by name. */
const rowIds = () =>
  [...document.querySelectorAll<HTMLElement>('.gv-pm-item')].map(
    (row) => ['Alpha', 'Beta', 'Gamma'].find((name) => row.textContent?.includes(name)) ?? '?',
  );

async function deleteFirstPrompt(): Promise<void> {
  document.querySelector<HTMLButtonElement>('.gv-pm-item .gv-pm-del')!.click();
  document.querySelector<HTMLButtonElement>('.gv-pm-confirm .gv-pm-confirm-yes')!.click();
  await vi.advanceTimersByTimeAsync(1);
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers();
  document.body.innerHTML = '';
  localStorage.clear();
  notices = [];
  vi.mocked(chrome.storage.sync.get).mockImplementation(
    storageGet({ [StorageKeys.LANGUAGE]: 'en' }),
  );
  vi.mocked(chrome.storage.local.get).mockImplementation(
    storageGet({ [StorageKeys.PROMPT_ITEMS]: prompts }),
  );
  vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.spyOn(console, 'warn');
});

afterEach(() => {
  observer?.disconnect();
  manager?.destroy();
  manager = undefined;
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.restoreAllMocks();
  document.body.innerHTML = '';
});

describe('Prompt Manager write notices', () => {
  it('says "Deleted" only once the owner has removed the prompt', async () => {
    let reply!: (response: unknown) => void;
    vi.mocked(chrome.runtime.sendMessage).mockImplementation(
      () => new Promise((resolve) => (reply = resolve)) as never,
    );
    await openPanel();
    expect(rowIds()).toEqual(['Alpha', 'Beta']);

    await deleteFirstPrompt();
    expect(rowIds()).toEqual(['Beta']);
    expect(notices).toEqual([]);

    reply({
      ok: true,
      result: { added: 0, skipped: 0, total: 1, nameConflicts: 0, items: [prompts[1]] },
    });
    await vi.advanceTimersByTimeAsync(1);
    expect(notices).toEqual(['Deleted']);
    expect(rowIds()).toEqual(['Beta']);
  });

  it('puts the prompt back and says the change was undone when the delete fails', async () => {
    vi.mocked(chrome.runtime.sendMessage).mockRejectedValue(
      new Error('Could not establish connection. Receiving end does not exist.'),
    );
    await openPanel();

    await deleteFirstPrompt();

    expect(rowIds()).toEqual(['Alpha', 'Beta']);
    expect(notices).toEqual(["Couldn't save your change. It was undone."]);
  });

  it('keeps the form open with what was typed when an add fails', async () => {
    vi.mocked(chrome.runtime.sendMessage).mockResolvedValue({ ok: false, error: 'quota' } as never);
    await openPanel();

    document.querySelector<HTMLButtonElement>('.gv-pm-add')!.click();
    const form = document.querySelector<HTMLFormElement>('.gv-pm-add-form')!;
    form.querySelector<HTMLInputElement>('.gv-pm-input-name')!.value = 'Gamma';
    form.querySelector<HTMLTextAreaElement>('.gv-pm-input-text')!.value = 'Gamma body';
    form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    await vi.advanceTimersByTimeAsync(1);

    expect(rowIds()).toEqual(['Alpha', 'Beta']);
    expect(notices).toEqual(["Couldn't save your change. It was undone."]);
    expect(form.classList.contains('gv-hidden')).toBe(false);
    expect(form.querySelector<HTMLTextAreaElement>('.gv-pm-input-text')!.value).toBe('Gamma body');
  });
});
