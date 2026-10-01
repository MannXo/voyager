import { describe, expect, it } from 'vitest';

import type { PromptItem } from '@/core/types/sync';

import { createPromptLibraryState } from '../promptLibraryState';

const prompt = (id: string, text: string, extra: Partial<PromptItem> = {}): PromptItem => ({
  id,
  name: id.toUpperCase(),
  text,
  tags: [],
  createdAt: 1,
  ...extra,
});

/** A Prompt Manager tab over an in-memory library, with a clock that counts up from 100. */
async function tab(initial: PromptItem[]) {
  let stored: unknown = structuredClone(initial);
  const writes: unknown[] = [];
  let clock = 100;
  let id = 0;
  const state = createPromptLibraryState({
    read: async () => structuredClone(stored) as PromptItem[],
    write: async (items) => {
      stored = structuredClone(items);
      writes.push(stored);
    },
    now: () => clock++,
    makeId: () => `new-${++id}`,
  });
  await state.load();
  await Promise.resolve();
  return { state, stored: () => stored, writes };
}

describe('Prompt Manager library state', () => {
  it('adds a prompt ahead of the library, refusing text it already has', async () => {
    const { state, stored } = await tab([prompt('a', 'Alpha')]);

    await expect(state.add({ name: 'B', text: 'Beta', tags: ['x'] })).resolves.toBe('added');
    await expect(state.add({ name: 'C', text: '  ALPHA ', tags: [] })).resolves.toBe('duplicate');

    const expected = [
      { id: 'new-1', name: 'B', text: 'Beta', tags: ['x'], createdAt: 100 },
      prompt('a', 'Alpha'),
    ];
    expect(state.items).toEqual(expected);
    expect(stored()).toEqual(expected);
  });

  it('edits a prompt in place, keeping its position and stamping updatedAt', async () => {
    const { state, stored } = await tab([prompt('a', 'Alpha'), prompt('b', 'Beta')]);

    await expect(state.edit('b', { name: 'Bee', text: 'Beta 2', tags: ['t'] })).resolves.toBe(
      'saved',
    );
    await expect(state.edit('b', { name: 'Bee', text: 'alpha', tags: [] })).resolves.toBe(
      'duplicate',
    );
    await expect(state.edit('gone', { name: 'X', text: 'X', tags: [] })).resolves.toBe('missing');

    expect(JSON.stringify(stored())).toBe(
      JSON.stringify([
        prompt('a', 'Alpha'),
        { id: 'b', name: 'Bee', text: 'Beta 2', tags: ['t'], createdAt: 1, updatedAt: 100 },
      ]),
    );
  });

  it('deletes, pins, unpins and reorders, bumping updatedAt on a pin change', async () => {
    const { state, stored } = await tab([prompt('a', 'A'), prompt('b', 'B'), prompt('c', 'C')]);

    state.togglePin('b');
    state.remove('a');
    state.reorder([state.items[1], state.items[0]]);
    await Promise.resolve();
    expect(stored()).toEqual([
      prompt('c', 'C'),
      prompt('b', 'B', { pinnedAt: 100, updatedAt: 100 }),
    ]);

    state.togglePin('b');
    await Promise.resolve();
    expect(JSON.stringify(stored())).toBe(
      JSON.stringify([prompt('c', 'C'), { ...prompt('b', 'B'), updatedAt: 101 }]),
    );
  });

  it('ignores its own echo and adopts a library changed elsewhere', async () => {
    const { state } = await tab([prompt('a', 'A')]);
    await state.add({ name: 'B', text: 'B', tags: [] });

    expect(state.receive(structuredClone(state.items))).toBe(false);
    expect(state.receive({ not: 'a list' })).toBe(false);
    expect(state.receive([prompt('z', 'From another tab')])).toBe(true);
    expect(state.items).toEqual([prompt('z', 'From another tab')]);
  });
});
