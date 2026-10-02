import { describe, expect, it, vi } from 'vitest';

import type { EditOutcome } from '@/features/folder/commands/folderCommands';

import { ALLOWANCE_BYTES, granted, isFresh } from '../client/clientAllowance';
import { FolderClient } from '../client/folderClient';
import type { FolderOwnerCore } from '../folderOwnerCore';
import type { FolderOwnerRequest, FolderOwnerResponse } from '../folderOwnerMessages';
import { FOLDER_SITE_POLICIES } from '../folderOwnerPolicy';
import { dispatchFolderOwnerRequest } from '../folderOwnerRequests';
import type { FolderOwnerStorageArea } from '../folderOwnerState';
import { createFaultyStorage } from './faultyStorage';
import { KEY, createWorld, folder, folderData, pendingKeys } from './ownerHarness';

const until = (check: () => void) => vi.waitFor(check, { timeout: 2000, interval: 1 });
const MINUTE = 60_000;

/** A client over a real owner, with both clocks under the test's control and every call logged. */
function allowanceWorld() {
  const storage = createFaultyStorage({ [KEY]: folderData([folder('F', 'A')]) });
  const world = createWorld(storage);
  const owner: FolderOwnerCore = world.process();
  let monotonic = 0;
  const log: string[] = [];
  let held: { until: Promise<void> } | null = null;
  const area: FolderOwnerStorageArea = {
    ...storage.area,
    set: (items) => {
      log.push('set');
      return storage.area.set(items);
    },
  };
  const client = new FolderClient({
    key: KEY,
    policy: FOLDER_SITE_POLICIES.gemini,
    area,
    send: async (request: FolderOwnerRequest): Promise<FolderOwnerResponse> => {
      log.push(request.type.replace('gv.folderOwner.', ''));
      const reply = await dispatchFolderOwnerRequest(request, owner);
      if (request.type === 'gv.folderOwner.apply' && held) await held.until;
      return reply;
    },
    subscribe: storage.subscribe,
    now: world.now,
    monotonic: () => monotonic,
    newId: () => 'client-1',
    setTimer: () => () => {},
  });
  return {
    storage,
    client,
    log,
    /** Moves the wall clock and the monotonic clock by their own amounts. */
    advance(wallMs: number, monotonicMs = wallMs) {
      world.advance(wallMs);
      monotonic += monotonicMs;
    },
    holdApplyReplies() {
      let open!: () => void;
      held = { until: new Promise<void>((resolve) => (open = resolve)) };
      return () => {
        held = null;
        open();
      };
    },
  };
}

const create = (id: string, name = id) =>
  ({ kind: 'createFolder', folderId: id, name, parentId: null }) as const;

/** The calls made after the `n`th logged call. */
const after = (log: string[], n: number) => log.slice(n);

describe('FolderClient pending allowance (addendum P3P4 R3.2)', () => {
  it('writes pending keys without re-opening while the allowance is fresh', async () => {
    const { client, log, advance } = allowanceWorld();
    await client.open();
    advance(5 * MINUTE);
    const mark = log.length;

    await expect(client.run(create('X'))).resolves.toMatchObject({ kind: 'saved' });
    expect(after(log, mark)[0]).toBe('set');
  });

  it('T26c: dates the allowance from the send, so a reply held past the TTL grants nothing', async () => {
    const { client, log, advance, holdApplyReplies } = allowanceWorld();
    await client.open();
    const release = holdApplyReplies();
    const first = client.run(create('X'));
    await until(() => expect(log).toContain('apply'));
    advance(31 * MINUTE);
    release();
    await expect(first).resolves.toMatchObject({ kind: 'saved' });
    const mark = log.length;

    await expect(client.run(create('Y'))).resolves.toMatchObject({ kind: 'saved' });
    expect(after(log, mark).slice(0, 2)).toEqual(['open', 'set']);
  });

  it.each([
    ['the wall clock passes the TTL while the monotonic clock slept (T26g)', 40 * MINUTE, 1000],
    ['the two clocks disagree by more than a minute', 5 * MINUTE, 1000],
    ['the wall clock went back', -10_000, 1000],
    ['only the monotonic clock passes the TTL', 29.5 * MINUTE, 30.5 * MINUTE],
  ])('re-opens before the next pending key when %s', async (_, wallMs, monotonicMs) => {
    const { client, log, advance } = allowanceWorld();
    await client.open();
    advance(wallMs, monotonicMs);
    const mark = log.length;

    await expect(client.run(create('X'))).resolves.toMatchObject({ kind: 'saved' });
    expect(after(log, mark).slice(0, 2)).toEqual(['open', 'set']);
  });

  it('treats a reply without a usable TTL as granting no allowance, and keeps the later grant', () => {
    const clocks = { wall: () => 1000, monotonic: () => 1000 };
    const sent = { wall: 1000, monotonic: 1000 };
    for (const ttl of [undefined, Number.NaN, -1, Infinity]) {
      expect(isFresh(granted(sent, ttl, null), clocks)).toBe(false);
    }
    const later = granted({ wall: 990, monotonic: 990 }, 30 * MINUTE, null);
    expect(granted({ wall: 0, monotonic: 0 }, 30 * MINUTE, later)).toBe(later);
  });

  it('keeps an op pending past 16 KiB of unapplied pending keys, then saves it once room frees', async () => {
    const { storage, client, log, holdApplyReplies } = allowanceWorld();
    await client.open();
    const release = holdApplyReplies();
    const name = 'n'.repeat(Math.floor(ALLOWANCE_BYTES / 3));
    const runs: Array<Promise<EditOutcome>> = [];
    for (const id of ['A1', 'A2', 'A3']) runs.push(client.run(create(id, name)));
    await until(() => expect(client.status()).toBe('delayed'));

    expect(log.filter((call) => call === 'set')).toHaveLength(2);
    expect(pendingKeys(storage).length).toBeLessThanOrEqual(2);
    release();

    const outcomes = await Promise.all(runs);
    expect(outcomes.map((outcome) => outcome.kind)).toEqual(['saved', 'saved', 'saved']);
    await until(() => expect(client.status()).toBe('ready'));
  });
});
