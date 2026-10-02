import { describe, expect, it } from 'vitest';

import type { FolderAuthority } from '../authority';
import { createFolderOwnerCore } from '../folderOwnerCore';
import type { FolderSite } from '../folderOwnerPolicy';
import { ownerBackupKey, ownerMetaKey } from '../folderOwnerState';
import { createFaultyStorage } from './faultyStorage';
import {
  ALL_OWNER,
  TestClient,
  createWorld,
  folder,
  folderData,
  pendingKeys,
  rename,
  storedData,
} from './ownerHarness';

const AI_STUDIO = 'gvFolderDataAIStudio';
const AI_STUDIO_LEGACY: Record<FolderSite, FolderAuthority> = { ...ALL_OWNER, aistudio: 'legacy' };

/** AI Studio under an owner build (P4b): a registered client with 3 accepted, undrained ops. */
async function ownedThenRolledBack() {
  const storage = createFaultyStorage({ [AI_STUDIO]: folderData([folder('F', 'A')]) });
  const world = createWorld(storage);
  const tab = new TestClient(world, 'S', AI_STUDIO);
  await tab.open(world.process());
  tab.accept(rename('F', 'B'), rename('F', 'C'), rename('F', 'D'));
  const rolledBack = createFolderOwnerCore({
    area: storage.area,
    authority: AI_STUDIO_LEGACY,
    now: world.now,
  });
  return { storage, world, tab, rolledBack };
}

// T24a, the AI Studio half (addendum P3P4 R5.1, R5.3). Bundles wait for the reviewed contract.
describe('running-build authority (R5.1)', () => {
  it('leaves a legacy site’s K and sidecars untouched through every owner entry point', async () => {
    const { storage, tab, rolledBack } = await ownedThenRolledBack();
    const meta = storage.read(ownerMetaKey(AI_STUDIO));
    const calls = storage.calls();

    await expect(
      rolledBack.open({ key: AI_STUDIO, clientId: 'S', ackedThrough: 0 }),
    ).resolves.toEqual({ kind: 'refused', reason: 'not_owner' });
    await expect(tab.send(rolledBack, [1, 2, 3])).resolves.toEqual({
      kind: 'refused',
      reason: 'not_owner',
    });
    await expect(rolledBack.snapshot({ key: AI_STUDIO, clientId: 'S' })).resolves.toEqual({
      kind: 'refused',
      reason: 'not_owner',
    });
    await rolledBack.drain(AI_STUDIO);
    const held = { key: AI_STUDIO, clientId: 'S', heldClientId: 'S', decision: 'apply' as const };
    await expect(rolledBack.held(held)).resolves.toEqual({ kind: 'refused', reason: 'not_owner' });
    const journal = { key: AI_STUDIO, clientId: 'S', journalClientId: 'S', ops: [] };
    await expect(rolledBack.adoptJournal(journal)).resolves.toEqual({
      kind: 'refused',
      reason: 'not_owner',
    });

    expect(storage.calls()).toBe(calls);
    expect(storage.read(ownerMetaKey(AI_STUDIO))).toEqual(meta);
    expect(pendingKeys(storage)).toHaveLength(3);
  });

  it('holds the ops accepted before a legacy write once the site is owned again', async () => {
    const { storage, world, rolledBack } = await ownedThenRolledBack();
    // Legacy AI Studio tabs write K directly while the owner build leaves it alone.
    world.advance(60_000);
    storage.write(AI_STUDIO, folderData([folder('F', 'A'), folder('L', 'Legacy edit')]));
    await rolledBack.drain(AI_STUDIO);
    expect(storage.read(ownerBackupKey(AI_STUDIO, 'foreign'))).toBeUndefined();

    world.advance(60_000);
    await world.process().drain(AI_STUDIO);

    expect(storedData(storage, AI_STUDIO).folders.map((f) => f.name)).toEqual(['A', 'Legacy edit']);
    const meta = storage.read(ownerMetaKey(AI_STUDIO)) as {
      clients: Record<string, { applied: number; held?: { from: number; reason: string } }>;
    };
    expect(meta.clients.S).toMatchObject({
      applied: 0,
      held: { from: 1, reason: 'foreign_write' },
    });
    expect(pendingKeys(storage)).toHaveLength(3);
  });
});
