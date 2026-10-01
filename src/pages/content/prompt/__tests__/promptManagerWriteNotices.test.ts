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

  it('keeps an edit whose prompt another tab deleted, and saves it as a new prompt', async () => {
    const ops: Array<{ kind: string }> = [];
    vi.mocked(chrome.runtime.sendMessage).mockImplementation(((message: {
      type?: string;
      op?: { kind: string; items?: unknown[] };
    }) => {
      if (message.type !== 'gv.promptLibrary.apply' || !message.op) return Promise.resolve();
      ops.push(message.op);
      // Another tab deleted Alpha just before this edit arrived.
      const items =
        message.op.kind === 'add' ? [...(message.op.items ?? []), prompts[1]] : [prompts[1]];
      const added = message.op.kind === 'add' ? 1 : 0;
      return Promise.resolve({
        ok: true,
        result: { added, skipped: 0, total: items.length, nameConflicts: 0, items },
      });
    }) as never);
    await openPanel();

    document.querySelector<HTMLButtonElement>('.gv-pm-item .gv-pm-edit')!.click();
    const form = document.querySelector<HTMLFormElement>('.gv-pm-add-form')!;
    const text = form.querySelector<HTMLTextAreaElement>('.gv-pm-input-text')!;
    text.value = 'Alpha body, edited';
    form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    await vi.advanceTimersByTimeAsync(1);

    expect(ops.map((op) => op.kind)).toEqual(['update']);
    expect(form.classList.contains('gv-hidden')).toBe(false);
    expect(text.value).toBe('Alpha body, edited');
    expect(form.querySelector('.gv-pm-inline-hint')!.textContent).toBe(
      'This prompt was deleted elsewhere. Save again to keep it as a new prompt.',
    );
    expect(rowIds()).toEqual(['Beta']);

    form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    await vi.advanceTimersByTimeAsync(1);

    expect(ops.map((op) => op.kind)).toEqual(['update', 'add']);
    expect(ops[1]).toMatchObject({
      items: [expect.objectContaining({ name: 'Alpha', text: 'Alpha body, edited' })],
    });
    expect(form.classList.contains('gv-hidden')).toBe(true);
    expect(rowIds()).toEqual(['Alpha', 'Beta']);
  });

  it('keeps the library on screen when it cannot be read back after a failed change', async () => {
    let failReads = false;
    const read = storageGet({ [StorageKeys.PROMPT_ITEMS]: prompts });
    vi.mocked(chrome.storage.local.get).mockImplementation(((
      keys: string | string[] | Record<string, unknown> | null,
      callback?: (items: Record<string, unknown>) => void,
    ) => {
      const asksLibrary =
        keys === StorageKeys.PROMPT_ITEMS ||
        (Array.isArray(keys) && keys.includes(StorageKeys.PROMPT_ITEMS));
      if (failReads && asksLibrary) {
        return Promise.reject(new Error('Extension context invalidated.'));
      }
      return (read as (k: typeof keys, cb?: typeof callback) => Promise<unknown>)(keys, callback);
    }) as never);
    vi.mocked(chrome.runtime.sendMessage).mockRejectedValue(
      new Error('Extension context invalidated.'),
    );
    await openPanel();
    failReads = true;

    await deleteFirstPrompt();

    expect(rowIds()).toEqual(['Alpha', 'Beta']);
    expect(notices).toEqual(["Couldn't save your change. It was undone."]);
  });
});
