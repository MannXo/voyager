import { hashValue } from './canonicalHash';
import type { FolderOwnerStorageArea } from './folderOwnerState';

export const BUNDLE_INTENT_KEY = 'gvFolderOwner:bundleIntent';

type BundleIntent =
  | {
      txId: string;
      status: 'open';
      values: Record<string, unknown>;
      hashes: Record<string, string>;
    }
  | { txId: string; status: 'closed' };

function isOpenBundle(value: unknown): value is Extract<BundleIntent, { status: 'open' }> {
  if (typeof value !== 'object' || value === null) return false;
  const intent = value as Record<string, unknown>;
  return (
    intent.status === 'open' &&
    typeof intent.txId === 'string' &&
    typeof intent.values === 'object' &&
    intent.values !== null
  );
}

/**
 * Writes several keys as one transaction with respect to queue participants
 * (§9): the full next values go into the intent first, so a crash at any point
 * ends as all of them once `resolveBundleIntent` runs. Callers run inside the queue.
 */
export async function writeBundle(
  area: FolderOwnerStorageArea,
  txId: string,
  values: Record<string, unknown>,
): Promise<void> {
  const hashes: Record<string, string> = {};
  for (const [key, value] of Object.entries(values)) hashes[key] = await hashValue(value);
  await area.set({ [BUNDLE_INTENT_KEY]: { txId, status: 'open', values, hashes } });
  await area.set(values);
  await area.set({ [BUNDLE_INTENT_KEY]: { txId, status: 'closed' } });
}

/**
 * Finishes an open bundle before any participant reads: writes its values again
 * (harmless when they landed) and closes it. Every queue turn of both owners runs this first.
 */
export async function resolveBundleIntent(
  area: FolderOwnerStorageArea,
): Promise<'ok' | 'read_failed' | 'write_failed'> {
  let intent: unknown;
  try {
    intent = (await area.get([BUNDLE_INTENT_KEY]))[BUNDLE_INTENT_KEY];
  } catch {
    return 'read_failed';
  }
  if (!isOpenBundle(intent)) return 'ok';
  try {
    await area.set(intent.values);
    await area.set({ [BUNDLE_INTENT_KEY]: { txId: intent.txId, status: 'closed' } });
  } catch {
    return 'write_failed';
  }
  return 'ok';
}
