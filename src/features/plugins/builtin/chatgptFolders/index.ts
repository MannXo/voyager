/**
 * ChatGPT folders on the shared folder core: a folder section in ChatGPT's
 * sidebar (introduced once by a guide), the shared floating panel, and "Move to
 * folder" in a row's menu, or a row dragged onto a folder. The store is the
 * shared FolderRepository with ChatGPT's own bucket. Everything this plugin
 * creates is registered on its PluginScope, so turning it off leaves nothing behind.
 */
import {
  createBookmarkPlusIcon,
  createDownloadIcon,
  createUploadIcon,
} from '@/core/icons/folderIcons';
import type { ConversationReference } from '@/core/types/folder';
import type { EditOutcome, FolderCommands } from '@/features/folder/commands/folderCommands';
import { FolderImportExportService } from '@/features/folder/services/FolderImportExportService';
import type { PluginScope } from '@/features/plugins/runtime/pluginScope';
import type { PluginSettings } from '@/features/plugins/types';
import { createCommandTreeActions } from '@/pages/content/folder/commandTreeActions';
import { mountFloatingFab, unmountFloatingFab } from '@/pages/content/folder/floatingModeFab';
import { type FloatingPanelHandle, mountFloatingPanel } from '@/pages/content/folder/floatingPanel';
import type { FolderDropTarget } from '@/pages/content/folder/floatingTree/dropTargets';
import type { TreeActions } from '@/pages/content/folder/floatingTree/shared';
import { createFolderDialogs } from '@/pages/content/folder/folderDialogs';
import { getTranslationSyncUnsafe as t, initI18n } from '@/utils/i18n';

import { isTemporaryChat } from '../chatgptTemporaryHandoff/handoff';
import { ChatGptFolderStore } from './ChatGptFolderStore';
import { ChatGptFolderGuide } from './chatgptFolderGuide';
import { type FolderPickerHandle, openFolderPicker } from './chatgptFolderPicker';
import { ChatGptFolderSection, SECTION_ICON_SIZE } from './chatgptFolderSection';
import { ChatGptHideFiled, HIDE_FILED_SETTING } from './chatgptHideFiled';
import { ChatGptMoveMenu, MOVE_ENTRY_ATTR } from './chatgptMoveMenu';
import { openChatGptConversation, readCurrentConversation } from './chatgptPage';
import { type DroppedConversation, bindChatGptRowDrag } from './chatgptRowDrag';
import { ChatGptSidebarWatcher } from './chatgptSidebarWatcher';
import { ChatGptTitleSync } from './chatgptTitleSync';
import { CHATGPT_FOLDER_CONFIG } from './config';
import { BOOKMARK_ADD_PATH, DOWNLOAD_PATH, UPLOAD_PATH } from './icons';
import { createLegacyChatGptCommands } from './legacyChatGptCommands';
import { type ChatGptFolderPanelPrefs, loadPanelPrefs, savePanelPrefs } from './panelPrefs';
import { chatgptFolderExportFilename, exportChatGptFolders } from './transfer';

const HINT_KEYS = ['chatgptFoldersHint', 'floatingPanelGestureHint'];

/** The flash that confirms a filing, or `null` when the folders were not open for edits. */
function addOutcomeKey(outcome: EditOutcome): string | null {
  if (outcome.kind === 'failed') return null;
  if (outcome.kind === 'unchanged') return 'chatgptFoldersAlreadyFiled';
  // A rejection: the folder was deleted elsewhere; trying again shows the current folders.
  return outcome.kind === 'rejected' ? outcome.messageKey : 'chatgptFoldersAdded';
}

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
  private fabShown = false;
  // Gemini's removal confirm; it closes with the panel.
  private readonly dialogs = createFolderDialogs();

  constructor(
    private readonly scope: PluginScope,
    private readonly store: ChatGptFolderStore,
    private readonly commands: FolderCommands,
    private readonly prefs: ChatGptFolderPanelPrefs,
  ) {}

  start(): void {
    this.scope.effect(() => () => this.showFloatingEntry(false), 'chatgpt-folders:fab');
    this.scope.effect(() => this.store.subscribe(() => this.refresh()), 'chatgpt-folders:sync');
    this.scope.effect(() => () => this.unmountPanel(), 'chatgpt-folders:panel');
    this.scope.effect(() => {
      const section = new ChatGptFolderSection(
        this.store.data,
        CHATGPT_FOLDER_CONFIG.rootBucketId,
        this.treeActions(),
        [
          {
            modifier: 'add-current',
            labelKey: 'chatgptFoldersAddCurrent',
            icon: () => createBookmarkPlusIcon(SECTION_ICON_SIZE),
            onClick: () => this.addCurrent(CHATGPT_FOLDER_CONFIG.rootBucketId),
          },
          {
            modifier: 'import',
            labelKey: 'folder_import',
            icon: () => createUploadIcon(SECTION_ICON_SIZE),
            onClick: () => this.pickImportFile(),
          },
          {
            modifier: 'export',
            labelKey: 'folder_export',
            icon: () => createDownloadIcon(SECTION_ICON_SIZE),
            onClick: () => this.exportFolders(),
          },
        ],
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
    this.showFloatingEntry(!this.section?.element.isConnected);
  }

  /**
   * The sidebar section is the way in. ChatGPT has no floating-mode setting, so
   * the floating button (and the panel, if it was left open) stands in only
   * while the page shows no sidebar for the section; both together would be two
   * copies of the same tree.
   */
  private showFloatingEntry(show: boolean): void {
    if (show === this.fabShown || (show && this.scope.isDisposed)) return;
    this.fabShown = show;
    if (!show) {
      unmountFloatingFab();
      // Keeps `prefs.open`, so the panel comes back with its button.
      this.unmountPanel();
      return;
    }
    mountFloatingFab({
      onClick: () => this.setOpen(!this.panel),
      storedPos: this.prefs.fabPos,
      onPosChange: (pos) => this.savePrefs({ fabPos: pos }),
    });
    if (this.prefs.open) this.mountPanel();
  }

  /** The section's header while the section is in the page, for the one-time guide. */
  guideAnchor(): HTMLElement | null {
    return this.section?.element.isConnected ? this.section.header : null;
  }

  /** True while the section's own folder menu or name field is open. */
  sectionBusy(): boolean {
    return this.section?.busy ?? false;
  }

  /** "Move to folder" from a sidebar row's menu: files `conversation` where the user picks. */
  pickFolderFor(conversation: ConversationReference): void {
    if (this.scope.isDisposed || !this.store.ready) return;
    this.picker?.close();
    this.picker = openFolderPicker(this.store.data, (folderId) => {
      this.picker = null;
      this.file(folderId, conversation);
    });
  }

  /**
   * The folder drop target under a viewport point. The panel floats over the
   * sidebar, so the surface on top there answers; anything of ChatGPT's above
   * it, such as the row its own drag carries along, is looked through.
   */
  dropTargetAt(x: number, y: number): FolderDropTarget | null {
    const { panel, section } = this;
    for (const element of document.elementsFromPoint(x, y)) {
      if (element === panel?.element) return panel.dropTargetAt(x, y);
      if (element === section?.element) return section.dropTargetAt(x, y);
    }
    return null;
  }

  /** Files `conversation` into `folderId` and confirms the result in both trees. */
  file(folderId: string, conversation: DroppedConversation): void {
    const { conversationId, title, url } = conversation;
    void this.commands
      .run({
        kind: 'addConversations',
        target: folderId,
        seeds: [{ conversationId, title, url }],
        via: 'picker',
      })
      .then((outcome) => {
        const key = addOutcomeKey(outcome);
        if (key && !this.scope.isDisposed) this.flashTree(t(key));
      });
  }

  /**
   * Confirms a filing in both trees. The sidebar section, the panel and a row's
   * menu can all start one, and the panel may be closed.
   */
  private flashTree(message: string): void {
    this.section?.flash(message);
    this.panel?.flash(message);
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
    return {
      ...createCommandTreeActions(this.commands),
      onNavigate: (conversation) => void openChatGptConversation(conversation),
      confirmConversationRemoval: this.dialogs.confirmConversationRemoval,
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
      this.flashTree(t('chatgptFoldersNoConversation'));
      return;
    }
    if (!this.store.ready) return;
    this.file(folderId, conversation);
  }

  private exportFolders(): void {
    FolderImportExportService.downloadJSON(
      exportChatGptFolders(this.store.data),
      chatgptFolderExportFilename(),
    );
    this.flashTree(t('folder_export_success'));
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
      this.flashTree(t('folder_import_invalid_format'));
      return;
    }
    if (!this.store.ready) return;
    const outcome = await this.commands.runBulk({
      kind: 'importFile',
      payload: parsed.data,
      strategy: 'merge',
      source: 'file',
    });
    if (this.scope.isDisposed) return;
    const message = importMessage(outcome);
    if (message) this.flashTree(message);
  }
}

/** The panel's notice for an import, as today; `null` when the folders were not open for edits. */
function importMessage(outcome: EditOutcome): string | null {
  switch (outcome.kind) {
    case 'saved':
      return format('folder_import_success', {
        folders: outcome.stats?.foldersImported ?? 0,
        conversations: outcome.stats?.conversationsImported ?? 0,
      });
    case 'rejected':
      return t(outcome.messageKey);
    case 'failed':
      if (outcome.reason === 'not_loaded') return null;
      return format('folder_import_error', { error: outcome.detail ?? '' });
    default:
      return null;
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
  const commands = createLegacyChatGptCommands(store);
  const view = new ChatGptFoldersView(scope, store, commands, prefs);
  view.start();
  const sidebar = new ChatGptSidebarWatcher(scope);
  const moveMenu = new ChatGptMoveMenu({
    label: () => t('conversation_move_to_folder'),
    untitled: () => t('chatgptFoldersUntitled'),
    canFile: () => store.ready,
    onMove: (conversation) => view.pickFolderFor(conversation),
  });
  const titles = new ChatGptTitleSync(store, commands);
  const guide = new ChatGptFolderGuide(scope, {
    anchor: () => view.guideAnchor(),
    ready: () => store.ready,
    busy: () => view.sectionBusy(),
  });
  scope.effect(() => () => moveMenu.cancel(), 'chatgpt-folders:move-menu');
  bindChatGptRowDrag(scope, {
    untitled: () => t('chatgptFoldersUntitled'),
    dropTargetAt: (x, y) => view.dropTargetAt(x, y),
    onDrop: (folderId, conversation) => view.file(folderId, conversation),
  });
  const hideFiled = settings[HIDE_FILED_SETTING] === true ? new ChatGptHideFiled(scope) : null;
  sidebar.onChange((nav) => {
    view.placeSection(nav);
    hideFiled?.sync(nav);
    titles.sync(nav);
    guide.check();
    if (moveMenu.check(nav)) sidebar.schedule();
  });
  scope.effect(() => store.subscribe(() => sidebar.schedule()), 'chatgpt-folders:sidebar-sync');
  if (hideFiled) {
    scope.effect(
      () => store.subscribe(() => hideFiled.update(store.filedIds())),
      'chatgpt-folders:hide-filed-sync',
    );
  }
  sidebar.start();
  await store.init();
  if (scope.isDisposed) return;
  view.refresh();
  hideFiled?.update(store.filedIds());
  sidebar.schedule();
}
