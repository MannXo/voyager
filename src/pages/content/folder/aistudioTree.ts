import { AISTUDIO_ROOT_BUCKET_ID } from '@/features/folder/constants';
import { ownBucket, setBucket } from '@/features/folder/model/folderData';

import panelCss from './floatingPanel.css?raw';
import {
  FLOATING_PANEL_CLASS,
  type TreeActions,
  type TreeSiteOptions,
} from './floatingTree/shared';
import { mountFolderTree } from './floatingTree/treeController';
import { attachShadowSurface } from './shadowHost';
import type { ConversationReference, Folder, FolderData } from './types';

/**
 * The AI Studio sidebar's folder tree: the shared floating-panel tree, placed in
 * the left nav instead of floating.
 *
 * It lives in a shadow root like the floating panel. That reuses the panel's
 * stylesheet without restyling AI Studio's `.gv-folder-*` rules, keeps the
 * page's Material styles out, and the document_start key guard already runs on
 * aistudio.google.com for fields in a shadow surface. Drops from native prompt
 * rows still arrive: drag events cross the shadow boundary, and the tree hands
 * them to `onDrop`.
 */
export const AISTUDIO_TREE_HOST_CLASS = 'gv-aistudio-folder-tree';

/** Drag types an AI Studio prompt can carry: Voyager JSON, or the prompt's link. */
export const AISTUDIO_PROMPT_DRAG_TYPES: readonly string[] = [
  'application/json',
  'text/plain',
  'text/uri-list',
  'text/x-moz-url',
  'URL',
];

const SITE: TreeSiteOptions = {
  folderOrder: 'created',
  conversationOrder: 'stored',
  rootSection: { labelKey: 'folder_uncategorized' },
  folderMenuButton: { labelKey: 'folder_settings' },
  folderBodyDrop: true,
};

/**
 * Turns the floating panel into a block in the nav. Host rules must be
 * `!important` to beat page rules that match the host; this sheet comes after
 * the panel's, and `:host([data-gv-scheme])` matches the specificity of the
 * panel's scheme blocks, so these win over both.
 */
export const AISTUDIO_TREE_CSS = `
:host,
:host([data-gv-scheme]) {
  position: relative !important;
  z-index: auto !important;
  display: block !important;
  min-width: 0 !important;
  min-height: 0 !important;
  max-width: none !important;
  max-height: none !important;
  resize: none !important;
  background: transparent !important;
  border: 0 !important;
  border-radius: 0 !important;
  box-shadow: none !important;
  overflow: visible !important;
  font-size: 13px !important;
}

.${FLOATING_PANEL_CLASS}__body {
  overflow: visible;
  padding: 0 0 4px;
}

/* AI Studio's nav is denser than Gemini's: names keep its 12px. */
.${FLOATING_PANEL_CLASS}__folder-name,
.${FLOATING_PANEL_CLASS}__conv-title {
  font-size: 12px;
}

.${FLOATING_PANEL_CLASS}__empty {
  padding: 8px 12px;
}

.${FLOATING_PANEL_CLASS}__empty-icon {
  display: none;
}
`;

export type AIStudioTree = {
  /** Insert into the sidebar; `destroy` removes it. */
  host: HTMLElement;
  /** New data; waits while a folder name is being typed. */
  update: (data: FolderData) => void;
  /** Another account's data: drops open name forms and the folder menu. */
  reset: (data: FolderData) => void;
  setActiveConversation: (conversationId: string | null) => void;
  /** Opens the name form for a new top-level folder. */
  startCreateFolder: () => void;
  destroy: () => void;
};

export function mountAIStudioTree(options: {
  data: FolderData;
  actions: TreeActions;
  activeConversationId: string | null;
}): AIStudioTree {
  const host = document.createElement('div');
  host.className = AISTUDIO_TREE_HOST_CLASS;
  const surface = attachShadowSurface(host, `${panelCss}\n${AISTUDIO_TREE_CSS}`);
  const body = document.createElement('div');
  body.className = `${FLOATING_PANEL_CLASS}__body`;
  surface.root.appendChild(body);

  let activeConversationId = options.activeConversationId;
  const tree = mountFolderTree({
    body,
    boundary: host,
    focusRoot: surface.root,
    data: options.data,
    rootBucketId: AISTUDIO_ROOT_BUCKET_ID,
    conversationSortMode: 'manual',
    actions: options.actions,
    site: { ...SITE, activeConversationId },
  });

  return {
    host,
    update: (data) => tree.update(data),
    reset: (data) => tree.reset(data),
    setActiveConversation: (conversationId) => {
      if (conversationId === activeConversationId) return;
      activeConversationId = conversationId;
      tree.setSite({ ...SITE, activeConversationId });
    },
    startCreateFolder: () =>
      tree.apply({ inlineEditor: { mode: 'create', parentId: null }, contextMenu: null }),
    destroy: () => {
      tree.destroy();
      surface.disconnect();
      host.remove();
    },
  };
}

// Edits the tree asks for, applied to the live folder data in place as the
// manager saves it. Each returns whether anything changed.

export function addFolder(
  data: FolderData,
  folder: { id: string; name: string; parentId: string | null; at: number },
): boolean {
  if (folder.parentId && !data.folders.some((candidate) => candidate.id === folder.parentId)) {
    return false;
  }
  data.folders.push({
    id: folder.id,
    name: folder.name,
    parentId: folder.parentId,
    isExpanded: true,
    createdAt: folder.at,
    updatedAt: folder.at,
  });
  setBucket(data.folderContents, folder.id, []);
  return true;
}

function findFolder(data: FolderData, folderId: string): Folder | undefined {
  return data.folders.find((folder) => folder.id === folderId);
}

export function renameFolder(data: FolderData, folderId: string, name: string, at: number) {
  const folder = findFolder(data, folderId);
  if (!folder) return false;
  folder.name = name;
  folder.updatedAt = at;
  return true;
}

/** Removes a folder, the folders inside it, and what they hold. */
export function deleteFolderTree(data: FolderData, folderId: string): boolean {
  const doomed = new Set([folderId]);
  for (let grew = true; grew;) {
    grew = false;
    for (const folder of data.folders) {
      if (folder.parentId && doomed.has(folder.parentId) && !doomed.has(folder.id)) {
        doomed.add(folder.id);
        grew = true;
      }
    }
  }
  const before = data.folders.length;
  data.folders = data.folders.filter((folder) => !doomed.has(folder.id));
  for (const id of doomed) {
    if (Object.hasOwn(data.folderContents, id)) delete data.folderContents[id];
  }
  return data.folders.length !== before;
}

export function toggleFolderPinned(data: FolderData, folderId: string): boolean {
  const folder = findFolder(data, folderId);
  if (!folder) return false;
  folder.pinned = !folder.pinned;
  return true;
}

export function toggleFolderExpanded(data: FolderData, folderId: string): boolean {
  const folder = findFolder(data, folderId);
  if (!folder) return false;
  folder.isExpanded = !folder.isExpanded;
  return true;
}

function findConversation(
  data: FolderData,
  folderId: string,
  conversationId: string,
): ConversationReference | undefined {
  return ownBucket(data.folderContents, folderId)?.find(
    (conversation) => conversation.conversationId === conversationId,
  );
}

export function toggleConversationStar(
  data: FolderData,
  folderId: string,
  conversationId: string,
): boolean {
  const conversation = findConversation(data, folderId, conversationId);
  if (!conversation) return false;
  conversation.starred = !conversation.starred;
  return true;
}

export function removeConversation(
  data: FolderData,
  folderId: string,
  conversationId: string,
): boolean {
  const bucket = ownBucket(data.folderContents, folderId);
  if (!bucket?.some((conversation) => conversation.conversationId === conversationId)) {
    return false;
  }
  setBucket(
    data.folderContents,
    folderId,
    bucket.filter((conversation) => conversation.conversationId !== conversationId),
  );
  return true;
}
