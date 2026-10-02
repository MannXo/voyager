import { describe, expect, it } from 'vitest';

import { ownerBackupKey, ownerMetaKey } from '../folderOwnerState';
import { createFaultyStorage } from './faultyStorage';
import {
  KEY,
  TestClient,
  createWorld,
  folder,
  folderData,
  rename,
  storedData,
} from './ownerHarness';

const START = folderData([folder('F', 'A')]);
const FOREIGN = folderData([folder('F', 'A'), folder('X', 'Foreign')]);

/** The background's `storage.onChanged` wiring: every change of K reaches the detector. */
async function detectorWorld() {
  const storage = createFaultyStorage({ [KEY]: START });
  const world = createWorld(storage);
  const owner = world.process();
  const observed: Array<Promise<void>> = [];
  storage.subscribe((changes) => {
    if (KEY in changes) observed.push(owner.observe(KEY, changes[KEY].newValue));
  });
  const tab = new TestClient(world, 'A');
  await tab.open(owner);
  const settled = async () => {
    while (observed.length) await observed.shift();
  };
  return { storage, world, owner, tab, settled };
}

const foreignCopy = (storage: ReturnType<typeof createFaultyStorage>) =>
  (storage.read(ownerBackupKey(KEY, 'foreign')) as { value: unknown } | undefined)?.value;

describe('foreign-write detector (§6.4)', () => {
  it('T1c: keeps a raw write that lands inside a turn, which the commit then overwrites', async () => {
    const { storage, owner, tab, settled } = await detectorWorld();
    storage.onCall((_call, op, keys) => {
      if (op !== 'set' || !keys.includes(KEY) || !keys.includes(ownerMetaKey(KEY))) return;
      storage.onCall(null);
      storage.write(KEY, FOREIGN);
      void owner.observe(KEY, FOREIGN); // its change event, delivered while the turn runs
    });

    await tab.send(owner, tab.accept(rename('F', 'B')));
    await settled();
    await owner.drain(KEY);

    expect(storedData(storage).folders.map((f) => f.name)).toEqual(['B']);
    expect(foreignCopy(storage)).toEqual(FOREIGN);
    const restore = new TestClient(createWorld(storage), 'restore');
    await restore.open(owner);
    restore.bodies.set(1, { kind: 'restoreBackup', slot: 'foreign' });
    await restore.send(owner, [1]);
    expect(storedData(storage)).toEqual(FOREIGN);
  });

  it('copies nothing for the owner’s own commits', async () => {
    const { storage, owner, tab, settled } = await detectorWorld();

    await tab.send(owner, tab.accept(rename('F', 'B'), rename('F', 'C')));
    await settled();

    expect(storedData(storage).folders[0].name).toBe('C');
    expect(foreignCopy(storage)).toBeUndefined();
  });

  it('T1b: a raw set between turns is copied, adopted, and kept under the next edit', async () => {
    const { storage, owner, tab, settled } = await detectorWorld();

    await storage.area.set({ [KEY]: FOREIGN });
    await settled();
    await tab.send(owner, tab.accept(rename('F', 'B')));

    expect(foreignCopy(storage)).toEqual(FOREIGN);
    expect(storedData(storage).folders.map((f) => f.name)).toEqual(['B', 'Foreign']);
  });
});
