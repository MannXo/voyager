import { findInheritedFolderKey, findRepeatedFolderId } from '@/features/folder/model/folderData';

function isRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

/** A corrupt or partially usable bucket cannot supersede a recoverable local edit. */
export function isValidFolderWrite(value: unknown): boolean {
  if (!isRecord(value) || !Array.isArray(value.folders) || !isRecord(value.folderContents))
    return false;
  const folders: unknown[] = value.folders;
  if (
    !folders.every(
      (folder) =>
        isRecord(folder) &&
        typeof folder.id === 'string' &&
        folder.id !== '' &&
        typeof folder.name === 'string' &&
        folder.name !== '',
    )
  )
    return false;
  const ids = folders as { id: string }[];
  if (
    findRepeatedFolderId(ids) !== null ||
    findInheritedFolderKey(ids, value.folderContents) !== null
  )
    return false;
  return Object.values(value.folderContents).every(
    (bucket) =>
      Array.isArray(bucket) &&
      bucket.every(
        (entry: unknown) =>
          isRecord(entry) &&
          typeof entry.conversationId === 'string' &&
          entry.conversationId !== '' &&
          typeof entry.title === 'string' &&
          entry.title !== '',
      ),
  );
}
