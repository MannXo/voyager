import type { SyncAccountScope, SyncProvider } from '@/core/types/sync';

import { GoogleDriveBackupFolder } from './GoogleDriveBackupFolder';
import { GoogleDriveFiles } from './GoogleDriveFiles';
import {
  BACKUP_FOLDER_RECOVERY_FILE_NAMES,
  GoogleDriveSyncPayloads,
} from './GoogleDriveSyncPayloads';
import type { StarTransferPort } from './StarDriveSyncCoordinator';

export function createStarTransferSession(
  token: string,
  provider: SyncProvider,
  identity: string,
  scope: SyncAccountScope | null,
  assertActive: () => void,
  onAuthLost: () => void,
): { payloads: GoogleDriveSyncPayloads; port: StarTransferPort } {
  const files = new GoogleDriveFiles(
    new GoogleDriveBackupFolder(BACKUP_FOLDER_RECOVERY_FILE_NAMES),
    {
      getProvider: () => {
        assertActive();
        return provider;
      },
      onAuthLost,
    },
  );
  const checked = async <T>(operation: () => Promise<T>): Promise<T> => {
    assertActive();
    const result = await operation();
    assertActive();
    return result;
  };
  const payloads = new GoogleDriveSyncPayloads({
    ensure: (t, name) => checked(() => files.ensure(t, name)),
    find: (t, name) => checked(() => files.find(t, name)),
    upload: (t, id, data) => checked(() => files.upload(t, id, data)),
    download: <T>(t: string, id: string) => checked(() => files.download<T>(t, id)),
    prepareDownload: (t) => checked(() => files.prepareDownload(t)),
  });
  return {
    payloads,
    port: {
      identity,
      assertActive,
      read: () => payloads.readStars(token, scope),
      writeV2: (payload) => payloads.writeStars(token, payload, scope, true),
      writeV1: (payload) => payloads.writeStars(token, payload, scope, false),
    },
  };
}
