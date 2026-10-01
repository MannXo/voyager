import type { ConversationReference, Folder, FolderData } from '@/core/types/folder';

export type ConversationSortMode = 'manual' | 'recent';

export function sortFolders(folders: readonly Folder[]): Folder[] {
  return [...folders].sort((a, b) => {
    if (a.pinned && !b.pinned) return -1;
    if (!a.pinned && b.pinned) return 1;

    const aIndex = a.sortIndex ?? -1;
    const bIndex = b.sortIndex ?? -1;
    if (aIndex >= 0 && bIndex >= 0) return aIndex - bIndex;

    return a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' });
  });
}

export function sortConversationsByPriority(
  conversations: readonly ConversationReference[],
  mode: ConversationSortMode = 'manual',
): ConversationReference[] {
  return [...conversations].sort((a, b) => {
    if (a.starred && !b.starred) return -1;
    if (!a.starred && b.starred) return 1;

    if (mode === 'manual') {
      const aIndex = a.sortIndex;
      const bIndex = b.sortIndex;
      if (aIndex != null && bIndex != null && aIndex !== bIndex) return aIndex - bIndex;
    }

    const timeDifference = (b.lastOpenedAt ?? b.addedAt ?? 0) - (a.lastOpenedAt ?? a.addedAt ?? 0);
    if (timeDifference !== 0) return timeDifference;
    return a.conversationId.localeCompare(b.conversationId);
  });
}

/** Includes the requested ID, even when only its legacy contents bucket remains. */
export function getFolderAndDescendants(data: FolderData, folderId: string): string[] {
  const children = new Map<string, string[]>();
  for (const folder of data.folders) {
    if (folder.parentId === null) continue;
    const siblings = children.get(folder.parentId) ?? [];
    siblings.push(folder.id);
    children.set(folder.parentId, siblings);
  }

  const result: string[] = [];
  const seen = new Set<string>();
  const pending = [folderId];
  while (pending.length > 0) {
    const id = pending.pop()!;
    if (seen.has(id)) continue;
    seen.add(id);
    result.push(id);
    const descendants = children.get(id) ?? [];
    for (let index = descendants.length - 1; index >= 0; index--) {
      pending.push(descendants[index]);
    }
  }
  return result;
}

/** Unknown folders have depth zero. Cyclic legacy parents are read without rewriting them. */
export function getFolderDepth(data: FolderData, folderId: string): number {
  let depth = 0;
  let current = data.folders.find((folder) => folder.id === folderId);
  const seen = new Set<string>();
  while (current?.parentId && !seen.has(current.id)) {
    seen.add(current.id);
    depth++;
    current = data.folders.find((folder) => folder.id === current?.parentId);
  }
  return depth;
}

function isFolderDescendant(data: FolderData, folderId: string, ancestorId: string): boolean {
  let currentId: string | null = folderId;
  const seen = new Set<string>();
  while (currentId && !seen.has(currentId)) {
    if (currentId === ancestorId) return true;
    seen.add(currentId);
    currentId = data.folders.find((folder) => folder.id === currentId)?.parentId || null;
  }
  return false;
}

/** Returns the original data when rejected; descendants and conversation records stay untouched. */
export function moveFolder(
  data: FolderData,
  folderId: string,
  targetParentId: string | null,
  now: number,
  insertIndex?: number,
): FolderData {
  const folder = data.folders.find((candidate) => candidate.id === folderId);
  if (!folder || folder.pinned || folderId === targetParentId) return data;
  if (targetParentId && isFolderDescendant(data, targetParentId, folderId)) return data;

  const sourceParentId = folder.parentId;
  if (insertIndex == null && sourceParentId === targetParentId) return data;

  const siblings = (parentId: string | null) =>
    sortFolders(
      data.folders.filter(
        (candidate) =>
          candidate.parentId === parentId &&
          candidate.id !== folderId &&
          !!candidate.pinned === !!folder.pinned,
      ),
    );
  const sourceSiblings = siblings(sourceParentId);
  const targetSiblings = siblings(targetParentId);
  let normalizedIndex = insertIndex ?? targetSiblings.length;
  if (sourceParentId === targetParentId) {
    const originalIndex = sortFolders(
      data.folders.filter(
        (candidate) =>
          candidate.parentId === sourceParentId && !!candidate.pinned === !!folder.pinned,
      ),
    ).findIndex((candidate) => candidate.id === folderId);
    if (originalIndex >= 0 && originalIndex < normalizedIndex) normalizedIndex--;
  }

  const nextOrder = [...targetSiblings];
  nextOrder.splice(Math.max(0, Math.min(normalizedIndex, targetSiblings.length)), 0, folder);
  const indices = new Map<Folder, number>(nextOrder.map((sibling, index) => [sibling, index]));
  if (sourceParentId !== targetParentId) {
    sourceSiblings.forEach((sibling, index) => indices.set(sibling, index));
  }

  return {
    ...data,
    folders: data.folders.map((candidate) => {
      const sortIndex = indices.get(candidate);
      if (candidate === folder)
        return { ...folder, parentId: targetParentId, updatedAt: now, sortIndex };
      return sortIndex != null && sortIndex !== candidate.sortIndex
        ? { ...candidate, sortIndex }
        : candidate;
    }),
  };
}

/** Removes only the selected subtree and its exact contents keys after the caller confirms. */
export function removeFolder(data: FolderData, folderId: string): FolderData {
  const removedIds = new Set(getFolderAndDescendants(data, folderId));
  const folders = data.folders.filter((folder) => !removedIds.has(folder.id));
  const folderContents = { ...data.folderContents };
  let removedContents = false;
  for (const id of removedIds) {
    if (!Object.hasOwn(folderContents, id)) continue;
    delete folderContents[id];
    removedContents = true;
  }
  return folders.length === data.folders.length && !removedContents
    ? data
    : { ...data, folders, folderContents };
}

/** Moves stored references, retaining their metadata and ordering within the dragged starred group. */
export function reorderConversations(
  data: FolderData,
  conversationIds: readonly string[],
  sourceParentId: string,
  targetParentId: string,
  insertIndex: number,
  mode: ConversationSortMode = 'manual',
): FolderData {
  const uniqueIds = [...new Set(conversationIds)];
  const source = ownBucket(data.folderContents, sourceParentId) ?? [];
  if (!source.some((conversation) => uniqueIds.includes(conversation.conversationId))) return data;

  const folderContents = {
    ...data.folderContents,
    [sourceParentId]: source.map((conversation) => ({ ...conversation })),
  };
  if (sourceParentId !== targetParentId) {
    setBucket(
      folderContents,
      targetParentId,
      (ownBucket(data.folderContents, targetParentId) ?? []).map((conversation) => ({
        ...conversation,
      })),
    );
  }
  const moving = uniqueIds.flatMap((id) => {
    const conversation = folderContents[sourceParentId].find(
      (candidate) => candidate.conversationId === id,
    );
    return conversation ? [conversation] : [];
  });
  const isStarred = moving[0].starred ?? false;

  if (sourceParentId === targetParentId) {
    const originalSorted = sortConversationsByPriority(
      folderContents[targetParentId].filter((conversation) => !!conversation.starred === isStarred),
      mode,
    );
    let adjustment = 0;
    for (const id of uniqueIds) {
      const originalIndex = originalSorted.findIndex(
        (conversation) => conversation.conversationId === id,
      );
      if (originalIndex >= 0 && originalIndex < insertIndex) adjustment++;
    }
    insertIndex -= adjustment;
  }

  const removeSet = new Set(conversationIds);
  setBucket(
    folderContents,
    sourceParentId,
    folderContents[sourceParentId].filter(
      (conversation) => !removeSet.has(conversation.conversationId),
    ),
  );
  if (sourceParentId !== targetParentId) {
    sortConversationsByPriority(folderContents[sourceParentId], mode).forEach(
      (conversation, index) => {
        conversation.sortIndex = index;
      },
    );
  }

  const target = folderContents[targetParentId].filter(
    (conversation) => !removeSet.has(conversation.conversationId),
  );
  const sameGroup = sortConversationsByPriority(
    target.filter((conversation) => !!conversation.starred === isStarred),
    mode,
  );
  const otherGroup = target.filter((conversation) => !!conversation.starred !== isStarred);
  // Keep the existing splice semantics: the UI supplies an index in the original starred group.
  sameGroup.splice(Math.min(insertIndex, sameGroup.length), 0, ...moving);
  sameGroup.forEach((conversation, index) => {
    conversation.sortIndex = index;
  });
  otherGroup.forEach((conversation, index) => {
    if (conversation.sortIndex == null) conversation.sortIndex = index;
  });
  setBucket(folderContents, targetParentId, [...sameGroup, ...otherGroup]);
  return { ...data, folderContents };
}

/** Repairs the existing persistence invariants without pruning legacy buckets or rewriting IDs/parents. */
export function normalizeFolderData(data: FolderData): FolderData {
  let changed = !data.folders || !data.folderContents;
  const originalFolders = data.folders ?? [];
  const folderContents = { ...data.folderContents };
  for (const folder of originalFolders) {
    // A missing bucket, including one only inherited (`__proto__` and
    // `constructor` read truthy), is repaired. A malformed bucket the folder
    // does own is not: the check below throws, so the load recovers a backup.
    if (!Object.hasOwn(folderContents, folder.id) || !folderContents[folder.id]) {
      setBucket(folderContents, folder.id, []);
      changed = true;
    }
  }

  const foldersByParent = new Map<string, Folder[]>();
  for (const folder of originalFolders) {
    const parentKey = folder.parentId ?? '__root__';
    const siblings = foldersByParent.get(parentKey) ?? [];
    siblings.push(folder);
    foldersByParent.set(parentKey, siblings);
  }
  const folderIndices = new Map<Folder, number>();
  for (const siblings of foldersByParent.values()) {
    if (!siblings.some((folder) => folder.sortIndex == null)) continue;
    [...siblings]
      .sort((a, b) =>
        a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' }),
      )
      .forEach((folder, index) => {
        if (folder.sortIndex == null) folderIndices.set(folder, index);
      });
  }
  const folders = originalFolders.map((folder) => {
    const sortIndex = folderIndices.get(folder);
    if (sortIndex == null) return folder;
    changed = true;
    return { ...folder, sortIndex };
  });

  for (const [folderId, conversations] of Object.entries(folderContents)) {
    if (!Array.isArray(conversations)) {
      throw new TypeError(`Folder bucket "${folderId}" is not a list`);
    }
    const seen = new Set<string>();
    let normalized = conversations.filter((conversation) => {
      if (seen.has(conversation.conversationId)) return false;
      seen.add(conversation.conversationId);
      return true;
    });
    const missingIndices = new Map<ConversationReference, number>();
    if (normalized.some((conversation) => conversation.sortIndex == null)) {
      [...normalized]
        .sort((a, b) => (b.lastOpenedAt ?? b.addedAt ?? 0) - (a.lastOpenedAt ?? a.addedAt ?? 0))
        .forEach((conversation, index) => {
          if (conversation.sortIndex == null) missingIndices.set(conversation, index);
        });
    }
    if (normalized.length === conversations.length && missingIndices.size === 0) continue;
    normalized = normalized.map((conversation) => {
      const sortIndex = missingIndices.get(conversation);
      return sortIndex == null ? conversation : { ...conversation, sortIndex };
    });
    setBucket(folderContents, folderId, normalized);
    changed = true;
  }
  return changed ? { ...data, folders, folderContents } : data;
}

/** Shallow structural check shared by load, migration and backup recovery. */
export function validateFolderData(data: unknown): boolean {
  if (typeof data !== 'object' || data === null) return false;
  const d = data as Record<string, unknown>;
  return Array.isArray(d.folders) && typeof d.folderContents === 'object';
}

/**
 * Whether `id` names a property every plain object inherits (`__proto__`,
 * `constructor`, `toString`…). No folder id or bucket key may be one: reading
 * it finds the inherited value, and assigning `__proto__` sets the prototype.
 */
export function isInheritedObjectKey(id: string): boolean {
  return id in Object.prototype;
}

/** The first folder id or bucket key in an imported file that is an inherited object key. */
export function findInheritedFolderKey(
  folders: readonly { id?: unknown }[],
  folderContents: object,
): string | null {
  const keys = [...folders.map((folder) => folder.id), ...Object.keys(folderContents)];
  const found = keys.find((key) => typeof key === 'string' && isInheritedObjectKey(key));
  return typeof found === 'string' ? found : null;
}

/**
 * The first folder id an imported file holds more than once. Two records with
 * one id share a bucket, and one naming itself as parent would nest forever.
 */
export function findRepeatedFolderId(folders: readonly { id?: unknown }[]): string | null {
  const seen = new Set<unknown>();
  for (const id of folders.map((folder) => folder?.id)) {
    if (seen.has(id)) return typeof id === 'string' ? id : String(id);
    seen.add(id);
  }
  return null;
}

/**
 * A folder id on a cycle of parent links in an imported file, a folder that is
 * its own parent included. The tree shows such a file only by cutting the
 * cycle, so the file is refused instead.
 */
export function findFolderInsideItself(
  folders: readonly { id?: unknown; parentId?: unknown }[],
): string | null {
  const parents = new Map<unknown, unknown>();
  for (const folder of folders) {
    if (folder && !parents.has(folder.id)) parents.set(folder.id, folder.parentId);
  }
  const sound = new Set<unknown>();
  for (const start of parents.keys()) {
    const path = new Set<unknown>();
    for (let id: unknown = start; id && !sound.has(id); id = parents.get(id)) {
      if (path.has(id)) return String(id);
      path.add(id);
    }
    path.forEach((id) => sound.add(id));
  }
  return null;
}

/**
 * Stores `bucket` under `id` as an own property. Plain assignment would set the
 * prototype for `__proto__` and leave the folder without a bucket, so every
 * write that rebuilds `folderContents` by id goes through here.
 */
export function setBucket<T>(contents: Record<string, T[]>, id: string, bucket: T[]): void {
  Object.defineProperty(contents, id, {
    value: bucket,
    writable: true,
    enumerable: true,
    configurable: true,
  });
}

/**
 * The bucket stored under `id` itself. Ids from a drag payload are page-readable
 * data, so an inherited key (`__proto__`, `constructor`) is never a bucket.
 */
export function ownBucket<T>(
  contents: Record<string, T[]>,
  id: string | undefined,
): T[] | undefined {
  if (!id || !Object.hasOwn(contents, id)) return undefined;
  const bucket = contents[id];
  return Array.isArray(bucket) ? bucket : undefined;
}

/** Copy folders and conversation references so a snapshot cannot alias live data. */
export function cloneFolderData(data: FolderData): FolderData {
  const folders = data.folders.map((folder) => ({ ...folder }));
  const folderContents = Object.fromEntries(
    Object.entries(data.folderContents || {}).map(([folderId, conversations]) => [
      folderId,
      Array.isArray(conversations)
        ? conversations.map((conversation) => ({ ...conversation }))
        : conversations,
    ]),
  );
  return { folders, folderContents };
}
