import { beforeEach, describe, expect, it, vi } from 'vitest';

import { createFaultyStorage } from '@/features/folder/owner/__tests__/faultyStorage';
import { type FolderAuthority, FOLDER_WRITE_AUTHORITY } from '@/features/folder/owner/authority';
import { createFolderOwnerCore } from '@/features/folder/owner/folderOwnerCore';
import type { FolderSite } from '@/features/folder/owner/folderOwnerPolicy';

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
    vi.mocked(chrome.storage.local.get).mockClear();
    vi.mocked(chrome.storage.local.set).mockClear();
    vi.mocked(chrome.runtime.onMessage.addListener).mockClear();
  });

  it('listens for requests but reads no storage at startup while every site is legacy', async () => {
    startFolderOwner();
    await Promise.resolve();

    expect(chrome.runtime.onMessage.addListener).toHaveBeenCalledTimes(1);
    expect(chrome.storage.local.get).not.toHaveBeenCalled();
    expect(chrome.storage.local.set).not.toHaveBeenCalled();
  });
});
