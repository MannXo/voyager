import { describe, expect, it, vi } from 'vitest';

import { StorageKeys } from '@/core/types/common';
import type { PromptItem } from '@/core/types/sync';
import {
  type PromptLibraryOp,
  createPromptLibraryOwner,
} from '@/features/prompt/library/promptLibraryOwner';

import { createPromptLibraryState, parseLegacyPromptLibrary } from '../promptLibraryState';

const KEY = StorageKeys.PROMPT_ITEMS;

const prompt = (id: string, text: string, extra: Partial<PromptItem> = {}): PromptItem => ({
  id,
  name: id.toUpperCase(),
  text,
  tags: [],
  createdAt: 1,
  ...extra,
});

/**
 * A Prompt Manager tab over an in-memory library and its owner, with a clock
 * that counts up from 100. `hold(later)` keeps the reply to the op sent
 * `later` ops from now from reaching the tab until released, `holdRead()` the
 * tab's next read of storage; `failNext()` makes the next write fail and
 * `lose(later)` a reply go missing after the write.
 */
async function tab(initial: unknown, legacy: string | null = null) {
  let stored: unknown = structuredClone(initial);
  let failWrite = false;
  const area = {
    get: async () => (stored === undefined ? {} : { [KEY]: structuredClone(stored) }),
    set: async (items: Record<string, unknown>) => {
      if (failWrite) {
        failWrite = false;
        throw new Error('quota');
      }
      stored = structuredClone(items[KEY]);
    },
  };
  const owner = createPromptLibraryOwner({ area, now: () => 500 });
  const gates = new Map<number, Promise<void>>();
  let readGate: Promise<void> | null = null;
  const lost = new Set<number>();
  const deliveries = new Map<number, Promise<void>>();
  const sent: PromptLibraryOp[] = [];
  const onReconcile = vi.fn();
  const onWriteFailed = vi.fn();
  let clock = 100;
  let id = 0;
  const state = createPromptLibraryState({
    read: async () => {
      const value = ((await area.get())[KEY] ?? []) as PromptItem[];
      const gate = readGate;
      readGate = null;
      if (gate) await gate;
      return value;
    },
    apply: async (op) => {
      const index = sent.length;
      sent.push(structuredClone(op));
      await deliveries.get(index);
      const result = owner.apply(structuredClone(op));
      await gates.get(index);
      if (!lost.has(index)) return result;
      await result;
      throw new Error('The message port closed before a response was received.');
    },
    readLegacy: () => legacy,
    onReconcile,
    onWriteFailed,
    now: () => clock++,
    makeId: () => `new-${++id}`,
  });
  await state.load();
  return {
    state,
    sent,
    onReconcile,
    onWriteFailed,
    stored: () => stored,
    /** Another writer changes the library behind this tab's back. */
    setStored: (value: unknown) => {
      stored = structuredClone(value);
    },
    failNext: () => {
      failWrite = true;
    },
    hold: (later = 0) => {
      let release!: () => void;
      gates.set(sent.length + later, new Promise<void>((resolve) => (release = resolve)));
      return release;
    },
    holdRead: () => {
      let release!: () => void;
      readGate = new Promise<void>((resolve) => (release = resolve));
      return release;
    },
    /** Holds the op sent `later` ops from now on its way to the owner. */
    delay: (later = 0) => {
      let release!: () => void;
      deliveries.set(sent.length + later, new Promise<void>((resolve) => (release = resolve)));
      return release;
    },
    /** The op sent `later` ops from now is written, but its reply is lost. */
    lose: (later = 0) => {
      lost.add(sent.length + later);
    },
  };
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

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

  it('reports an add the owner refused because another tab took the text first', async () => {
    const { state, stored, setStored } = await tab([prompt('a', 'Alpha')]);
    setStored([prompt('z', 'Beta'), prompt('a', 'Alpha')]);

    await expect(state.add({ name: 'B', text: 'beta', tags: [] })).resolves.toBe('duplicate');
    expect(stored()).toEqual([prompt('z', 'Beta'), prompt('a', 'Alpha')]);
    expect(state.items).toEqual(stored());
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
    expect(state.items).toEqual(stored());
  });

  it('reports an edit of a prompt another tab deleted meanwhile as missing', async () => {
    const { state, stored, setStored } = await tab([prompt('a', 'Alpha'), prompt('b', 'Beta')]);
    setStored([prompt('a', 'Alpha')]);

    await expect(state.edit('b', { name: 'B', text: 'Beta 2', tags: [] })).resolves.toBe('missing');
    expect(stored()).toEqual([prompt('a', 'Alpha')]);
    expect(state.items).toEqual(stored());
  });

  it('deletes, pins, unpins and reorders, bumping updatedAt on a pin change', async () => {
    const { state, stored } = await tab([prompt('a', 'A'), prompt('b', 'B'), prompt('c', 'C')]);

    state.togglePin('b');
    state.remove('a');
    state.reorder([state.items[1], state.items[0]]);
    // Each change shows at once, before the owner has written it.
    expect(state.items).toEqual([
      prompt('c', 'C'),
      prompt('b', 'B', { pinnedAt: 100, updatedAt: 100 }),
    ]);
    await flush();
    expect(stored()).toEqual(state.items);

    state.togglePin('b');
    await flush();
    expect(JSON.stringify(stored())).toBe(
      JSON.stringify([prompt('c', 'C'), { ...prompt('b', 'B'), updatedAt: 101 }]),
    );
    expect(state.items).toEqual(stored());
  });

  it('ignores its own echo and adopts a library changed elsewhere', async () => {
    const { state } = await tab([prompt('a', 'A')]);
    await state.add({ name: 'B', text: 'B', tags: [] });

    expect(state.receive(structuredClone(state.items))).toBe(false);
    expect(state.receive({ not: 'a list' })).toBe(false);
    expect(state.receive([prompt('z', 'From another tab')])).toBe(true);
    expect(state.items).toEqual([prompt('z', 'From another tab')]);
  });

  it('holds back echoes while its ops are in flight, then shows what the owner wrote', async () => {
    const { state, stored, hold, onReconcile } = await tab([prompt('a', 'A'), prompt('b', 'B')]);
    const release = hold();

    state.reorder([state.items[1], state.items[0]]);
    // An echo of the library from before the drop must not undo it.
    expect(state.receive([prompt('a', 'A'), prompt('b', 'B')])).toBe(false);
    expect(state.items.map((item) => item.id)).toEqual(['b', 'a']);

    release();
    await flush();
    expect(stored()).toEqual([prompt('b', 'B'), prompt('a', 'A')]);
    expect(state.items).toEqual(stored());
    expect(onReconcile).not.toHaveBeenCalled();
  });

  it("takes another writer's change that arrived while its op was in flight", async () => {
    const { state, stored, setStored, hold, onReconcile } = await tab([prompt('a', 'A')]);
    const release = hold();

    state.togglePin('a');
    setStored([prompt('a', 'A'), prompt('t', 'Template')]);
    state.receive([prompt('a', 'A'), prompt('t', 'Template')]);
    release();
    await flush();

    expect(stored()).toEqual([
      prompt('a', 'A', { pinnedAt: 100, updatedAt: 100 }),
      prompt('t', 'Template'),
    ]);
    expect(state.items).toEqual(stored());
    expect(onReconcile).toHaveBeenCalledWith('changed');
  });

  it('rolls back to the stored library when a write fails, and keeps working', async () => {
    const { state, stored, failNext, onReconcile, onWriteFailed } = await tab([
      prompt('a', 'A'),
      prompt('b', 'B'),
    ]);

    failNext();
    state.reorder([state.items[1], state.items[0]]);
    expect(state.items.map((item) => item.id)).toEqual(['b', 'a']);
    await flush();
    expect(state.items).toEqual([prompt('a', 'A'), prompt('b', 'B')]);
    expect(onReconcile).toHaveBeenCalledWith('failed');
    expect(onWriteFailed).toHaveBeenCalledTimes(1);

    failNext();
    await expect(state.add({ name: 'C', text: 'C', tags: [] })).resolves.toBe('failed');
    expect(state.items).toEqual([prompt('a', 'A'), prompt('b', 'B')]);
    expect(onWriteFailed).toHaveBeenCalledTimes(2);

    failNext();
    await expect(state.remove('a')).resolves.toBe(false);
    expect(state.items).toEqual([prompt('a', 'A'), prompt('b', 'B')]);
    expect(onWriteFailed).toHaveBeenCalledTimes(3);

    await expect(state.remove('a')).resolves.toBe(true);
    expect(stored()).toEqual([prompt('b', 'B')]);
    expect(state.items).toEqual(stored());
    expect(onWriteFailed).toHaveBeenCalledTimes(3);
  });

  it("sends a tab's ops one at a time, so a late message cannot reorder them", async () => {
    const { state, stored, sent, delay } = await tab([
      prompt('a', 'A'),
      prompt('b', 'B'),
      prompt('c', 'C'),
    ]);
    // The first drop's message is slow to arrive; the second must not overtake it.
    const deliverFirst = delay();

    state.reorder([state.items[2], state.items[0], state.items[1]]);
    state.reorder([state.items[1], state.items[0], state.items[2]]);
    await flush();
    expect(sent).toHaveLength(1);

    deliverFirst();
    await flush();
    expect(sent).toHaveLength(2);
    expect(stored()).toEqual([prompt('a', 'A'), prompt('c', 'C'), prompt('b', 'B')]);
    expect(state.items).toEqual(stored());
  });

  it('rolls back when the owner cannot be reached', async () => {
    const onReconcile = vi.fn();
    const state = createPromptLibraryState({
      read: async () => [prompt('a', 'A'), prompt('b', 'B')],
      apply: () => Promise.reject(new Error('Extension context invalidated.')),
      onReconcile,
    });
    await state.load();

    await expect(state.edit('a', { name: 'A', text: 'A 2', tags: [] })).resolves.toBe('failed');
    expect(state.items).toEqual([prompt('a', 'A'), prompt('b', 'B')]);
    expect(onReconcile).toHaveBeenCalledWith('failed');
  });

  it('keeps the newest drop when overlapping drops settle', async () => {
    const { state, stored, hold } = await tab([
      prompt('a', 'A'),
      prompt('b', 'B'),
      prompt('c', 'C'),
    ]);
    const releaseFirst = hold();

    state.reorder([state.items[2], state.items[0], state.items[1]]);
    state.reorder([state.items[1], state.items[0], state.items[2]]);
    expect(state.items.map((item) => item.id)).toEqual(['a', 'c', 'b']);
    // The second drop's reply comes back first; the first drop's reply is older.
    await flush();
    releaseFirst();
    await flush();

    expect(stored()).toEqual([prompt('a', 'A'), prompt('c', 'C'), prompt('b', 'B')]);
    expect(state.items).toEqual(stored());
  });

  it('keeps showing a later change while its reply is still on the way', async () => {
    const { state, stored, hold } = await tab([prompt('a', 'A'), prompt('b', 'B')]);
    const releaseSecond = hold(1);

    state.togglePin('b');
    state.remove('a');
    await flush();
    // The pin's reply is in, from before the delete: the delete still shows.
    expect(state.items.map((item) => item.id)).toEqual(['b']);

    releaseSecond();
    await flush();
    expect(stored()).toEqual([prompt('b', 'B', { pinnedAt: 100, updatedAt: 100 })]);
    expect(state.items).toEqual(stored());
  });

  it("takes another writer's change made after its op was written, before the reply", async () => {
    const { state, stored, setStored, hold, onReconcile } = await tab([prompt('a', 'A')]);
    const release = hold();

    state.togglePin('a');
    await flush();
    const later = [...(stored() as PromptItem[]), prompt('d', 'From Drive')];
    setStored(later);
    expect(state.receive(later)).toBe(false);
    release();
    await flush();

    expect(state.items).toEqual(later);
    expect(onReconcile).toHaveBeenCalledWith('changed');
  });

  it('shows a change whose reply was lost though it was written', async () => {
    const { state, stored, lose } = await tab([prompt('a', 'A'), prompt('b', 'B')]);
    // The worker restarted after writing the delete, so its reply never came.
    lose(1);

    state.togglePin('a');
    state.remove('b');
    await flush();
    expect(stored()).toEqual([prompt('a', 'A', { pinnedAt: 100, updatedAt: 100 })]);
    expect(state.items).toEqual(stored());
  });

  it('does not let a re-read that started before a new change overwrite it', async () => {
    const { state, stored, failNext, hold, holdRead } = await tab([
      prompt('a', 'A'),
      prompt('b', 'B'),
    ]);

    failNext();
    const releaseRead = holdRead();
    state.reorder([state.items[1], state.items[0]]);
    await flush();
    // The failed drop is re-reading storage; meanwhile the user deletes a prompt.
    const releaseDelete = hold();
    state.remove('a');
    releaseRead();
    await flush();
    expect(state.items.map((item) => item.id)).toEqual(['b']);

    releaseDelete();
    await flush();
    expect(stored()).toEqual([prompt('b', 'B')]);
    expect(state.items).toEqual(stored());
  });

  it('seeds a legacy localStorage library on load, only into an empty one', async () => {
    const legacy = [{ id: 'legacy', text: 'Old', tags: [], createdAt: 1, extra: true }];
    const seeded = await tab(undefined, JSON.stringify(legacy));
    expect(seeded.stored()).toEqual(legacy);
    expect(seeded.state.items).toEqual(legacy);

    const existing = await tab([prompt('a', 'A')], JSON.stringify(legacy));
    expect(existing.stored()).toEqual([prompt('a', 'A')]);
    expect(existing.state.items).toEqual([prompt('a', 'A')]);

    const corrupt = await tab(undefined, '{"not":"a list"}');
    expect(corrupt.sent).toEqual([]);
    expect(corrupt.stored()).toBeUndefined();
  });

  it('loads the stored library when the seed cannot reach the owner', async () => {
    const state = createPromptLibraryState({
      read: async () => [prompt('a', 'A')],
      apply: () => Promise.reject(new Error('Could not establish connection.')),
      readLegacy: () => '[{"id":"legacy","text":"Old"}]',
    });
    await expect(state.load()).resolves.toEqual([prompt('a', 'A')]);
  });

  it('only treats a JSON list of records in localStorage as a legacy library', () => {
    expect(parseLegacyPromptLibrary(null)).toBeNull();
    expect(parseLegacyPromptLibrary('not json')).toBeNull();
    expect(parseLegacyPromptLibrary('{"id":"a"}')).toBeNull();
    expect(parseLegacyPromptLibrary('[1, 2]')).toBeNull();
    expect(parseLegacyPromptLibrary('[{"id":"a","text":"A"}]')).toEqual([{ id: 'a', text: 'A' }]);
    expect(parseLegacyPromptLibrary('[]')).toEqual([]);
  });
});
