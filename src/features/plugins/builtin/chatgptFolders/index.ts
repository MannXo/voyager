/**
 * ChatGPT folders on the shared folder core: a folder section in ChatGPT's
 * sidebar, the shared floating panel, and "Move to folder" in a row's menu. The
 * store is the shared FolderRepository with ChatGPT's own bucket. Everything this
 * plugin creates is registered on its PluginScope, so turning it off leaves
 * nothing behind.
 */
import type { ConversationReference } from '@/core/types/folder';
import { cloneFolderData } from '@/features/folder/model/folderData';
import { FolderImportExportService } from '@/features/folder/services/FolderImportExportService';
import type { PluginScope } from '@/features/plugins/runtime/pluginScope';
import type { PluginSettings } from '@/features/plugins/types';
import { mountFloatingFab, unmountFloatingFab } from '@/pages/content/folder/floatingModeFab';
import { type FloatingPanelHandle, mountFloatingPanel } from '@/pages/content/folder/floatingPanel';
import type { TreeActions } from '@/pages/content/folder/floatingTree/shared';
import { createFolderDialogs } from '@/pages/content/folder/folderDialogs';
import { getTranslationSyncUnsafe as t, initI18n } from '@/utils/i18n';

import { isTemporaryChat } from '../chatgptTemporaryHandoff/handoff';
import { type AddOutcome, ChatGptFolderStore } from './ChatGptFolderStore';
import { type FolderPickerHandle, openFolderPicker } from './chatgptFolderPicker';
import { ChatGptFolderSection } from './chatgptFolderSection';
import { ChatGptHideFiled, HIDE_FILED_SETTING } from './chatgptHideFiled';
import { ChatGptMoveMenu, MOVE_ENTRY_ATTR } from './chatgptMoveMenu';
import { openChatGptConversation, readCurrentConversation } from './chatgptPage';
import { ChatGptSidebarWatcher } from './chatgptSidebarWatcher';
import { ChatGptTitleSync } from './chatgptTitleSync';
import { CHATGPT_FOLDER_CONFIG } from './config';
import { BOOKMARK_ADD_PATH, DOWNLOAD_PATH, UPLOAD_PATH } from './icons';
import { type ChatGptFolderPanelPrefs, loadPanelPrefs, savePanelPrefs } from './panelPrefs';
import {
  chatgptFolderExportFilename,
  exportChatGptFolders,
  importChatGptFolders,
} from './transfer';

const HINT_KEYS = ['chatgptFoldersHint', 'floatingPanelGestureHint'];

const ADD_OUTCOME_KEYS: Record<Exclude<AddOutcome, 'closed'>, string> = {
  added: 'chatgptFoldersAdded',
  present: 'chatgptFoldersAlreadyFiled',
  // The folder was deleted elsewhere; trying again shows the current folders.
  missing: 'folder_save_error',
};

function format(key: string, values: Record<string, string | number>): string {
  return Object.entries(values).reduce(
    (text, [name, value]) => text.split(`{${name}}`).join(String(value)),
    t(key),
  );
}

class ChatGptFoldersView {
  private panel: FloatingPanelHandle | null = null;
  private section: ChatGptFolderSection | null = null;
  private picker: FolderPickerHandle | null = null;
  // Gemini's removal confirm; it closes with the panel.
  private readonly dialogs = createFolderDialogs();

  constructor(
    private readonly scope: PluginScope,
    private readonly store: ChatGptFolderStore,
    private readonly prefs: ChatGptFolderPanelPrefs,
  ) {}

  start(): void {
    this.scope.effect(() => {
      mountFloatingFab({
        onClick: () => this.setOpen(!this.panel),
        storedPos: this.prefs.fabPos,
        onPosChange: (pos) => this.savePrefs({ fabPos: pos }),
      });
      return unmountFloatingFab;
    }, 'chatgpt-folders:fab');
    this.scope.effect(() => this.store.subscribe(() => this.refresh()), 'chatgpt-folders:sync');
    this.scope.effect(() => () => this.unmountPanel(), 'chatgpt-folders:panel');
    this.scope.effect(() => {
      const section = new ChatGptFolderSection(
        this.store.data,
        CHATGPT_FOLDER_CONFIG.rootBucketId,
        this.treeActions(),
      );
      section.setDataReady(this.store.ready);
      this.section = section;
      return () => {
        this.section = null;
        section.destroy();
      };
    }, 'chatgpt-folders:section');
    this.scope.effect(
      () => () => {
        this.picker?.close();
        this.picker = null;
        for (const entry of document.querySelectorAll(`[${MOVE_ENTRY_ATTR}]`)) entry.remove();
      },
      'chatgpt-folders:move-to-folder',
    );
    if (this.prefs.open) this.mountPanel();
  }

  refresh(): void {
    this.panel?.update(this.store.data);
    this.panel?.setDataReady(this.store.ready);
    this.section?.update(this.store.data);
    this.section?.setDataReady(this.store.ready);
  }

  /** Keeps the sidebar section in ChatGPT's sidebar; called after every sidebar change. */
  placeSection(sidebar: HTMLElement | null): void {
    this.section?.place(sidebar);
  }

  /** "Move to folder" from a sidebar row's menu: files `conversation` where the user picks. */
  pickFolderFor(conversation: ConversationReference): void {
    if (this.scope.isDisposed || !this.store.ready) return;
    this.picker?.close();
    this.picker = openFolderPicker(this.store.data.folders, (folderId) => {
      this.picker = null;
      const outcome = this.store.addConversation(folderId, conversation);
      if (outcome === 'closed') return;
      // The menu sits in the sidebar, so the section is where the user is looking.
      const message = t(ADD_OUTCOME_KEYS[outcome]);
      this.section?.flash(message);
      this.panel?.flash(message);
    });
  }

  private setOpen(open: boolean): void {
    if (open) this.mountPanel();
    else this.unmountPanel();
    this.savePrefs({ open });
  }

  private savePrefs(change: Partial<ChatGptFolderPanelPrefs>): void {
    Object.assign(this.prefs, change);
    void savePanelPrefs({ ...this.prefs });
  }

  private mountPanel(): void {
    if (this.panel) return;
    const store = this.store;
    this.panel = mountFloatingPanel({
      data: store.data,
      rootBucketId: CHATGPT_FOLDER_CONFIG.rootBucketId,
      dataReady: store.ready,
      cloudActions: false,
      hintKeys: HINT_KEYS,
      headerActions: [
        {
          modifier: 'add-current',
          labelKey: 'chatgptFoldersAddCurrent',
          iconPath: BOOKMARK_ADD_PATH,
          onClick: () => this.addCurrent(CHATGPT_FOLDER_CONFIG.rootBucketId),
        },
        {
          modifier: 'import',
          labelKey: 'folder_import',
          iconPath: UPLOAD_PATH,
          onClick: () => this.pickImportFile(),
        },
        {
          modifier: 'export',
          labelKey: 'folder_export',
          iconPath: DOWNLOAD_PATH,
          onClick: () => this.exportFolders(),
        },
      ],
      storedPos: this.prefs.pos,
      storedSize: this.prefs.size,
      onPosChange: (pos) => this.savePrefs({ pos }),
      onSizeChange: (size) => this.savePrefs({ size }),
      onClose: () => {
        this.dialogs.closeAll();
        this.panel = null;
        this.savePrefs({ open: false });
      },
      ...this.treeActions(),
    });
  }

  /** What both the panel and the sidebar section do on a tree gesture. */
  private treeActions(): TreeActions {
    const store = this.store;
    return {
      onNavigate: (conversation) => void openChatGptConversation(conversation),
      onCreateFolder: (name, parentId) => store.createFolder(name, parentId),
      onRenameFolder: (folderId, name) => store.renameFolder(folderId, name),
      onDeleteFolder: (folderId) => store.removeFolder(folderId),
      onRemoveConversation: (folderId, id) => store.removeConversation(folderId, id),
      confirmConversationRemoval: this.dialogs.confirmConversationRemoval,
      onToggleStar: (folderId, id) => store.toggleStar(folderId, id),
      onToggleFolderPinned: (folderId) => store.toggleFolderPinned(folderId),
      onToggleFolderExpanded: (folderId) => store.toggleFolderExpanded(folderId),
      onMoveConversation: (id, from, to) => store.moveConversation(id, from, to),
      onSetFolderColor: (folderId, color) => store.setFolderColor(folderId, color),
      onAddCurrentConversation: (folderId) => this.addCurrent(folderId),
    };
  }

  private unmountPanel(): void {
    this.dialogs.closeAll();
    this.panel?.destroy();
    this.panel = null;
  }

  private addCurrent(folderId: string): void {
    // The handoff plugin's check also reads the temporary-chat toggle, not just the URL.
    const conversation = isTemporaryChat()
      ? null
      : readCurrentConversation(t('chatgptFoldersUntitled'));
    if (!conversation) {
      this.panel?.flash(t('chatgptFoldersNoConversation'));
      return;
    }
    if (!this.store.ready) return;
    const outcome = this.store.addConversation(folderId, conversation);
    if (outcome !== 'closed') this.panel?.flash(t(ADD_OUTCOME_KEYS[outcome]));
  }

  private exportFolders(): void {
    FolderImportExportService.downloadJSON(
      exportChatGptFolders(this.store.data),
      chatgptFolderExportFilename(),
    );
    this.panel?.flash(t('folder_export_success'));
  }

  private pickImportFile(): void {
    // Never attached to the page: the picker needs only the click.
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = 'application/json,.json';
    input.addEventListener('change', () => void this.importFile(input.files?.[0]), {
      once: true,
    });
    input.click();
  }

  private async importFile(file: File | undefined): Promise<void> {
    if (!file) return;
    const parsed = await FolderImportExportService.readJSONFile(file);
    if (this.scope.isDisposed) return;
    if (!parsed.success) {
      this.panel?.flash(t('folder_import_invalid_format'));
      return;
    }
    if (!this.store.ready) return;
    const outcome = await importChatGptFolders(parsed.data, cloneFolderData(this.store.data));
    if (this.scope.isDisposed) return;
    if (!outcome.ok) {
      const message =
        outcome.reason === 'wrong-site'
          ? t('folder_import_wrong_site')
          : outcome.reason === 'invalid'
            ? t('folder_import_invalid_format')
            : format('folder_import_error', { error: outcome.message ?? '' });
      this.panel?.flash(message);
      return;
    }
    const saved = await this.store.replaceData(outcome.data);
    if (this.scope.isDisposed) return;
    this.panel?.flash(
      saved
        ? format('folder_import_success', {
            folders: outcome.stats.foldersImported,
            conversations: outcome.stats.conversationsImported,
          })
        : format('folder_import_error', { error: '' }),
    );
  }
}

export async function activateChatGptFolders(
  scope: PluginScope,
  settings: PluginSettings = {},
): Promise<void> {
  await initI18n();
  if (scope.isDisposed) return;
  const store = new ChatGptFolderStore();
  scope.child(store, 'chatgpt-folders:store');
  const prefs = await loadPanelPrefs();
  if (scope.isDisposed) return;
  const view = new ChatGptFoldersView(scope, store, prefs);
  view.start();
  const sidebar = new ChatGptSidebarWatcher(scope);
  const moveMenu = new ChatGptMoveMenu({
    label: () => t('conversation_move_to_folder'),
    untitled: () => t('chatgptFoldersUntitled'),
    canFile: () => store.ready,
    onMove: (conversation) => view.pickFolderFor(conversation),
  });
  const titles = new ChatGptTitleSync(store);
  scope.effect(() => () => moveMenu.cancel(), 'chatgpt-folders:move-menu');
  sidebar.onChange((nav) => {
    view.placeSection(nav);
    titles.sync(nav);
    if (moveMenu.check(nav)) sidebar.schedule();
  });
  scope.effect(() => store.subscribe(() => sidebar.schedule()), 'chatgpt-folders:sidebar-sync');
  sidebar.start();
  const hideFiled = settings[HIDE_FILED_SETTING] === true ? new ChatGptHideFiled(scope) : null;
  if (hideFiled) {
    scope.effect(
      () => store.subscribe(() => hideFiled.update(store.filedIds())),
      'chatgpt-folders:hide-filed-sync',
    );
  }
  await store.init();
  if (scope.isDisposed) return;
  view.refresh();
  hideFiled?.update(store.filedIds());
  sidebar.schedule();
}
