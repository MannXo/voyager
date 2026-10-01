import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { StorageKeys } from '@/core/types/common';
import { PromptImportExportService } from '@/features/backup/services/PromptImportExportService';
import type { PromptItem } from '@/features/backup/types/backup';
import {
  type PromptLibraryArea,
  createPromptLibraryOwner,
} from '@/features/prompt/library/promptLibraryOwner';

import { mergeCloudPrompts, mergeCloudPromptsForUpload } from '../promptDriveMerge';

const KEY = StorageKeys.PROMPT_ITEMS;

/** One device: its stored library and the background owner that writes it. */
function device(initial: PromptItem[]) {
  const data = new Map<string, unknown>([[KEY, structuredClone(initial)]]);
  const area: PromptLibraryArea = {
    get: async (key) => (data.has(key) ? { [key]: structuredClone(data.get(key)) } : {}),
    set: async (items) => {
      for (const [key, value] of Object.entries(items)) data.set(key, structuredClone(value));
    },
  };
  const owner = createPromptLibraryOwner({ area });
  return {
    owner,
    stored: () => data.get(KEY) as PromptItem[],
    /** Edits a prompt as Prompt Manager does: the change carries the edit time. */
    edit: (id: string, text: string, at: number) =>
      owner.apply({ kind: 'update', id, changes: { text, updatedAt: at } }),
    pull: (drive: unknown) => mergeCloudPrompts(owner, drive),
    /** Merges Drive into the library, then returns the Drive file the push uploads. */
    push: async (drive: unknown) =>
      PromptImportExportService.exportToPayload(
        (await mergeCloudPromptsForUpload(owner, drive)) ?? [],
      ),
  };
}

const textOf = (items: PromptItem[], id: string) => items.find((item) => item.id === id)?.text;

/** Pins the wall clock, which is when a merge runs, not when a prompt was edited. */
const clock = (at: number) => vi.setSystemTime(at);

describe('prompt edit times through the prompts-only Drive merges', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] });
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('keeps an edit made elsewhere after this device merged an unchanged copy', async () => {
    const original: PromptItem = {
      id: 'p',
      text: 'Original',
      tags: [],
      createdAt: 1,
      updatedAt: 10,
    };
    const laptop = device([original]);
    const desktop = device([original]);
    let drive = await laptop.push(null);

    // The desktop syncs at 100 without changing anything.
    clock(100);
    drive = await desktop.push(drive);
    await desktop.pull(drive);
    expect(desktop.stored()).toEqual([original]);

    // The laptop edits at 20 and pushes; the desktop must take the edit.
    await laptop.edit('p', 'Edited on the laptop', 20);
    clock(110);
    drive = await laptop.push(drive);
    await desktop.pull(drive);

    expect(textOf(desktop.stored(), 'p')).toBe('Edited on the laptop');
    expect(desktop.stored()[0].updatedAt).toBe(20);
  });

  it('keeps the later of two edits when the earlier one is pushed last', async () => {
    const original: PromptItem = { id: 'p', text: 'Original', tags: [], createdAt: 1 };
    const a = device([original]);
    const b = device([original]);
    let drive = await a.push(null);

    await a.edit('p', 'Edit from A', 20);
    await b.edit('p', 'Edit from B', 30);
    clock(100);
    drive = await a.push(drive);
    clock(110);
    await b.pull(drive);
    expect(textOf(b.stored(), 'p')).toBe('Edit from B');

    drive = await b.push(drive);
    await a.pull(drive);
    expect(textOf(a.stored(), 'p')).toBe('Edit from B');
  });

  it('keeps the creation time of a prompt it adds, so a later edit elsewhere still wins', async () => {
    const a = device([{ id: 'p', text: 'Original', tags: [], createdAt: 1 }]);
    const b = device([]);
    let drive = await a.push(null);

    // The edit happens at 50 but reaches Drive only after B pulled at 100.
    await a.edit('p', 'Edited at 50', 50);
    clock(100);
    await b.pull(drive);
    expect(b.stored()).toEqual([{ id: 'p', text: 'Original', tags: [], createdAt: 1 }]);

    clock(120);
    drive = await a.push(drive);
    await b.pull(drive);
    expect(textOf(b.stored(), 'p')).toBe('Edited at 50');
  });

  it('changes nothing when the same Drive file is merged again', async () => {
    const library: PromptItem[] = [
      { id: 'a', text: 'A', tags: ['x'], createdAt: 1, updatedAt: 5, name: 'Alpha' },
      { id: 'b', text: 'B', tags: [], createdAt: 2, pinnedAt: 3, updatedAt: 3 },
      { id: 'c', text: 'C', tags: [], createdAt: 4 },
    ];
    const local = device(library);
    const drive = PromptImportExportService.exportToPayload(structuredClone(library));

    clock(100);
    await local.pull(drive);
    clock(200);
    const uploaded = await local.push(drive);
    await local.pull(uploaded);

    expect(local.stored()).toEqual(library);
    expect(uploaded.items).toEqual(library);
  });

  it('settles two copies edited at the same moment on the same text on both devices', async () => {
    const original: PromptItem = { id: 'p', text: 'Original', tags: [], createdAt: 1 };
    const a = device([original]);
    const b = device([original]);
    let drive = await a.push(null);

    await a.edit('p', 'Apple', 20);
    await b.edit('p', 'Banana', 20);
    drive = await a.push(drive);
    drive = await b.push(drive);
    await a.pull(drive);

    expect(textOf(a.stored(), 'p')).toBe(textOf(b.stored(), 'p'));
  });
});
