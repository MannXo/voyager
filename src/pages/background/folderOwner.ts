/**
 * Background owner of folder writes (DESIGN-v2 §6). Dormant: while every site
 * in `FOLDER_WRITE_AUTHORITY` is `legacy`, each request is refused with
 * `not_owner` before any storage access, and startup reads nothing.
 */
import { logger } from '@/core/services/LoggerService';
import { FOLDER_WRITE_AUTHORITY, type FolderAuthority } from '@/features/folder/owner/authority';
import {
  type FolderOwnerCore,
  createFolderOwnerCore,
} from '@/features/folder/owner/folderOwnerCore';
import type { FolderOwnerResponse } from '@/features/folder/owner/folderOwnerMessages';
import type { FolderSite } from '@/features/folder/owner/folderOwnerPolicy';
import {
  dispatchFolderOwnerRequest,
  isFolderOwnerMessage,
  parseFolderOwnerRequest,
} from '@/features/folder/owner/folderOwnerRequests';
import {
  type FolderOwnerSender,
  checkFolderOwnerSender,
} from '@/features/folder/owner/folderOwnerSenderGate';
import type { FolderOwnerStorageArea } from '@/features/folder/owner/folderOwnerState';
import { drainOwnedKeys } from '@/features/folder/owner/ownerStartup';
import { backgroundWriteQueue } from '@/features/storage/writeQueue';

type Authority = Readonly<Record<FolderSite, FolderAuthority>>;

export const localFolderArea: FolderOwnerStorageArea = {
  get: (keys) => chrome.storage.local.get(keys),
  set: (items) => chrome.storage.local.set(items),
  remove: (keys) => chrome.storage.local.remove(keys),
};

export interface FolderOwnerHandlerDeps {
  core: FolderOwnerCore;
  authority?: Authority;
}

/**
 * The reply to `message`, or `null` when the message is not the folder owner's.
 * The sender gate (§6.8) runs before the request reaches the core.
 */
export function handleFolderOwnerMessage(
  message: unknown,
  sender: FolderOwnerSender,
  deps: FolderOwnerHandlerDeps,
): Promise<FolderOwnerResponse> | null {
  if (!isFolderOwnerMessage(message)) return null;
  // The gate needs the key, so parsing comes first: a malformed message from any sender gets
  // `bad_request`, which reveals nothing and reaches no storage.
  const request = parseFolderOwnerRequest(message);
  if (!request) return Promise.resolve({ kind: 'bad_request' });
  const decision = checkFolderOwnerSender(sender, request.key, {
    extensionId: chrome.runtime.id,
    extensionBaseUrl: chrome.runtime.getURL(''),
    authority: deps.authority ?? FOLDER_WRITE_AUTHORITY,
  });
  if (!decision.ok) return Promise.resolve({ kind: 'refused', reason: decision.reason });
  return dispatchFolderOwnerRequest(request, deps.core);
}

export function startFolderOwner(authority: Authority = FOLDER_WRITE_AUTHORITY): FolderOwnerCore {
  const core = createFolderOwnerCore({ area: localFolderArea, serialize: backgroundWriteQueue });
  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    const reply = handleFolderOwnerMessage(message, sender, { core, authority });
    if (!reply) return undefined;
    void reply.then(sendResponse);
    return true;
  });
  // The fence write (§3.3) ships with L1; startup drains only keys of owner sites.
  void drainOwnedKeys(localFolderArea, core, authority).catch((error: unknown) =>
    logger.warn('Folder owner startup drain failed', { error: String(error) }),
  );
  return core;
}
