import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { SyncPlatform } from '@/core/types/sync';

function installChrome(): void {
  const area = () => ({
    get: vi.fn().mockResolvedValue({}),
    set: vi.fn().mockResolvedValue(undefined),
    remove: vi.fn().mockResolvedValue(undefined),
  });
  vi.stubGlobal('chrome', {
    storage: {
      local: area(),
      sync: area(),
      onChanged: { addListener: vi.fn(), removeListener: vi.fn() },
    },
    runtime: { lastError: null, id: 'test-extension-id', getManifest: vi.fn(() => ({})) },
  });
}

async function createService() {
  vi.resetModules();
  const { GoogleDriveSyncService } = await import('../GoogleDriveSyncService');
  const service = new GoogleDriveSyncService();
  await service.getState();
  const internals = service as unknown as {
    getAuthToken: (interactive: boolean) => Promise<string | null>;
    ensureFileId: (token: string, name: string, type: string) => Promise<string>;
    uploadFileWithRetry: (token: string, id: string, data: unknown) => Promise<void>;
    migrateBackupFolderIfPresent: (token: string) => Promise<void>;
    findFile: (token: string, name: string) => Promise<string | null>;
    findFileForScope: (token: string, name: string, scope: unknown) => Promise<string | null>;
    downloadFileWithRetry: (token: string, id: string) => Promise<unknown>;
  };
  vi.spyOn(internals, 'getAuthToken').mockResolvedValue('token');
  return { service, internals };
}

const EMPTY_FOLDERS = { folders: [], folderContents: {} };

describe('GoogleDriveSyncService folder platform files', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    installChrome();
  });

  it.each([
    ['gemini', 'gemini-voyager-folders.json', 'folders', 'lastUploadTime'],
    [
      'aistudio',
      'gemini-voyager-aistudio-folders.json',
      'aistudio-folders',
      'lastUploadTimeAIStudio',
    ],
  ] as const)(
    'uploads %s folders to its own Drive file and timestamp',
    async (platform: SyncPlatform, fileName, fileType, timeField) => {
      const { service, internals } = await createService();
      vi.spyOn(internals, 'ensureFileId').mockImplementation(async (_token, name) => name);
      vi.spyOn(internals, 'uploadFileWithRetry').mockResolvedValue(undefined);

      await expect(service.upload(EMPTY_FOLDERS, [], null, true, platform)).resolves.toBe(true);

      expect(internals.ensureFileId).toHaveBeenCalledExactlyOnceWith('token', fileName, fileType);
      const state = await service.getState();
      expect(state[timeField]).toEqual(expect.any(Number));
      const otherFields = ['lastUploadTime', 'lastUploadTimeAIStudio'].filter(
        (field) => field !== timeField,
      ) as Array<'lastUploadTime' | 'lastUploadTimeAIStudio'>;
      for (const field of otherFields) expect(state[field]).toBeNull();
      expect(state.lastSyncTime).toBeNull();
      expect(state.lastSyncTimeAIStudio).toBeNull();
    },
  );

  it.each([
    ['gemini', 'gemini-voyager-folders.json', 'lastSyncTime', 'lastSyncTimeAIStudio'],
    ['aistudio', 'gemini-voyager-aistudio-folders.json', 'lastSyncTimeAIStudio', 'lastSyncTime'],
  ] as const)(
    'downloads %s folders from its own Drive file and timestamp',
    async (platform: SyncPlatform, fileName, timeField, otherTimeField) => {
      const { service, internals } = await createService();
      vi.spyOn(internals, 'migrateBackupFolderIfPresent').mockResolvedValue(undefined);
      vi.spyOn(internals, 'findFile').mockResolvedValue(null);
      vi.spyOn(internals, 'findFileForScope').mockImplementation(async (_token, name) =>
        name === fileName ? 'folders-file' : null,
      );
      const payload = { format: 'gemini-voyager.folders.v1', data: EMPTY_FOLDERS };
      vi.spyOn(internals, 'downloadFileWithRetry').mockResolvedValue(payload);

      const result = await service.download(true, platform);

      expect(result?.folders).toEqual(payload);
      const requestedFolderFiles = vi
        .mocked(internals.findFileForScope)
        .mock.calls.map(([, name]) => name)
        .filter((name) => name.includes('folders'));
      expect(requestedFolderFiles).toEqual([fileName]);
      const state = await service.getState();
      expect(state[timeField]).toEqual(expect.any(Number));
      expect(state[otherTimeField]).toBeNull();
    },
  );
});
