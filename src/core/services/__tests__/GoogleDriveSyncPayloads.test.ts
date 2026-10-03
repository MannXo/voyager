import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { SyncAccountScope } from '@/core/types/sync';
import { hashString } from '@/core/utils/hash';
import { EXTENSION_VERSION } from '@/core/utils/version';

import {
  GoogleDriveSyncPayloads,
  type GoogleDriveUploadSnapshot,
} from '../GoogleDriveSyncPayloads';

const scope: SyncAccountScope = { accountKey: 'gemini:person', accountId: 1, routeUserId: '1' };
const hierarchyScope: SyncAccountScope = {
  accountKey: 'gemini:hierarchy-person',
  accountId: 2,
  routeUserId: '2',
};
const exportedAt = '2026-10-03T12:00:00.000Z';

function scoped(name: string, account = scope): string {
  return `${name}.acct-${hashString(account.accountKey)}.json`;
}

function snapshot(overrides: Partial<GoogleDriveUploadSnapshot> = {}): GoogleDriveUploadSnapshot {
  return {
    folders: { folders: [], folderContents: {} },
    prompts: [],
    starred: null,
    platform: 'gemini',
    forks: null,
    timelineHierarchy: null,
    accountScope: scope,
    timelineHierarchyAccountScope: null,
    settings: null,
    plugins: null,
    ...overrides,
  };
}

function fixture() {
  const writes: Array<{ name: string; payload: unknown }> = [];
  const remote = new Map<string, unknown>();
  const files = {
    ensure: vi.fn(async (_token: string, name: string) => name),
    find: vi.fn(async (_token: string, _name: string): Promise<string | null> => null),
    upload: vi.fn(async (_token: string, name: string, payload: unknown) => {
      writes.push({ name, payload });
    }),
    download: async <T>(_token: string, name: string): Promise<T | null> =>
      (remote.get(name) as T) ?? null,
    prepareDownload: vi.fn(async (_token: string) => {}),
  };
  return { payloads: new GoogleDriveSyncPayloads(files), files, writes, remote };
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date(exportedAt));
});

afterEach(() => {
  vi.useRealTimers();
});

describe('GoogleDriveSyncPayloads', () => {
  it('uploads scoped Gemini files in order, with a separate hierarchy scope and shortened star copies', async () => {
    const { payloads, writes } = fixture();
    const long = {
      turnId: 'turn-long',
      content: 'x'.repeat(61),
      conversationId: 'conversation',
      conversationUrl: 'https://gemini.google.com/u/1/app/conversation',
      conversationTitle: 'Saved title',
      starredAt: 123,
    };
    const short = { ...long, turnId: 'turn-short', content: 'x'.repeat(60) };
    const starred = { messages: { conversation: [long, short] } };
    const prompts = [{ id: 'prompt', text: 'Hello', tags: [], createdAt: 1, pinnedAt: null }];
    const data = snapshot({
      prompts,
      starred,
      forks: { nodes: {}, groups: {} },
      timelineHierarchy: { conversations: {} },
      timelineHierarchyAccountScope: hierarchyScope,
      settings: {},
      plugins: {},
    });

    await expect(payloads.upload('token', data)).resolves.toBe(7);

    expect(writes.map(({ name }) => name)).toEqual([
      scoped('gemini-voyager-folders'),
      scoped('gemini-voyager-prompts'),
      'gemini-voyager-settings.json',
      'gemini-voyager-plugins.json',
      scoped('gemini-voyager-starred'),
      scoped('gemini-voyager-forks'),
      scoped('gemini-voyager-timeline-hierarchy', hierarchyScope),
    ]);
    for (const { payload } of writes) {
      expect(payload).toEqual(expect.objectContaining({ exportedAt, version: EXTENSION_VERSION }));
    }
    expect(writes[1].payload).toEqual({
      format: 'gemini-voyager.prompts.v1',
      exportedAt,
      version: EXTENSION_VERSION,
      items: prompts,
    });
    expect(writes[4].payload).toEqual({
      format: 'gemini-voyager.starred.v1',
      exportedAt,
      version: EXTENSION_VERSION,
      data: { messages: { conversation: [{ ...long, content: 'x'.repeat(60) + '...' }, short] } },
    });
    expect(starred.messages.conversation[0].content).toBe('x'.repeat(61));
    expect(writes[6].payload).toEqual(expect.objectContaining({ data: data.timelineHierarchy }));
  });

  it('omits empty aggregate prompts and Gemini-only files on AI Studio, but writes a prompts-only clear', async () => {
    const { payloads, writes } = fixture();
    await expect(
      payloads.upload(
        'token',
        snapshot({
          platform: 'aistudio',
          starred: { messages: {} },
          forks: { nodes: {}, groups: {} },
          timelineHierarchy: { conversations: {} },
          settings: {},
          plugins: {},
        }),
      ),
    ).resolves.toBe(3);
    expect(writes.map(({ name }) => name)).toEqual([
      scoped('gemini-voyager-aistudio-folders'),
      'gemini-voyager-settings.json',
      'gemini-voyager-plugins.json',
    ]);

    await payloads.uploadPrompts('token', [], scope);

    expect(writes[3]).toEqual({
      name: scoped('gemini-voyager-prompts'),
      payload: {
        format: 'gemini-voyager.prompts.v1',
        exportedAt,
        version: EXTENSION_VERSION,
        items: [],
      },
    });
  });

  it('prefers scoped files, falls back only when missing, and keeps global and hierarchy scopes distinct', async () => {
    const { payloads, files, remote } = fixture();
    const folders = {
      format: 'gemini-voyager.folders.v1',
      data: { folders: [], folderContents: {} },
    };
    const prompts = { format: 'gemini-voyager.prompts.v1', items: [] };
    const hierarchy = {
      format: 'gemini-voyager.timeline-hierarchy.v1',
      data: { conversations: {} },
    };
    remote.set('gemini-voyager-folders.json', folders);
    remote.set(scoped('gemini-voyager-prompts'), prompts);
    remote.set('gemini-voyager-timeline-hierarchy.json', hierarchy);
    files.find.mockImplementation(async (_token, name) => (remote.has(name) ? name : null));

    await expect(payloads.download('token', 'gemini', scope, hierarchyScope)).resolves.toEqual({
      folders,
      prompts,
      settings: null,
      plugins: null,
      starred: null,
      forks: null,
      timelineHierarchy: hierarchy,
    });

    expect(files.prepareDownload).toHaveBeenCalledExactlyOnceWith('token');
    expect(files.find.mock.calls.map(([, name]) => name)).toEqual([
      scoped('gemini-voyager-folders'),
      'gemini-voyager-folders.json',
      scoped('gemini-voyager-prompts'),
      'gemini-voyager-settings.json',
      'gemini-voyager-plugins.json',
      scoped('gemini-voyager-starred'),
      'gemini-voyager-starred.json',
      scoped('gemini-voyager-forks'),
      'gemini-voyager-forks.json',
      scoped('gemini-voyager-timeline-hierarchy', hierarchyScope),
      'gemini-voyager-timeline-hierarchy.json',
    ]);
  });

  it('stops uploading after a failed file without attempting later payloads', async () => {
    const { payloads, files, writes } = fixture();
    files.upload.mockImplementation(async (_token, name, payload) => {
      if (name === 'gemini-voyager-settings.json') throw new Error('write failed');
      writes.push({ name, payload });
    });

    await expect(payloads.upload('token', snapshot({ settings: {}, plugins: {} }))).rejects.toThrow(
      'write failed',
    );

    expect(writes.map(({ name }) => name)).toEqual([scoped('gemini-voyager-folders')]);
    expect(files.ensure.mock.calls.map(([, name]) => name)).toEqual([
      scoped('gemini-voyager-folders'),
      'gemini-voyager-settings.json',
    ]);
  });
});
