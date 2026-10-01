import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { StorageKeys } from '@/core/types/common';

const storageState = vi.hoisted(() => ({
  catalog: [] as Array<{ id: string; href: string; name: string }>,
}));

vi.mock('webextension-polyfill', () => ({
  default: {
    storage: {
      sync: {
        get: vi.fn(async (defaults: Record<string, unknown>) => ({
          ...defaults,
          gvGemsSidebarCount: 3,
        })),
        set: vi.fn(async () => {}),
      },
      local: {
        get: vi.fn(async (key: unknown) => {
          if (key === 'gvGemsListCache') {
            return { [key]: { items: storageState.catalog, cachedAt: 1 } };
          }
          return typeof key === 'object' && key !== null ? key : {};
        }),
        set: vi.fn(async () => {}),
      },
      onChanged: { addListener: vi.fn(), removeListener: vi.fn() },
    },
  },
}));

let rectReads = 0;

function createGemsEntry(): HTMLElement {
  const entry = document.createElement('gem-nav-list-item');
  entry.setAttribute('data-test-id', 'gems-side-nav-entry-button');
  entry.textContent = 'Gems';
  Object.defineProperty(entry, 'getBoundingClientRect', {
    configurable: true,
    value: () => {
      rectReads += 1;
      return { top: 0, left: 0, right: 200, bottom: 40, width: 200, height: 40 } as DOMRect;
    },
  });
  return entry;
}

function nextFrame(): Promise<void> {
  return new Promise((resolve) => requestAnimationFrame(() => resolve()));
}

async function settle(): Promise<void> {
  await Promise.resolve();
  await nextFrame();
}

function mountSidebar(): { nav: HTMLElement; conversations: HTMLElement } {
  document.body.innerHTML = `
    <div data-test-id="overflow-container">
      <mat-nav-list class="nav"></mat-nav-list>
      <div class="conversations"></div>
    </div>`;
  const nav = document.querySelector<HTMLElement>('.nav')!;
  nav.appendChild(createGemsEntry());
  return { nav, conversations: document.querySelector<HTMLElement>('.conversations')! };
}

async function streamRows(container: HTMLElement, count: number): Promise<void> {
  for (let i = 0; i < count; i++) {
    const row = document.createElement('div');
    row.setAttribute('data-test-id', 'conversation');
    row.textContent = `Chat ${i}`;
    container.appendChild(row);
    await settle();
  }
}

describe('gems sidebar position enforcer', () => {
  let stop: (() => void) | null = null;

  beforeEach(() => {
    vi.resetModules();
    rectReads = 0;
    storageState.catalog = [
      { id: 'g1', href: '/gem/g1', name: 'Writer' },
      { id: 'g2', href: '/gem/g2', name: 'Coder' },
    ];
    (chrome.storage.sync.get as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({
      [StorageKeys.GV_GEMS_PINNED]: [],
    });
  });

  afterEach(() => {
    stop?.();
    stop = null;
    document.body.innerHTML = '';
  });

  async function start(): Promise<void> {
    const { startGemsSidebar } = await import('../index');
    stop = await startGemsSidebar();
    await settle();
  }

  it('does not read layout while conversation rows stream into the sidebar', async () => {
    const { nav, conversations } = mountSidebar();
    await start();
    const entry = nav.querySelector('gem-nav-list-item')!;
    expect(entry.nextElementSibling?.classList.contains('gv-gems-inline-list')).toBe(true);

    rectReads = 0;
    await streamRows(conversations, 50);

    expect(rectReads).toBe(0);
    expect(entry.nextElementSibling?.classList.contains('gv-gems-inline-list')).toBe(true);
    expect(entry.querySelector('.gv-gems-expand-toggle')).not.toBeNull();
  });

  it('does not read layout while rows stream in and there are no gems to show', async () => {
    storageState.catalog = [];
    const { conversations } = mountSidebar();
    await start();

    rectReads = 0;
    await streamRows(conversations, 20);

    expect(rectReads).toBe(0);
    expect(document.querySelector('.gv-gems-inline-list')).toBeNull();
  });

  it('follows Gemini when it re-renders the Gems entry', async () => {
    const { nav } = mountSidebar();
    await start();
    const oldEntry = nav.querySelector('gem-nav-list-item')!;
    const replacement = createGemsEntry();

    oldEntry.replaceWith(replacement);
    await settle();

    expect(replacement.nextElementSibling?.classList.contains('gv-gems-inline-list')).toBe(true);
    expect(replacement.querySelector('.gv-gems-expand-toggle')).not.toBeNull();
    expect(document.querySelectorAll('.gv-gems-inline-list')).toHaveLength(1);
  });

  it('moves the list back when Gemini inserts a node between the entry and the list', async () => {
    const { nav } = mountSidebar();
    await start();
    const entry = nav.querySelector('gem-nav-list-item')!;
    const list = entry.nextElementSibling!;

    entry.insertAdjacentElement('afterend', document.createElement('side-nav-entry'));
    await settle();

    expect(entry.nextElementSibling).toBe(list);
  });

  it('remounts the list when Gemini removes it', async () => {
    const { nav } = mountSidebar();
    await start();
    const entry = nav.querySelector('gem-nav-list-item')!;

    entry.nextElementSibling!.remove();
    await settle();

    expect(entry.nextElementSibling?.classList.contains('gv-gems-inline-list')).toBe(true);
    expect(entry.nextElementSibling?.textContent).toContain('Writer');
  });
});
