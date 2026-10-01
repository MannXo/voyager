import { describe, expect, it } from 'vitest';

import { mergeImportedPrompts } from '@/features/backup/services/PromptImportExportService';
import type { PromptItem } from '@/features/backup/types/backup';

import {
  createPromptLibraryClient,
  handlePromptLibraryApplyMessage,
  parsePromptLibraryOp,
} from '../promptLibraryMessages';
import {
  PROMPT_LIBRARY_KEY,
  type PromptLibraryArea,
  createPromptLibraryOwner,
} from '../promptLibraryOwner';

/** One storage area; `gate` holds every read until released, to force interleaving. */
function memoryArea(initial?: unknown) {
  const data = new Map<string, unknown>(
    initial === undefined ? [] : [[PROMPT_LIBRARY_KEY, structuredClone(initial)]],
  );
  let writes = 0;
  const area: PromptLibraryArea = {
    get: async (key) => (data.has(key) ? { [key]: structuredClone(data.get(key)) } : {}),
    set: async (items) => {
      writes += 1;
      for (const [key, value] of Object.entries(items)) data.set(key, structuredClone(value));
    },
  };
  return {
    area,
    stored: () => data.get(PROMPT_LIBRARY_KEY),
    /** A write that bypasses the owner, as an unrouted writer would. */
    writeDirect: (value: unknown) => data.set(PROMPT_LIBRARY_KEY, structuredClone(value)),
    writes: () => writes,
  };
}

const prompt = (id: string, text: string, extra: Partial<PromptItem> = {}): PromptItem => ({
  id,
  text,
  tags: [],
  createdAt: 1,
  ...extra,
});

describe('prompt library owner', () => {
  it('keeps both of two adds sent at the same moment', async () => {
    const { area, stored } = memoryArea([prompt('a', 'Existing')]);
    const owner = createPromptLibraryOwner({ area });

    await Promise.all([
      owner.apply({ kind: 'add', items: [prompt('t1', 'From tab one')] }),
      owner.apply({ kind: 'add', items: [prompt('t2', 'From tab two')] }),
    ]);

    expect((stored() as PromptItem[]).map((item) => item.id).sort()).toEqual(['a', 't1', 't2']);
  });

  it('applies each op to the library as stored when it runs, not as it was when sent', async () => {
    const { area, stored, writeDirect } = memoryArea([prompt('a', 'Old text')]);
    const owner = createPromptLibraryOwner({ area });
    writeDirect([prompt('a', 'Edited elsewhere')]);

    await owner.apply({ kind: 'add', items: [prompt('t', 'Template')] });

    expect(stored()).toEqual([prompt('t', 'Template'), prompt('a', 'Edited elsewhere')]);
  });

  it('adds only prompts whose id, text and name are all free, and writes others back as stored', async () => {
    const original = [
      { id: 'a', text: 'Alpha', tags: ['x'], createdAt: 1, name: 'First', extra: { kept: true } },
      'legacy junk',
    ];
    const { area, stored, writes } = memoryArea(original);
    const owner = createPromptLibraryOwner({ area });

    const result = await owner.apply({
      kind: 'add',
      items: [
        prompt('a', 'Different text'),
        prompt('b', '  ALPHA '),
        prompt('c', 'New', { name: 'first' }),
        prompt('d', 'Fresh one', { name: 'Fresh' }),
        prompt('e', 'Fresh two', { name: 'Fresh' }),
      ],
    });

    expect(result).toEqual({ added: 1, skipped: 4, total: 3, nameConflicts: 0 });
    expect(stored()).toEqual([prompt('d', 'Fresh one', { name: 'Fresh' }), ...original]);
    expect(writes()).toBe(1);

    await owner.apply({ kind: 'add', items: [prompt('z', 'alpha')] });
    expect(writes()).toBe(1);
  });

  it('updates, deletes and reorders by id, leaving prompts it was not told about in place', async () => {
    const { area, stored } = memoryArea([
      prompt('a', 'A', { pinnedAt: 5 }),
      prompt('b', 'B'),
      prompt('new', 'Added meanwhile'),
      prompt('c', 'C'),
    ]);
    const owner = createPromptLibraryOwner({ area });

    await owner.apply({ kind: 'update', id: 'a', changes: { text: 'A2', pinnedAt: null } });
    await owner.apply({ kind: 'reorder', ids: ['c', 'b', 'a'] });
    await owner.apply({ kind: 'delete', id: 'b' });
    await owner.apply({ kind: 'update', id: 'missing', changes: { text: 'X' } });

    expect(stored()).toEqual([
      prompt('c', 'C'),
      prompt('new', 'Added meanwhile'),
      prompt('a', 'A2'),
    ]);
  });

  it('imports exactly as the prompts import merges', async () => {
    const library = [prompt('a', 'Alpha', { tags: ['x'] }), prompt('b', 'Beta')];
    const incoming = [prompt('z', 'alpha', { tags: ['y'] }), prompt('c', 'Gamma')];
    const { area, stored } = memoryArea(library);
    const owner = createPromptLibraryOwner({ area, now: () => 50 });

    const result = await owner.apply({ kind: 'import', items: structuredClone(incoming) });
    const expected = mergeImportedPrompts(structuredClone(library), structuredClone(incoming), 50);

    expect(stored()).toEqual(expected.items);
    expect(result).toEqual({ added: 1, skipped: 1, total: 3, nameConflicts: 0 });
  });

  it('never overwrites a stored value that is not a list, and goes on with the next op', async () => {
    const { area, stored, writeDirect } = memoryArea({ not: 'a list' });
    const owner = createPromptLibraryOwner({ area });

    await expect(owner.apply({ kind: 'add', items: [prompt('a', 'A')] })).rejects.toThrow();
    expect(stored()).toEqual({ not: 'a list' });

    writeDirect([]);
    await owner.apply({ kind: 'add', items: [prompt('a', 'A')] });
    expect(stored()).toEqual([prompt('a', 'A')]);
  });

  it('lets an in-process merge run on the fresh library between queued writes', async () => {
    const { area, stored } = memoryArea([]);
    const owner = createPromptLibraryOwner({ area });

    const pending = [
      owner.apply({ kind: 'add', items: [prompt('t', 'Template')] }),
      owner.transact((items) => ({
        items: [...items, prompt('d', 'From Drive')],
        result: items.length,
      })),
    ];

    await expect(Promise.all(pending)).resolves.toEqual([
      { added: 1, skipped: 0, total: 1, nameConflicts: 0 },
      1,
    ]);
    expect(stored()).toEqual([prompt('t', 'Template'), prompt('d', 'From Drive')]);
  });
});

describe('prompt library messages', () => {
  it('accepts only well-formed ops, rebuilt from their known fields', () => {
    expect(
      parsePromptLibraryOp({ kind: 'add', items: [{ ...prompt('a', 'A'), injected: '<b>' }] }),
    ).toEqual({ kind: 'add', items: [prompt('a', 'A')] });
    for (const op of [
      null,
      { kind: 'wipe' },
      { kind: 'add', items: [] },
      { kind: 'add', items: [{ id: 'a', text: '  ', tags: [], createdAt: 1 }] },
      { kind: 'add', items: [{ id: 'a', text: 'A', tags: 'x', createdAt: 1 }] },
      { kind: 'import', items: [{ id: '', text: 'A', tags: [], createdAt: 1 }] },
      { kind: 'update', id: 'a', changes: { text: 5 } },
      { kind: 'update', id: 'a', changes: { pinnedAt: 'now' } },
      { kind: 'delete' },
      { kind: 'reorder', ids: ['a', 1] },
    ]) {
      expect(parsePromptLibraryOp(op)).toBeNull();
    }
  });

  it('carries an op from a writer to the owner and its result back', async () => {
    const { area, stored } = memoryArea([]);
    const owner = createPromptLibraryOwner({ area });
    const client = createPromptLibraryClient((request) =>
      handlePromptLibraryApplyMessage(structuredClone(request), owner),
    );

    await expect(client.apply({ kind: 'add', items: [prompt('a', 'A')] })).resolves.toEqual({
      added: 1,
      skipped: 0,
      total: 1,
      nameConflicts: 0,
    });
    expect(stored()).toEqual([prompt('a', 'A')]);

    const refused = createPromptLibraryClient(async () => ({ ok: false, error: 'invalid_op' }));
    await expect(refused.apply({ kind: 'delete', id: 'a' })).rejects.toThrow('invalid_op');
    await expect(
      handlePromptLibraryApplyMessage({ type: 'gv.promptLibrary.apply', op: { kind: 'x' } }, owner),
    ).resolves.toEqual({ ok: false, error: 'invalid_op' });
  });
});
