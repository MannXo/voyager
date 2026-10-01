import { MAX_FOLDER_DEPTH } from '@/features/folder/constants';
import { getFolderDepth, removeFolder } from '@/features/folder/model/folderData';
import { placeConversations } from '@/features/folder/model/placeConversations';
import { FolderRepository } from '@/pages/content/folder/FolderRepository';
import { AIStudioFolderStorageAdapter } from '@/pages/content/folder/storage/AIStudioFolderStorageAdapter';
import type { IFolderStorageAdapter } from '@/pages/content/folder/storage/FolderStorageAdapter';
import type { ConversationReference, Folder, FolderData } from '@/pages/content/folder/types';

import { CHATGPT_FOLDER_CONFIG } from './config';

/**
 * ChatGPT folder commands over the shared FolderRepository, which owns load,
 * recovery, serialized saves and cross-tab reloads. The adapter writes only
 * `chrome.storage.local` (despite its name), never chatgpt.com's localStorage.
 */
export class ChatGptFolderStore {
  private readonly repository: FolderRepository;
  private readonly listeners = new Set<() => void>();

  constructor(storage: IFolderStorageAdapter = new AIStudioFolderStorageAdapter()) {
    this.repository = new FolderRepository(CHATGPT_FOLDER_CONFIG, storage, {
      onChange: () => this.emit(),
      onRecovery: () => this.emit(),
      onExternalChange: () => void this.repository.loadData(),
      onAccountReleased: () => {},
      isEnabled: () => true,
    });
  }

  get data(): FolderData {
    return this.repository.data;
  }
  get ready(): boolean {
    return this.repository.canEdit;
  }

  init(): Promise<void> {
    return this.repository.init();
  }
  destroy(): void {
    this.listeners.clear();
    this.repository.destroy();
  }
  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  createFolder(name: string, parentId: string | null): void {
    if (parentId !== null && getFolderDepth(this.data, parentId) >= MAX_FOLDER_DEPTH) return;
    const siblings = this.data.folders.filter((folder) => folder.parentId === parentId);
    const now = Date.now();
    const folder: Folder = {
      id: `folder_${now}_${Math.random().toString(36).slice(2, 11)}`,
      name,
      parentId,
      isExpanded: true,
      sortIndex: siblings.reduce((max, f) => Math.max(max, f.sortIndex ?? -1), -1) + 1,
      createdAt: now,
      updatedAt: now,
    };
    this.commit(() => {
      this.data.folders.push(folder);
      this.data.folderContents[folder.id] = [];
    });
  }
  renameFolder(folderId: string, name: string): void {
    this.editFolder(folderId, (folder) => (folder.name = name));
  }
  setFolderColor(folderId: string, color: string): void {
    this.editFolder(folderId, (folder) => (folder.color = color));
  }
  toggleFolderPinned(folderId: string): void {
    this.editFolder(folderId, (folder) => (folder.pinned = !folder.pinned));
  }
  toggleFolderExpanded(folderId: string): void {
    this.editFolder(folderId, (folder) => (folder.isExpanded = !folder.isExpanded));
  }
  removeFolder(folderId: string): void {
    this.commit(() => (this.repository.data = removeFolder(this.data, folderId)));
  }

  toggleStar(folderId: string, conversationId: string): void {
    const conversation = this.data.folderContents[folderId]?.find(
      (c) => c.conversationId === conversationId,
    );
    if (conversation) this.commit(() => (conversation.starred = !conversation.starred));
  }
  removeConversation(folderId: string, conversationId: string): void {
    const bucket = this.data.folderContents[folderId];
    if (!bucket) return;
    this.commit(() => {
      this.data.folderContents[folderId] = bucket.filter(
        (c) => c.conversationId !== conversationId,
      );
    });
  }
  moveConversation(conversationId: string, fromFolderId: string, toFolderId: string): void {
    const conversation = this.data.folderContents[fromFolderId]?.find(
      (c) => c.conversationId === conversationId,
    );
    if (!conversation) return;
    this.commit(() => {
      this.repository.data = placeConversations(this.data, [conversation], {
        target: toFolderId,
        placement: 'append',
        removeFrom: { bucket: fromFolderId },
        removeWhenPresent: true,
      }).data;
    });
  }
  /** Files `conversation` into `target`; `false` when it is already there or edits are closed. */
  addConversation(target: string, conversation: ConversationReference): boolean {
    if (!this.ready) return false;
    const placed = placeConversations(this.data, [conversation], { target, placement: 'top' });
    if (placed.added.length === 0) return false;
    this.commit(() => (this.repository.data = placed.data));
    return true;
  }

  /** Persists a whole new snapshot (an import); edits are closed until it settles. */
  replaceData(data: FolderData): Promise<boolean> {
    return this.repository.replaceData(data);
  }

  private editFolder(folderId: string, edit: (folder: Folder) => void): void {
    const folder = this.data.folders.find((candidate) => candidate.id === folderId);
    if (!folder) return;
    this.commit(() => {
      edit(folder);
      folder.updatedAt = Date.now();
    });
  }
  private commit(mutate: () => void): void {
    if (!this.ready) return;
    mutate();
    void this.repository.saveData();
    this.emit();
  }
  private emit(): void {
    for (const listener of this.listeners) listener();
  }
}
