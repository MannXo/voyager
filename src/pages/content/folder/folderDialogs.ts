import type { Folder } from '@/core/types/folder';
import { getTranslationSyncUnsafe as t } from '@/utils/i18n';

import {
  type DialogView,
  dismissOnOutsideClick,
  openColorPicker,
  openInstructionsDialog,
  openMoveDialog,
  openRemovalConfirm,
  placeConfirm,
} from './folderDialogViews';
import { insertCreateEditor, openRenameEditor } from './folderInlineEditors';

type FolderMenuAction = { label: string; action: () => void };

export type FolderDialogs = {
  openCreate: (
    folderList: HTMLElement | null,
    parentId: string | null,
    onSubmit: (name: string) => void,
  ) => void;
  openRename: (
    folderElement: Element | null,
    currentName: string,
    onSubmit: (name: string) => void,
  ) => void;
  openColor: (
    folderId: string,
    currentColor: string | undefined,
    event: MouseEvent,
    onSelect: (color: string) => void,
    allowToggle?: boolean,
  ) => void;
  openMove: (folders: readonly Folder[], onSelect: (folderId: string) => void) => void;
  openInstructions: (
    instructions: string | undefined,
    onSave: (instructions: string | undefined) => Promise<boolean>,
  ) => void;
  confirmFolderRemoval: (folderElement: Element | null, onConfirm: () => void) => void;
  confirmConversationRemoval: (title: string, anchor: HTMLElement, onConfirm: () => void) => void;
  openMenu: (
    event: MouseEvent,
    items: readonly FolderMenuAction[],
    kind?: 'folder' | 'conversation',
  ) => void;
  closeInline: () => void;
  /** Close everything except the modals that hold unsaved input. */
  closeTransient: () => void;
  closeAll: () => void;
};

/** Owns temporary folder views, including listeners and deferred focus, for one runtime. */
export function createFolderDialogs(): FolderDialogs {
  const views = new Set<DialogView>();
  let activeCreate: { view: DialogView; input: HTMLInputElement } | null = null;
  let activeColor: { view: DialogView; folderId: string } | null = null;
  let conversationMenu: DialogView | null = null;

  const own = (
    element: HTMLElement,
    inline = false,
    restore?: () => void,
    modal = false,
  ): DialogView => {
    const controller = new AbortController();
    const timers = new Set<number>();
    const view: DialogView = {
      element,
      inline,
      modal,
      signal: controller.signal,
      close: () => {
        if (controller.signal.aborted) return;
        controller.abort();
        for (const timer of timers) window.clearTimeout(timer);
        timers.clear();
        element.remove();
        restore?.();
        views.delete(view);
        if (activeCreate?.view === view) activeCreate = null;
        if (activeColor?.view === view) activeColor = null;
        if (conversationMenu === view) conversationMenu = null;
      },
      defer: (action, delay) => {
        const timer = window.setTimeout(() => {
          timers.delete(timer);
          if (!controller.signal.aborted) action();
        }, delay);
        timers.add(timer);
      },
    };
    views.add(view);
    return view;
  };

  return {
    openCreate: (folderList, parentId, onSubmit) => {
      if (activeCreate && !activeCreate.view.element.isConnected) activeCreate.view.close();
      if (activeCreate) {
        activeCreate.input.focus();
        return;
      }
      if (!folderList) return;
      activeCreate = insertCreateEditor(own, folderList, parentId, onSubmit);
      activeCreate.input.focus();
    },

    openRename: (folderElement, currentName, onSubmit) =>
      openRenameEditor(own, folderElement, currentName, onSubmit),

    openColor: (folderId, currentColor, event, onSelect, allowToggle = true) => {
      if (activeColor) {
        const sameFolder = activeColor.folderId === folderId;
        activeColor.view.close();
        if (sameFolder && allowToggle) return;
      }
      const view = openColorPicker(own, currentColor, event, onSelect);
      activeColor = { view, folderId };
    },

    openMove: (folders, onSelect) => openMoveDialog(own, folders, onSelect),

    openInstructions: (instructions, onSave) => openInstructionsDialog(own, instructions, onSave),

    confirmFolderRemoval: (folderElement, onConfirm) => {
      const dialog = openRemovalConfirm(
        own,
        t('folder_delete_confirm'),
        t('folder_delete'),
        onConfirm,
      );
      const header = folderElement?.querySelector('.gv-folder-item-header');
      if (header) {
        const rect = header.getBoundingClientRect();
        placeConfirm(dialog, rect.left + 24, rect.bottom + 4);
        dialog.style.zIndex = '10002';
      } else if (folderElement) {
        const rect = folderElement.getBoundingClientRect();
        placeConfirm(dialog, rect.left, rect.top + 32);
        dialog.style.zIndex = '10002';
      }
    },

    confirmConversationRemoval: (title, anchor, onConfirm) => {
      const dialog = openRemovalConfirm(
        own,
        t('folder_remove_conversation_confirm').replace('{title}', () => title),
        // Removing from a folder keeps the conversation, so it is not a delete.
        t('folder_remove_conversation_action'),
        onConfirm,
      );
      const rect = anchor.getBoundingClientRect();
      placeConfirm(dialog, rect.left, rect.bottom + 4);
    },

    openMenu: (event, items, kind = 'folder') => {
      event.stopPropagation();
      if (kind === 'conversation') conversationMenu?.close();
      const menu = document.createElement('div');
      menu.className =
        kind === 'conversation' ? 'gv-folder-menu gv-folder-conversation-menu' : 'gv-folder-menu';
      menu.style.position = 'fixed';
      menu.style.left = `${event.clientX}px`;
      menu.style.top = `${event.clientY}px`;
      const view = own(menu);
      if (kind === 'conversation') conversationMenu = view;
      for (const item of items) {
        const button = document.createElement('button');
        button.className = 'gv-folder-menu-item';
        button.textContent = item.label;
        button.addEventListener(
          'click',
          () => {
            if (kind === 'conversation') view.close();
            item.action();
            view.close();
          },
          { signal: view.signal },
        );
        menu.appendChild(button);
      }
      document.body.appendChild(menu);
      dismissOnOutsideClick(view);
    },

    closeInline: () => {
      for (const view of views) if (view.inline) view.close();
    },
    closeTransient: () => {
      for (const view of views) if (!view.modal) view.close();
    },
    closeAll: () => {
      for (const view of views) view.close();
    },
  };
}
