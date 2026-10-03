import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createFaultyStorage } from '@/features/folder/owner/__tests__/faultyStorage';
import { folder, folderData } from '@/features/folder/owner/__tests__/ownerHarness';
import { type FolderAuthority, FOLDER_WRITE_AUTHORITY } from '@/features/folder/owner/authority';
import { AUTHORITY_FENCE_KEY } from '@/features/folder/owner/authorityFence';
import { BUNDLE_INTENT_KEY } from '@/features/folder/owner/bundleIntent';
import { hashValue } from '@/features/folder/owner/canonicalHash';
import { createFolderOwnerCore } from '@/features/folder/owner/folderOwnerCore';
import type { FolderSite } from '@/features/folder/owner/folderOwnerPolicy';
import { backgroundWriteQueue } from '@/features/storage/writeQueue';

import { handleFolderOwnerMessage, startFolderOwner } from '../folderOwner';

const GEMINI_TAB = {
  id: 'test-extension-id',
  url: 'https://gemini.google.com/app/abc',
  frameId: 0,
  tab: { url: 'https://gemini.google.com/app/abc' },
};
const OPEN = { type: 'gv.folderOwner.open', key: 'gvFolderData', clientId: 'c1', ackedThrough: 0 };
const GEMINI_OWNER: Record<FolderSite, FolderAuthority> = {
  gemini: 'owner',
  aistudio: 'legacy',
  chatgpt: 'legacy',
};

function handlerWorld(authority?: Record<FolderSite, FolderAuthority>) {
  const storage = createFaultyStorage();
  const core = createFolderOwnerCore({
    area: storage.area,
    authority: authority ?? FOLDER_WRITE_AUTHORITY,
  });
  return {
    storage,
    send: (message: unknown, sender: object = GEMINI_TAB) =>
      handleFolderOwnerMessage(message, sender, { core, authority }),
  };
}

// T15 on the real handler: the gate decides before the core or storage is reached.
describe('folder owner message handler', () => {
  it('refuses every request with not_owner and touches no storage while sites are legacy', async () => {
    const { storage, send } = handlerWorld();

    await expect(send(OPEN)).resolves.toEqual({ kind: 'refused', reason: 'not_owner' });
    expect(storage.calls()).toBe(0);
  });

  it('reaches the core for an owner site and still refuses another site’s key', async () => {
    const { storage, send } = handlerWorld(GEMINI_OWNER);

    await expect(send(OPEN)).resolves.toMatchObject({ kind: 'empty', applied: 0 });
    const before = storage.calls();
    await expect(send({ ...OPEN, key: 'gvFolderDataChatGPT' })).resolves.toEqual({
      kind: 'refused',
      reason: 'sender_not_allowed',
    });
    expect(storage.calls()).toBe(before);
  });

  it('answers a malformed request of ours with bad_request and ignores other messages', async () => {
    const { storage, send } = handlerWorld(GEMINI_OWNER);

    await expect(send({ ...OPEN, ackedThrough: -1 })).resolves.toEqual({ kind: 'bad_request' });
    expect(send({ type: 'gv.promptLibrary.apply' })).toBeNull();
    expect(storage.calls()).toBe(0);
  });
});

describe('startFolderOwner', () => {
  beforeEach(() => {
    vi.stubGlobal('chrome', {
      ...chrome,
      runtime: { ...chrome.runtime, getManifest: () => ({ version: '1.9.0' }) },
    });
    vi.mocked(chrome.storage.local.get).mockClear();
    vi.mocked(chrome.storage.local.set).mockReset().mockResolvedValue(undefined);
    vi.mocked(chrome.runtime.onMessage.addListener).mockClear();
    vi.mocked(chrome.storage.onChanged.addListener).mockClear();
    vi.mocked(chrome.alarms.onAlarm.addListener).mockClear();
    vi.mocked(chrome.alarms.create).mockReset().mockResolvedValue(undefined);
    vi.mocked(chrome.alarms.clear).mockReset().mockResolvedValue(undefined);
  });
  afterEach(() => {
    backgroundWriteQueue.setPrelude(null);
    vi.unstubAllGlobals();
  });

  it('leaves prompt-owner turns reading nothing extra while every site is legacy', async () => {
    startFolderOwner();

    await backgroundWriteQueue(async () => 'prompt turn');

    expect(chrome.storage.local.get).not.toHaveBeenCalled();
    expect(chrome.storage.onChanged.addListener).not.toHaveBeenCalled();
  });

  it('resolves the bundle before a prompt-owner turn once a site is owned', async () => {
    vi.mocked(chrome.storage.local.get).mockResolvedValue({} as never);
    startFolderOwner(GEMINI_OWNER);
    await Promise.resolve();
    vi.mocked(chrome.storage.local.get).mockClear();

    await backgroundWriteQueue(async () => 'prompt turn');

    expect(chrome.storage.local.get).toHaveBeenCalledWith([BUNDLE_INTENT_KEY]);
  });

  it('T24b: startup writes only the running build’s legacy fence after an owner rollback', async () => {
    const storage = createFaultyStorage({
      gvFolderData: { legacy: 'edit' },
      'gvFolderOwner:meta:gvFolderData': { frozen: true },
      'gvFolderOwner:index': ['gvFolderData'],
      'gvFolderOwner:pending:c1:1': { accepted: true },
      [BUNDLE_INTENT_KEY]: { v: 1, txId: 'tx', status: 'open', site: 'chatgpt' },
      [AUTHORITY_FENCE_KEY]: { build: 'newer', sites: GEMINI_OWNER },
    });
    const before = storage.snapshot();
    vi.mocked(chrome.storage.local.set).mockImplementation((items) => storage.area.set(items));
    startFolderOwner();
    await backgroundWriteQueue(async () => 'prompt turn');

    expect(chrome.runtime.onMessage.addListener).toHaveBeenCalledTimes(1);
    expect(chrome.storage.local.get).not.toHaveBeenCalled();
    expect(chrome.storage.onChanged.addListener).not.toHaveBeenCalled();
    expect(chrome.alarms.onAlarm.addListener).not.toHaveBeenCalled();
    expect(chrome.alarms.create).not.toHaveBeenCalled();
    expect(chrome.alarms.clear).not.toHaveBeenCalled();
    expect(chrome.storage.local.set).toHaveBeenCalledExactlyOnceWith({
      [AUTHORITY_FENCE_KEY]: { build: '1.9.0', sites: FOLDER_WRITE_AUTHORITY },
    });
    expect(storage.snapshot()).toEqual({
      ...before,
      [AUTHORITY_FENCE_KEY]: { build: '1.9.0', sites: FOLDER_WRITE_AUTHORITY },
    });
  });

  it.each(['the retry alarm', 'a storage event'] as const)(
    'R3.6: finishes a blocked bundle when %s wakes the worker',
    async (signal) => {
      const storage = createFaultyStorage({
        gvFolderData: 'prev',
        cache: 'cache',
        [BUNDLE_INTENT_KEY]: {
          v: 1,
          txId: 'tx',
          status: 'open',
          site: 'gemini',
          clientId: 'c',
          seq: 1,
          at: 0,
          keys: {
            gvFolderData: { prevHash: await hashValue('prev'), nextHash: await hashValue('next') },
          },
          values: { gvFolderData: 'next' },
        },
      });
      storage.failWhen((op, keys) => op === 'set' && keys.includes('gvFolderData'));
      vi.mocked(chrome.storage.local.get).mockImplementation(async (keys: unknown) =>
        keys === null
          ? storage.area.getAll()
          : storage.area.get(Array.isArray(keys) ? keys : [String(keys)]),
      );
      vi.mocked(chrome.storage.local.set).mockImplementation((items) => storage.area.set(items));
      startFolderOwner(GEMINI_OWNER);
      await vi.waitFor(() =>
        expect(chrome.alarms.create).toHaveBeenCalledWith('gv-folder-owner-bundle-retry', {
          delayInMinutes: 1,
        }),
      );
      expect(storage.read(BUNDLE_INTENT_KEY)).toMatchObject({ status: 'open' });
      const onAlarm = vi.mocked(chrome.alarms.onAlarm.addListener).mock.calls[0][0];
      storage.failWhen(null);

      if (signal === 'the retry alarm') {
        onAlarm({ name: 'gv-folder-owner-bundle-retry', scheduledTime: Date.now() });
      } else {
        await storage.area.remove(['cache']);
        const onChanged = vi.mocked(chrome.storage.onChanged.addListener).mock.calls[0][0];
        onChanged({ cache: { oldValue: 'cache' } }, 'local');
      }
      await vi.waitFor(() =>
        expect(storage.read(BUNDLE_INTENT_KEY)).toMatchObject({ status: 'closed' }),
      );

      expect(storage.read('gvFolderData')).toBe('next');
      expect(chrome.alarms.create).toHaveBeenCalledTimes(1);
      if (signal === 'a storage event') {
        await vi.waitFor(() =>
          expect(chrome.alarms.clear).toHaveBeenCalledExactlyOnceWith(
            'gv-folder-owner-bundle-retry',
          ),
        );
        onAlarm({ name: 'gv-folder-owner-bundle-retry', scheduledTime: Date.now() });
        expect(chrome.alarms.create).toHaveBeenCalledTimes(1);
      }
    },
  );

  it('retries a failed startup fence after cleanup instead of permanently blocking owner turns', async () => {
    const data = folderData([folder('F', 'Keep')]);
    const storage = createFaultyStorage({ gvFolderData: data, cache: 'cache' });
    storage.failWhen((op, keys) => op === 'set' && keys.includes(AUTHORITY_FENCE_KEY));
    vi.mocked(chrome.storage.local.get).mockImplementation(async (keys: unknown) =>
      keys === null
        ? storage.area.getAll()
        : storage.area.get(Array.isArray(keys) ? keys : [String(keys)]),
    );
    vi.mocked(chrome.storage.local.set).mockImplementation((items) => storage.area.set(items));
    const owner = startFolderOwner(GEMINI_OWNER);
    await vi.waitFor(() =>
      expect(chrome.alarms.create).toHaveBeenCalledWith('gv-folder-owner-bundle-retry', {
        delayInMinutes: 1,
      }),
    );
    expect(chrome.storage.local.get).not.toHaveBeenCalled();
    expect(storage.read('gvFolderData')).toEqual(data);
    expect(storage.read(AUTHORITY_FENCE_KEY)).toBeUndefined();

    storage.failWhen(null);
    await storage.area.remove(['cache']);
    const onChanged = vi.mocked(chrome.storage.onChanged.addListener).mock.calls[0][0];
    onChanged({ cache: { oldValue: 'cache' } }, 'local');
    await expect(owner.snapshot({ key: 'gvFolderData', clientId: 'c' })).resolves.toMatchObject({
      kind: 'ready',
      data,
    });

    expect(storage.read(AUTHORITY_FENCE_KEY)).toEqual({ build: '1.9.0', sites: GEMINI_OWNER });
    expect(storage.read('gvFolderData')).toEqual(data);
    expect(
      vi
        .mocked(chrome.storage.local.set)
        .mock.calls.filter(([items]) => AUTHORITY_FENCE_KEY in items),
    ).toHaveLength(2);
    await vi.waitFor(() =>
      expect(chrome.alarms.clear).toHaveBeenCalledExactlyOnceWith('gv-folder-owner-bundle-retry'),
    );
  });
});
