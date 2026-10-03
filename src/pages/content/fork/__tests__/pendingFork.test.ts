import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import browser from 'webextension-polyfill';

import { startPendingFork } from '../pendingFork';

vi.mock('webextension-polyfill', () => ({
  default: {
    storage: {
      local: {
        get: vi.fn(),
        remove: vi.fn().mockResolvedValue(undefined),
      },
    },
  },
}));

describe('pending fork handoff', () => {
  let stop: () => void;
  const pending = {
    sourceConversationId: 'source',
    sourceTurnId: 's-1111111111111111',
    sourceUrl: 'https://gemini.google.com/app/source',
    sourceTitle: 'Source',
    forkGroupId: 'group',
    sourceForkIndex: 0,
    nextForkIndex: 1,
    markdown: '# Source\n\nContext',
    mode: 'fileUpload',
    filename: 'fork.md',
  };

  const flush = async () => {
    for (let i = 0; i < 8; i++) await Promise.resolve();
  };
  const start = () =>
    startPendingFork({
      getConversationId: () => null,
      getConversationTitle: () => 'New',
      onLinked: async () => undefined,
    });

  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
    vi.mocked(browser.storage.local.get).mockResolvedValue({});
    document.body.innerHTML =
      '<rich-textarea><div contenteditable="true">An existing draft</div></rich-textarea>';
    const input = document.querySelector<HTMLElement>('[contenteditable]')!;
    vi.spyOn(input, 'getBoundingClientRect').mockReturnValue({ height: 24 } as DOMRect);
    sessionStorage.clear();
  });

  afterEach(() => {
    stop();
    vi.clearAllTimers();
    vi.useRealTimers();
    vi.restoreAllMocks();
    document.body.innerHTML = '';
  });

  it('uses the longer upload TTL without overwriting an existing draft', async () => {
    vi.mocked(browser.storage.local.get).mockResolvedValue({
      gvPendingFork: { ...pending, createdAt: Date.now() - 90000 },
    });
    stop = start();
    await flush();

    expect(document.querySelector('[contenteditable]')?.textContent).toBe('An existing draft');
    expect(document.querySelector('.gv-fork-manual-upload-timer')?.textContent).toBe('00:30');
    expect(document.querySelector('.gv-fork-manual-upload-hint')?.textContent).toContain('fork.md');
    await vi.advanceTimersByTimeAsync(30000);
    expect(document.querySelector('.gv-fork-manual-upload-hint')).toBeNull();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('discards an expired paste and clears the legacy per-tab record', async () => {
    sessionStorage.setItem('gvPendingFork', 'legacy');
    vi.mocked(browser.storage.local.get).mockResolvedValue({
      gvPendingFork: { ...pending, mode: 'paste', createdAt: Date.now() - 90000 },
    });
    stop = start();
    await flush();

    expect(browser.storage.local.remove).toHaveBeenCalledWith('gvPendingFork');
    expect(sessionStorage.getItem('gvPendingFork')).toBeNull();
    expect(document.querySelector('[contenteditable]')?.textContent).toBe('An existing draft');
    expect(document.querySelector('.gv-fork-manual-upload-hint')).toBeNull();
  });

  it('lets a restarted feature clear upload feedback created by an older pending read', async () => {
    let resolveRead!: (value: Record<string, unknown>) => void;
    vi.mocked(browser.storage.local.get).mockReturnValueOnce(
      new Promise((resolve) => {
        resolveRead = resolve;
      }),
    );
    const stopOld = start();
    stopOld();
    stop = start();
    resolveRead({ gvPendingFork: { ...pending, createdAt: Date.now() } });
    await flush();

    const timer = document.querySelector('.gv-fork-manual-upload-timer')!;
    expect(timer.textContent).toBe('02:00');
    stop();
    await vi.advanceTimersByTimeAsync(1000);

    expect(document.querySelector('.gv-fork-manual-upload-hint')).toBeNull();
    expect(timer.textContent).toBe('02:00');
  });
});
