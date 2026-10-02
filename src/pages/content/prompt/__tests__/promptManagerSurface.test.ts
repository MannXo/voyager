import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { StorageKeys } from '@/core/types/common';
import type { PromptItem } from '@/core/types/sync';

import { startPromptManager } from '../index';

vi.mock('webextension-polyfill', () => ({ default: globalThis.chrome }));

let manager: Awaited<ReturnType<typeof startPromptManager>> | undefined;

function storageGet(values: Record<string, unknown>): typeof chrome.storage.sync.get {
  const get = (
    keys: string | string[] | Record<string, unknown> | null = null,
    callback?: (items: Record<string, unknown>) => void,
  ): Promise<Record<string, unknown>> => {
    const defaults = keys && typeof keys === 'object' && !Array.isArray(keys) ? keys : {};
    const names =
      keys === null
        ? Object.keys(values)
        : typeof keys === 'string'
          ? [keys]
          : Array.isArray(keys)
            ? keys
            : Object.keys(keys);
    const result = Object.fromEntries(names.map((key) => [key, values[key] ?? defaults[key]]));
    callback?.(result);
    return Promise.resolve(result);
  };
  return get as typeof chrome.storage.sync.get;
}

async function openManager(items: PromptItem[]): Promise<HTMLElement> {
  vi.mocked(chrome.storage.local.get).mockImplementation(
    storageGet({ [StorageKeys.PROMPT_ITEMS]: items }),
  );
  manager = await startPromptManager();
  document.querySelector<HTMLButtonElement>('#gv-pm-trigger')!.click();
  return document.querySelector<HTMLElement>('#gv-pm-panel')!;
}

function emitStorageChange(changes: Record<string, unknown>, area: string): void {
  for (const [listener] of vi.mocked(chrome.storage.onChanged.addListener).mock.calls) {
    (listener as (changes: object, area: string) => void)(changes, area);
  }
}

const prompt = (id: string, name: string, text = `${name} body`): PromptItem => ({
  id,
  name,
  text,
  tags: [],
  createdAt: 1,
});

beforeEach(() => {
  vi.clearAllMocks();
  document.body.innerHTML = '';
  localStorage.clear();
  vi.mocked(chrome.storage.sync.get).mockImplementation(
    storageGet({ [StorageKeys.LANGUAGE]: 'en' }),
  );
  vi.spyOn(console, 'error').mockImplementation(() => {});
  // startPromptManager wraps console.warn for KaTeX; let restoreAllMocks undo it.
  vi.spyOn(console, 'warn');
});

afterEach(() => {
  manager?.destroy();
  manager = undefined;
  vi.useRealTimers();
  vi.restoreAllMocks();
  document.body.innerHTML = '';
});

describe('prompt manager footer', () => {
  it('keeps the secondary footer row to settings and the sponsor link', async () => {
    const panel = await openManager([prompt('a', 'Alpha')]);

    const secondary = panel.querySelector('.gv-pm-footer-secondary')!;
    expect(Array.from(secondary.children).map((child) => child.className)).toEqual([
      'gv-pm-settings',
      'gv-pm-support',
    ]);
  });

  it('renders the sponsor link as an icon plus a text label', async () => {
    const panel = await openManager([prompt('a', 'Alpha')]);

    const support = panel.querySelector<HTMLAnchorElement>('.gv-pm-support')!;
    expect(support.querySelector('svg')).not.toBeNull();
    const label = support.querySelector('.gv-pm-support-label');
    expect(label?.textContent?.trim()).toBeTruthy();
    expect(support.textContent).toBe(label?.textContent);
  });

  it('gives the Saved Library a back action and an export menu with two formats', async () => {
    const panel = await openManager([prompt('a', 'Alpha')]);

    const savedFooter = panel.querySelector('.gv-pm-saved-footer-actions')!;
    expect(savedFooter.querySelector('.gv-pm-saved-footer-primary svg')).not.toBeNull();
    const exportTrigger = savedFooter.querySelector('.gv-pm-saved-export-trigger')!;
    expect(exportTrigger.getAttribute('aria-haspopup')).toBe('menu');
    const options = Array.from(
      savedFooter.querySelectorAll<HTMLButtonElement>('.gv-pm-saved-export-option'),
    );
    expect(options.map((option) => option.textContent)).toEqual(['JSON', 'Markdown']);
    expect(options.every((option) => option.querySelector('svg'))).toBe(true);
    // Filters sit above the list; the saved footer offers no import.
    const toolbar = panel.querySelector('.gv-pm-saved-toolbar')!;
    const list = panel.querySelector('.gv-pm-list')!;
    expect(toolbar.compareDocumentPosition(list) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(savedFooter.querySelectorAll('button')).toHaveLength(4);
  });

  it('draws its controls with icons rather than emoji', async () => {
    const panel = await openManager([prompt('a', 'Alpha')]);

    expect(panel.querySelector('.gv-pm-lock svg')).not.toBeNull();
    expect(panel.querySelector('.gv-pm-backup-btn svg')).not.toBeNull();
    expect(panel.textContent).not.toMatch(/[💬★🔒🔓]/u);
  });
});

describe('prompt manager list', () => {
  it('marks every prompt of a duplicate-name group with a non-blocking badge', async () => {
    const panel = await openManager([
      prompt('a', 'Same'),
      prompt('b', 'same '),
      prompt('c', 'Unique'),
    ]);

    const rows = Array.from(panel.querySelectorAll<HTMLElement>('.gv-pm-item'));
    expect(rows).toHaveLength(3);
    const flagged = rows.map((row) => row.classList.contains('gv-pm-item-name-conflict'));
    expect(flagged.filter(Boolean)).toHaveLength(2);
    for (const row of rows) {
      const badge = row.querySelector('.gv-pm-name-conflict');
      expect(Boolean(badge)).toBe(row.classList.contains('gv-pm-item-name-conflict'));
      if (badge) expect(badge.textContent?.trim()).toBeTruthy();
    }
  });

  it('opens links in the hover preview in a new tab', async () => {
    vi.useFakeTimers();
    const panel = await openManager([
      prompt('a', 'Linked', 'Read [the docs](https://example.com/docs) first'),
    ]);

    const row = panel.querySelector<HTMLElement>('.gv-pm-item-text')!;
    row.dispatchEvent(new MouseEvent('mouseenter'));
    vi.advanceTimersByTime(300);

    const link = await vi.waitFor(() => {
      const found = document.querySelector<HTMLAnchorElement>('.gv-pm-tooltip a[href]');
      if (!found) throw new Error('preview not rendered yet');
      return found;
    });
    expect(link.getAttribute('target')).toBe('_blank');
    expect(link.getAttribute('rel')).toBe('noopener noreferrer');
  });
});

describe('prompt manager settings', () => {
  it('is not hidden by the slash completion setting', async () => {
    const panel = await openManager([prompt('a', 'Alpha')]);
    const trigger = document.querySelector<HTMLElement>('#gv-pm-trigger')!;

    emitStorageChange(
      { [StorageKeys.SLASH_PROMPT_ENABLED]: { oldValue: true, newValue: false } },
      'sync',
    );

    expect(trigger.style.display).not.toBe('none');
    expect(panel.classList.contains('gv-hidden')).toBe(false);
  });
});
