import { describe, expect, it } from 'vitest';

import type { FolderData } from '@/core/types/folder';
import { FolderImportExportService } from '@/features/folder/services/FolderImportExportService';

import type { FolderOpBody } from '../folderOps';
import type { FolderOwnerCore } from '../folderOwnerCore';
import { ownerBackupKey } from '../folderOwnerState';
import { ROTATE_LAST_MS, ROTATE_PRIOR_MS } from '../ownerBackups';
import { type FaultyStorage, createFaultyStorage } from './faultyStorage';
import {
  KEY,
  TestClient,
  type World,
  conversation,
  createWorld,
  folder,
  folderData,
  rename,
  storedData,
  storedMeta,
} from './ownerHarness';

const MINUTE = 60_000;
const G = folderData([folder('F', 'Good'), folder('W', 'Work')], { W: [conversation('c1')] });

const slot = (storage: FaultyStorage, name: 'last' | 'prior' | 'preBulk') =>
  (storage.read(ownerBackupKey(KEY, name)) as { value: FolderData } | undefined)?.value;

async function world(data: FolderData = G) {
  const storage = createFaultyStorage({ [KEY]: data });
  const w = createWorld(storage);
  const tab = new TestClient(w, 'tab');
  await tab.open(w.process());
  return { storage, world: w, tab };
}

/** One edit through the tab, on a fresh owner process (a worker restart) by default. */
async function edit(w: World, tab: TestClient, body: FolderOpBody, owner = w.process()) {
  const [seq] = tab.accept(body);
  return tab.send(owner, [seq], tab.acked).then((reply) => {
    if (reply.kind === 'ok') tab.acked = seq;
    return reply;
  });
}

/** A bulk op through a one-shot client: open, seq 1, no pending key (§8.2). */
async function bulk(w: World, body: FolderOpBody, owner: FolderOwnerCore = w.process(), key = KEY) {
  const oneShot = new TestClient(w, `one-shot-${Math.random()}`, key);
  await oneShot.open(owner);
  oneShot.bodies.set(1, body);
  const reply = await oneShot.send(owner, [1]);
  return { reply, resend: () => oneShot.send(w.process(), [1]) };
}

describe('backup rotation (T7a)', () => {
  it('keeps the good state through restarts and rotates only on the meta deadlines', async () => {
    const { storage, world: w, tab } = await world();

    w.advance(MINUTE);
    await edit(w, tab, rename('F', 'one'));
    w.advance(MINUTE);
    await edit(w, tab, rename('F', 'two')); // a fresh worker
    w.advance(MINUTE);
    await edit(w, tab, rename('F', 'three')); // and another
    expect(slot(storage, 'last')).toEqual(G);

    w.advance(ROTATE_LAST_MS);
    await edit(w, tab, rename('F', 'four'));
    expect(slot(storage, 'prior')).toEqual(G);
    expect(slot(storage, 'last')?.folders[0].name).toBe('three');

    w.advance(ROTATE_LAST_MS);
    await edit(w, tab, rename('F', 'five'));
    expect(slot(storage, 'prior')).toEqual(G);
    expect(slot(storage, 'last')?.folders[0].name).toBe('four');

    w.advance(ROTATE_PRIOR_MS);
    await edit(w, tab, rename('F', 'six'));
    expect(slot(storage, 'prior')?.folders[0].name).toBe('four');
    expect(slot(storage, 'last')?.folders[0].name).toBe('five');
  });

  it('commits an edit whose last copy cannot be written (T7b)', async () => {
    const { storage, world: w, tab } = await world();
    storage.failWhen((op, keys) => op === 'set' && keys.includes(ownerBackupKey(KEY, 'last')));

    await expect(edit(w, tab, rename('F', 'B'))).resolves.toMatchObject({ kind: 'ok' });

    expect(storedData(storage).folders[0].name).toBe('B');
    expect(slot(storage, 'last')).toBeUndefined();
  });
});

describe('preBulk and bulk ops', () => {
  it('copies the state before an edit removes a folder that holds conversations', async () => {
    const { storage, world: w, tab } = await world();

    await edit(w, tab, { kind: 'removeFolder', folderId: 'W' });

    expect(slot(storage, 'preBulk')).toEqual(G);
    expect(storedData(storage).folders.map((f) => f.id)).toEqual(['F']);
  });

  it('refuses a removal whose preBulk cannot be written and still applies the rest of the batch', async () => {
    const { storage, world: w, tab } = await world();
    storage.failWhen((op, keys) => op === 'set' && keys.includes(ownerBackupKey(KEY, 'preBulk')));
    const seqs = tab.accept(rename('F', 'B'), { kind: 'removeFolder', folderId: 'W' });

    const reply = await tab.send(w.process(), seqs);

    expect(reply).toMatchObject({
      kind: 'ok',
      applied: 2,
      outcomes: { 1: { kind: 'saved' }, 2: { kind: 'rejected', reason: 'backup_failed' } },
    });
    expect(storedData(storage).folders.map((f) => `${f.id}:${f.name}`)).toEqual(['F:B', 'W:Work']);
    expect(storedData(storage).folderContents.W).toHaveLength(1);
  });

  it('refuses a drained removal of 20 references whose preBulk is not admitted', async () => {
    const many = Array.from({ length: 20 }, (_, n) => conversation(`c${n}`));
    const start = folderData([folder('F', 'Good')], { F: many });
    const storage = createFaultyStorage({ [KEY]: start });
    const w = createWorld(storage);
    const tab = new TestClient(w, 'tab');
    await tab.open(w.process());
    storage.failWhen((op, keys) => op === 'set' && keys.includes(ownerBackupKey(KEY, 'preBulk')));
    tab.accept({
      kind: 'removeConversations',
      folderId: 'F',
      ids: many.map((c) => c.conversationId),
    });

    await w.process().drain(KEY);

    expect(storedData(storage)).toEqual(start);
    expect(storedMeta(storage).clients.tab).toMatchObject({
      applied: 1,
      outcomes: { 1: { kind: 'rejected', reason: 'backup_failed' } },
    });
  });

  it('refuses an import whose preBulk cannot be written, and a resend gets the same answer (T7b)', async () => {
    const { storage, world: w } = await world();
    storage.failWhen((op, keys) => op === 'set' && keys.includes(ownerBackupKey(KEY, 'preBulk')));
    const file = FolderImportExportService.exportToPayload(folderData([folder('N', 'New')]));

    const { reply, resend } = await bulk(w, {
      kind: 'importFile',
      payload: file,
      strategy: 'merge',
      source: 'file',
    });
    storage.failWhen(null);

    const refused = { kind: 'rejected', reason: 'backup_failed' };
    expect(reply).toMatchObject({ kind: 'ok', outcomes: { 1: refused } });
    expect(storedData(storage)).toEqual(G);
    await expect(resend()).resolves.toMatchObject({ outcomes: { 1: refused } });
    expect(storedData(storage)).toEqual(G);
  });

  it('restores preBulk from the old copy and keeps the pre-restore data as the new one (T7f)', async () => {
    const { storage, world: w, tab } = await world();
    await edit(w, tab, { kind: 'removeFolder', folderId: 'W' });
    const afterRemove = storedData(storage);

    const { reply } = await bulk(w, { kind: 'restoreBackup', slot: 'preBulk' });

    expect(reply).toMatchObject({ outcomes: { 1: { kind: 'saved', restoredFrom: 'preBulk' } } });
    expect(storedData(storage)).toEqual(G);
    expect(slot(storage, 'preBulk')).toEqual(afterRemove);
  });

  it('applies a bulk op once: a resend after a lost reply replays its stats', async () => {
    const { storage, world: w } = await world();
    const file = FolderImportExportService.exportToPayload(
      folderData([folder('N', 'New')], { N: [conversation('c9')] }),
    );

    const { reply, resend } = await bulk(w, {
      kind: 'importFile',
      payload: file,
      strategy: 'merge',
      source: 'file',
    });
    const stats = { foldersImported: 1, conversationsImported: 1, backupCreated: true };

    expect(reply).toMatchObject({ outcomes: { 1: { kind: 'saved', stats } } });
    const imported = storedData(storage);
    await expect(resend()).resolves.toMatchObject({ outcomes: { 1: { kind: 'saved', stats } } });
    expect(storedData(storage)).toEqual(imported);
    expect(slot(storage, 'preBulk')).toEqual(G);
  });

  it('never applies a bulk body from a pending key or inside a batch', async () => {
    const { storage, world: w, tab } = await world();
    const restore: FolderOpBody = { kind: 'restoreBackup', slot: 'last' };

    tab.accept(restore);
    await w.process().drain(KEY);
    expect(storedMeta(storage).clients.tab.outcomes[1]).toMatchObject({ kind: 'rejected' });

    const [a, b] = tab.accept(rename('F', 'B'), restore);
    await expect(tab.send(w.process(), [a, b], 1)).resolves.toEqual({ kind: 'bad_batch' });
    expect(storedData(storage)).toEqual(G);
  });

  it('refuses a cloud merge, which needs the bundle contract, without touching data', async () => {
    const { storage, world: w } = await world();

    const { reply } = await bulk(w, { kind: 'cloudMerge', mode: 'overwrite', payload: {} });

    expect(reply).toMatchObject({ outcomes: { 1: { kind: 'rejected', reason: 'unsupported' } } });
    expect(storedData(storage)).toEqual(G);
    expect(slot(storage, 'preBulk')).toBeUndefined();
  });

  it('replaces the data with the file for a Gemini replace import', async () => {
    const { storage, world: w } = await world();
    const next = folderData([folder('N', 'New')], { N: [conversation('c9')] });
    const file = FolderImportExportService.exportToPayload(next);

    await bulk(w, { kind: 'importFile', payload: file, strategy: 'replace', source: 'file' });

    expect(storedData(storage)).toEqual(next);
    expect(slot(storage, 'preBulk')).toEqual(G);
  });

  it.each(['gvFolderDataAIStudio', 'gvFolderDataChatGPT'])(
    'refuses a replace import on %s, whose import only merges',
    async (key) => {
      const storage = createFaultyStorage({ [key]: G });
      const w = createWorld(storage);
      const file = FolderImportExportService.exportToPayload(folderData([folder('N', 'New')]));

      const { reply } = await bulk(
        w,
        { kind: 'importFile', payload: file, strategy: 'replace', source: 'file' },
        w.process(),
        key,
      );

      expect(reply).toMatchObject({ outcomes: { 1: { kind: 'rejected', reason: 'unsupported' } } });
      expect(storedData(storage, key)).toEqual(G);
    },
  );

  it('refuses another site’s file on AI Studio with the wrong-site notice', async () => {
    const aiStudio = 'gvFolderDataAIStudio';
    const storage = createFaultyStorage({ [aiStudio]: G });
    const w = createWorld(storage);
    const file = { ...FolderImportExportService.exportToPayload(G), platform: 'chatgpt' };

    const { reply } = await bulk(
      w,
      { kind: 'importFile', payload: file, strategy: 'merge', source: 'file' },
      w.process(),
      aiStudio,
    );

    expect(reply).toMatchObject({
      outcomes: { 1: { kind: 'rejected', messageKey: 'folder_import_wrong_site' } },
    });
    expect(storedData(storage, aiStudio)).toEqual(G);
  });
});
