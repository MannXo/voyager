/**
 * ChatGPT folders (P1): a floating folder panel for ChatGPT on the shared folder
 * core. The store is the shared FolderRepository with ChatGPT's own bucket; the
 * panel is the shared shadow-root panel. Everything this plugin creates is
 * registered on its PluginScope, so turning it off leaves nothing behind.
 */
import { cloneFolderData } from '@/features/folder/model/folderData';
import { FolderImportExportService } from '@/features/folder/services/FolderImportExportService';
import type { PluginScope } from '@/features/plugins/runtime/pluginScope';
import type { PluginSettings } from '@/features/plugins/types';
import { mountFloatingFab, unmountFloatingFab } from '@/pages/content/folder/floatingModeFab';
import { type FloatingPanelHandle, mountFloatingPanel } from '@/pages/content/folder/floatingPanel';
import { createFolderDialogs } from '@/pages/content/folder/folderDialogs';
import { getTranslationSyncUnsafe as t, initI18n } from '@/utils/i18n';

import { isTemporaryChat } from '../chatgptTemporaryHandoff/handoff';
import { ChatGptFolderStore } from './ChatGptFolderStore';
import { openChatGptConversation, readCurrentConversation } from './chatgptPage';
import { ChatGptSidebarWatcher } from './chatgptSidebarWatcher';
import { syncSidebarTitles } from './chatgptTitleSync';
import { CHATGPT_FOLDER_CONFIG } from './config';
import { BOOKMARK_ADD_PATH, DOWNLOAD_PATH, UPLOAD_PATH } from './icons';
import { type ChatGptFolderPanelPrefs, loadPanelPrefs, savePanelPrefs } from './panelPrefs';
import {
  chatgptFolderExportFilename,
  exportChatGptFolders,
  importChatGptFolders,
} from './transfer';

const HINT_KEYS = ['chatgptFoldersHint', 'floatingPanelGestureHint'];

function format(key: string, values: Record<string, string | number>): string {
  return Object.entries(values).reduce(
    (text, [name, value]) => text.split(`{${name}}`).join(String(value)),
    t(key),
  );
}

class ChatGptFoldersView {
  private panel: FloatingPanelHandle | null = null;
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
    if (this.prefs.open) this.mountPanel();
  }

  refresh(): void {
    this.panel?.update(this.store.data);
    this.panel?.setDataReady(this.store.ready);
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
    });
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
    const added = this.store.addConversation(folderId, conversation);
    this.panel?.flash(t(added ? 'chatgptFoldersAdded' : 'chatgptFoldersAlreadyFiled'));
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
  _settings: PluginSettings = {},
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
  sidebar.onChange((nav) => syncSidebarTitles(store, nav));
  scope.effect(() => store.subscribe(() => sidebar.schedule()), 'chatgpt-folders:sidebar-sync');
  sidebar.start();
  await store.init();
  if (scope.isDisposed) return;
  view.refresh();
  sidebar.schedule();
}
