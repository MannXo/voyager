import { describe, expect, it } from 'vitest';

import type { EditOutcome } from '@/features/folder/commands/folderCommands';

import { FolderClient } from '../client/folderClient';
import { INTERRUPTED, type StoredOutcome } from '../folderOps';
import type { FolderOwnerRequest, FolderOwnerResponse } from '../folderOwnerMessages';
import { FOLDER_SITE_POLICIES } from '../folderOwnerPolicy';
import { ownerMetaKey } from '../folderOwnerState';
import { createFaultyStorage } from './faultyStorage';
import {
  KEY,
  TestClient,
  createWorld,
  folder,
  folderData,
  rename,
  storedMeta,
} from './ownerHarness';

const PENDING: StoredOutcome = { kind: 'bundle_pending', txId: 'tx-1' };

describe('bundle_pending is never terminal (addendum P3P4 R4.1)', () => {
  it('keeps a pending outcome through acks and answers a duplicate with it', async () => {
    const storage = createFaultyStorage({ [KEY]: folderData([folder('F', 'A')]) });
    const w = createWorld(storage);
    const tab = new TestClient(w, 'tab');
    await tab.open(w.process());
    const [first] = tab.accept(rename('F', 'B'));
    await tab.send(w.process(), [first]);
    // Seq 1 sits inside an open bundle.
    const meta = storedMeta(storage);
    meta.clients.tab.outcomes[first] = PENDING;
    storage.write(ownerMetaKey(KEY), meta);

    const [second] = tab.accept(rename('F', 'C'));
    const reply = await tab.send(w.process(), [first, second], second);

    expect(reply).toMatchObject({ kind: 'ok', outcomes: { [first]: PENDING } });
    expect(storedMeta(storage).clients.tab.outcomes[first]).toEqual(PENDING);
  });

  it('leaves the edit unsettled while pending and delivers the outcome it settles as', async () => {
    const answers: StoredOutcome[] = [PENDING, PENDING, INTERRUPTED];
    const timers: Array<() => void> = [];
    let applies = 0;
    const client = new FolderClient({
      key: KEY,
      policy: FOLDER_SITE_POLICIES.gemini,
      area: {
        get: async () => ({}),
        getAll: async () => ({}),
        set: async () => {},
        remove: async () => {},
      },
      subscribe: () => () => {},
      newId: () => 'client',
      setTimer: (run) => {
        timers.push(run);
        return () => {};
      },
      send: async (request: FolderOwnerRequest): Promise<FolderOwnerResponse> => {
        if (request.type === 'gv.folderOwner.open') {
          return { kind: 'empty', epoch: 'e', rev: 1, applied: 0, held: [], legacySync: false };
        }
        const outcome = answers[Math.min(applies++, answers.length - 1)];
        return { kind: 'ok', epoch: 'e', rev: 1, applied: 1, outcomes: { 1: outcome } };
      },
    });
    await client.open();
    let delivered: EditOutcome | null = null;
    void client.run(rename('F', 'B') as never).then((outcome) => (delivered = outcome));

    await expect.poll(() => applies).toBe(1);
    expect(delivered).toBeNull();
    // The client asks again only on its back-off timer, never in a tight loop.
    expect(timers).toHaveLength(1);
    timers.shift()!();
    await expect.poll(() => applies).toBe(2);
    expect(delivered).toBeNull();
    timers.shift()!();

    await expect.poll(() => delivered).toEqual(INTERRUPTED);
    expect(applies).toBe(3);
  });
});
