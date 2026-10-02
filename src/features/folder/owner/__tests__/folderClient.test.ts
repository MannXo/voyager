import { describe, expect, it } from 'vitest';

import type { EditOutcome } from '@/features/folder/commands/folderCommands';

import { FolderClient } from '../client/folderClient';
import type { FolderOwnerCore } from '../folderOwnerCore';
import type { FolderOwnerRequest, FolderOwnerResponse } from '../folderOwnerMessages';
import { FOLDER_SITE_POLICIES } from '../folderOwnerPolicy';
import { dispatchFolderOwnerRequest } from '../folderOwnerRequests';
import { createFaultyStorage } from './faultyStorage';
import {
  KEY,
  TestClient,
  createWorld,
  folder,
  folderData,
  pendingKeys,
  rename,
  storedData,
  storedMeta,
} from './ownerHarness';

/** Lets queued microtasks, change events and replies run. */
const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

function clientWorld() {
  const storage = createFaultyStorage({ [KEY]: folderData([folder('F', 'A')]) });
  const world = createWorld(storage);
  const owner: FolderOwnerCore = world.process();
  const timers = new Set<{ ms: number; run: () => void }>();
  const sent: string[] = [];
  /** A held request waits for its gate before the owner sees it, or after (its reply is late). */
  let hold: { type: string; until: Promise<void>; when: 'request' | 'reply' } | null = null;
  const wait = async (type: string, when: 'request' | 'reply') => {
    if (hold?.type === type && hold.when === when) await hold.until;
  };
  let ids = 0;
  const client = new FolderClient({
    key: KEY,
    policy: FOLDER_SITE_POLICIES.gemini,
    area: storage.area,
    send: async (request: FolderOwnerRequest): Promise<FolderOwnerResponse> => {
      sent.push(request.type);
      await wait(request.type, 'request');
      const reply = await dispatchFolderOwnerRequest(request, owner);
      await wait(request.type, 'reply');
      return reply;
    },
    subscribe: storage.subscribe,
    now: world.now,
    newId: () => `client-${++ids}`,
    setTimer: (run, ms) => {
      const timer = { ms, run };
      timers.add(timer);
      return () => void timers.delete(timer);
    },
  });
  return {
    storage,
    world,
    owner,
    client,
    sent,
    hold(type: FolderOwnerRequest['type'], when: 'request' | 'reply') {
      let open!: () => void;
      hold = { type, when, until: new Promise<void>((resolve) => (open = resolve)) };
      return () => open();
    },
    /** Runs every timer scheduled so far; returns their delays. */
    fireTimers(): number[] {
      const due = [...timers];
      timers.clear();
      due.forEach((timer) => timer.run());
      return due.map((timer) => timer.ms);
    },
  };
}

const names = (data: { folders: Array<{ id: string; name: string }> }) =>
  Object.fromEntries(data.folders.map((f) => [f.id, f.name]));

describe('FolderClient', () => {
  it('ends with the view equal to stored data and every op saved once', async () => {
    const { storage, client } = clientWorld();
    await client.open();

    const outcomes = await Promise.all([
      client.run({ kind: 'createFolder', folderId: 'X', name: 'New', parentId: null }),
      client.run({ kind: 'renameFolder', folderId: 'F', name: 'B' }),
      client.run({ kind: 'setFolderPinned', folderId: 'X', pinned: true }),
    ]);
    await tick();

    expect(outcomes.map((o) => o.kind)).toEqual(['saved', 'saved', 'saved']);
    expect(client.view()).toEqual(storedData(storage));
    expect(names(storedData(storage))).toEqual({ F: 'B', X: 'New' });
    expect(pendingKeys(storage)).toEqual([]);
  });

  it('T3d: keeps an op pending and visible while its pending key cannot be written', async () => {
    const { storage, client, fireTimers } = clientWorld();
    await client.open();
    let failures = 0;
    storage.failWhen(
      (op, keys) => op === 'set' && keys[0].startsWith('gvFolderOwner:pending:') && failures++ < 3,
    );
    let outcome: EditOutcome | null = null;
    void client.run(rename('F', 'B') as never).then((o) => (outcome = o));

    for (let attempt = 0; attempt < 3; attempt += 1) {
      await tick();
      expect(client.status()).toBe('delayed');
      expect(names(client.view()).F).toBe('B');
      expect(names(storedData(storage)).F).toBe('A');
      expect(outcome).toBeNull();
      fireTimers();
    }
    await client.flush();
    await tick();

    expect(outcome).toEqual({ kind: 'saved' });
    expect(client.status()).toBe('ready');
    expect(names(storedData(storage)).F).toBe('B');
  });

  it('T4f: never replays an op the base already includes, even before its reply', async () => {
    const { storage, world, owner, client, hold } = clientWorld();
    await client.open();
    const releaseReply = hold('gv.folderOwner.apply', 'reply');

    const created = client.run({ kind: 'createFolder', folderId: 'X', name: 'X', parentId: null });
    await tick();
    await tick();
    // Another tab deletes X after A's commit, before A hears its reply.
    const other = new TestClient(world, 'B');
    await other.open(owner);
    other.accept({ kind: 'removeFolder', folderId: 'X' });
    await other.flush(owner);
    await tick();

    expect(names(client.view())).toEqual({ F: 'A' });
    releaseReply();
    await expect(created).resolves.toEqual({ kind: 'saved' });
    expect(client.view()).toEqual(storedData(storage));
  });

  it('T4b: a reply whose echo is late keeps the op in view and asks for a snapshot at 2 s', async () => {
    const { storage, client, sent, fireTimers } = clientWorld();
    await client.open();
    storage.holdEvents();

    await expect(client.run(rename('F', 'B') as never)).resolves.toEqual({ kind: 'saved' });
    expect(names(client.view()).F).toBe('B');
    expect(fireTimers()).toEqual([2000]);
    await tick();

    expect(sent).toContain('gv.folderOwner.snapshot');
    expect(names(client.view()).F).toBe('B');
    storage.releaseEvents();
    await tick();
    expect(client.view()).toEqual(storedData(storage));
  });

  it('T4c: a K-only write is reconciled through a snapshot without dropping a queued op', async () => {
    const { storage, client, hold, sent } = clientWorld();
    await client.open();
    const releaseRequest = hold('gv.folderOwner.apply', 'request');
    const renamed = client.run(rename('F', 'B') as never);
    await tick();

    // A foreign writer replaces K while the rename is on its way to the owner.
    await storage.area.set({ [KEY]: folderData([folder('F', 'A'), folder('Y', 'Foreign')]) });
    await tick();
    await tick();
    expect(sent).toContain('gv.folderOwner.snapshot');
    expect(names(client.view())).toEqual({ F: 'B', Y: 'Foreign' });
    releaseRequest();

    await expect(renamed).resolves.toEqual({ kind: 'saved' });
    await tick();
    expect(names(client.view())).toEqual({ F: 'B', Y: 'Foreign' });
    expect(client.view()).toEqual(storedData(storage));
  });

  it('delivers the rejection of an op another turn drained before the client sent it', async () => {
    const { storage, world, client, hold } = clientWorld();
    await client.open();
    const releaseRequest = hold('gv.folderOwner.apply', 'request');
    let outcome: EditOutcome | null = null;
    // seq 1 is in flight; seq 2 is accepted behind it and not yet sent.
    const first = client.run(rename('F', 'B') as never);
    await tick();
    void client.run(rename('Gone', 'B') as never).then((o) => (outcome = o));
    await tick();

    // A restarted owner drains both accepted ops before A's apply arrives; A sees the echo first.
    await new TestClient(world, 'B').open(world.process());
    await tick();
    expect(storedMeta(storage).clients['client-1'].applied).toBe(2);
    expect(outcome).toBeNull();
    releaseRequest();
    await expect(first).resolves.toEqual({ kind: 'saved' });
    await tick();

    expect(outcome).toMatchObject({ kind: 'rejected', reason: 'folder_missing' });
    expect(client.view()).toEqual(storedData(storage));
  });

  it('stops with reload_required when the owner says this build does not own the site', async () => {
    const notOwner = new FolderClient({
      key: KEY,
      policy: FOLDER_SITE_POLICIES.gemini,
      area: createFaultyStorage().area,
      send: async () => ({ kind: 'refused', reason: 'not_owner' }),
      subscribe: () => () => undefined,
    });
    await notOwner.open();

    expect(notOwner.status()).toBe('reload_required');
    await expect(notOwner.run(rename('F', 'B') as never)).resolves.toMatchObject({
      kind: 'failed',
      reason: 'reload_required',
    });
  });
});
