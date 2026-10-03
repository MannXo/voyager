import type { FolderAuthority } from './authority';
import type { FolderSite } from './folderOwnerPolicy';
import type { FolderOwnerStorageArea } from './folderOwnerState';

export const AUTHORITY_FENCE_KEY = 'gvFolderOwner:authority';

/** Every build publishes its authority, including rollback builds with all sites legacy (§3.3). */
export async function writeAuthorityFence(
  area: Pick<FolderOwnerStorageArea, 'set'>,
  build: string,
  sites: Readonly<Record<FolderSite, FolderAuthority>>,
): Promise<void> {
  await area.set({ [AUTHORITY_FENCE_KEY]: { build, sites } });
}
