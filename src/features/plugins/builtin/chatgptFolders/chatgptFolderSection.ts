import {
  createCircleCheckIcon,
  createClockArrowDownIcon,
  createPlusIcon,
  createTrashIcon,
  createXIcon,
} from '@/core/icons/folderIcons';
/**
 * The folder tree as a section of ChatGPT's own sidebar, just above Recents. It
 * reuses the floating panel's tree and sheet inside its own shadow host. ChatGPT
 * (React) may drop it on any re-render or remount the whole sidebar; `place`
 * puts it back and is called after every sidebar change. While the sidebar or
 * Recents is missing it stays out of the page and the plugin offers the
 * floating panel's button instead.
 */
import type { FolderData } from '@/core/types/folder';
import type { ConversationSortMode } from '@/features/folder/model/folderData';
import { hasSeenCoachmark } from '@/pages/content/coachmark';
import panelCss from '@/pages/content/folder/floatingPanel.css?raw';
import {
  type FolderDropTarget,
  folderDropTargetAt,
} from '@/pages/content/folder/floatingTree/dropTargets';
import {
  FLOATING_PANEL_CLASS,
  FOLDER_TOGGLE_DELAY_MS,
  type TreeActions,
  type TreeSiteOptions,
} from '@/pages/content/folder/floatingTree/shared';
import {
  type FolderTreeController,
  mountFolderTree,
} from '@/pages/content/folder/floatingTree/treeController';
import {
  FOLDER_HEADER_CSS,
  type FolderHeaderAction,
  createFolderHeader,
  setFolderHeaderAction,
  setFolderHeaderCollapsed,
  setFolderHeaderDisabled,
} from '@/pages/content/folder/folderHeader/folderHeader';
import { closeFolderHeaderMenu } from '@/pages/content/folder/folderHeader/folderHeaderMenu';
import type { SelectionToolbarIcon } from '@/pages/content/folder/selectionToolbar';
import { type ShadowSurface, attachShadowSurface } from '@/pages/content/folder/shadowHost';
import {
  type FolderSearchCriteria,
  createSidebarFilter,
  searchAndSortOptions,
  searchCriteriaOf,
} from '@/pages/content/folder/sidebarFilter';
import { FOLDER_ONLY_SEARCH_HINT_ID } from '@/pages/content/folder/sidebarPrefs';
import { type FolderSearchBox, createFolderSearch } from '@/pages/content/folder/sidebarSearch';
import { getTranslationSyncUnsafe as t } from '@/utils/i18n';

import sectionCss from './chatgptFolderSection.css?raw';
import { readChatGptConversation } from './chatgptIdentity';
import { findHistoryAnchor } from './chatgptSidebarDom';
import type { ChatGptFolderSectionPrefs } from './sectionPrefs';

export const FOLDER_SECTION_CLASS = 'gv-chatgpt-folder-section';
const SORT_TOGGLE_CLASS = `${FOLDER_SECTION_CLASS}__sort`;

/** Header icons, at the size of Gemini's folder header icons. */
export const SECTION_ICON_SIZE = 18;

/** The multi-select toolbar's icons, in the header's line style. */
export const sectionToolbarIcon: SelectionToolbarIcon = (name) => {
  if (name === 'check_circle') return createCircleCheckIcon(SECTION_ICON_SIZE);
  return name === 'delete' ? createTrashIcon(SECTION_ICON_SIZE) : createXIcon(SECTION_ICON_SIZE);
};

/**
 * Gemini's folder sidebar drawn in ChatGPT's line-icon style: chevrons, tinted
 * folder icons, a menu button on each folder, and the same drags.
 */
const SITE: TreeSiteOptions = {
  lineIcons: true,
  folderMenuButton: { labelKey: 'folder_settings' },
  folderBodyDrop: true,
  folderDrag: true,
  conversationHref: (conversation) => readChatGptConversation(conversation.url)?.url ?? '',
  folderToggleDelayMs: FOLDER_TOGGLE_DELAY_MS,
};

export type ChatGptFolderSectionOptions = {
  data: FolderData;
  rootBucketId: string;
  actions: TreeActions;
  /** Buttons between the sort toggle and "Create folder", shown while the header is in use. */
  headerActions?: readonly FolderHeaderAction[];
  prefs: ChatGptFolderSectionPrefs;
  /** The section was collapsed or its conversation order changed. */
  onPrefsChange: (prefs: ChatGptFolderSectionPrefs) => void;
  /** Long-press multi-select: its toolbar, shown atop the tree, and the rows it holds. */
  selection?: {
    toolbar: HTMLElement;
    isConversationSelected: NonNullable<TreeSiteOptions['isConversationSelected']>;
  };
};

export class ChatGptFolderSection {
  readonly element: HTMLElement;
  /** The header row with the section's title: what the one-time guide points at. */
  readonly header: HTMLElement;
  /** Holds the multi-select toolbar and carries the mode class while selecting. */
  readonly selectionBar: HTMLElement;
  private readonly surface: ShadowSurface;
  private readonly body: HTMLElement;
  /** The search box and the tree, hidden while the section is collapsed. */
  private readonly content: HTMLElement;
  private readonly search: FolderSearchBox;
  private readonly tree: FolderTreeController;
  private readonly onPrefsChange: (prefs: ChatGptFolderSectionPrefs) => void;
  private readonly isConversationSelected: TreeSiteOptions['isConversationSelected'];
  private activeConversationId: string | null = null;
  private data: FolderData;
  private prefs: ChatGptFolderSectionPrefs;
  private searchQuery = '';
  private searchHintSeen = false;
  private filter: TreeSiteOptions['filter'];
  private pointerInside = false;
  /** `data` holds open times the tree has not laid out yet. */
  private layoutHeld = false;

  constructor({
    data,
    rootBucketId,
    actions,
    headerActions = [],
    prefs,
    onPrefsChange,
    selection,
  }: ChatGptFolderSectionOptions) {
    this.data = data;
    this.isConversationSelected = selection?.isConversationSelected;
    this.prefs = { ...prefs };
    this.onPrefsChange = onPrefsChange;
    this.element = document.createElement('div');
    this.element.className = FOLDER_SECTION_CLASS;
    this.element.setAttribute('role', 'region');
    this.element.setAttribute('aria-label', t('floatingPanelTitle'));
    this.element.addEventListener('pointerenter', () => (this.pointerInside = true));
    this.element.addEventListener('pointerleave', () => {
      this.pointerInside = false;
      if (this.layoutHeld) this.update(this.data);
    });

    // ChatGPT's own sections collapse from their heading; its name stays the button's name.
    const header = createFolderHeader({
      className: `${FOLDER_SECTION_CLASS}__header`,
      title: {
        tag: 'h2',
        labelKey: 'floatingPanelTitle',
        className: `${FOLDER_SECTION_CLASS}__title`,
      },
      collapse: {
        byTitle: true,
        onToggle: () => this.setPrefs({ collapsed: !this.prefs.collapsed }),
      },
      containClicks: true,
      actions: [
        {
          className: SORT_TOGGLE_CLASS,
          icon: () => createClockArrowDownIcon(SECTION_ICON_SIZE),
          reveal: true,
          pressed: this.prefs.sortMode === 'recent',
          onClick: () =>
            this.setPrefs({ sortMode: this.prefs.sortMode === 'recent' ? 'manual' : 'recent' }),
        },
        ...headerActions.map((action) => ({ ...action, reveal: true })),
        {
          className: `${FOLDER_SECTION_CLASS}__create`,
          primary: true,
          icon: () => createPlusIcon(SECTION_ICON_SIZE),
          labelKey: 'floatingPanelCreateFolder',
          onClick: () => {
            if (this.prefs.collapsed) this.setPrefs({ collapsed: false });
            this.tree.apply({
              inlineEditor: { mode: 'create', parentId: null },
              contextMenu: null,
            });
          },
        },
      ],
    });
    this.header = header;

    this.search = createFolderSearch({
      query: () => this.searchQuery,
      setQuery: (query) => (this.searchQuery = query),
      folderOnly: () => this.searchCriteria()?.mode === 'folder',
      hintSeen: () => this.searchHintSeen,
      markHintSeen: () => (this.searchHintSeen = true),
      onSearch: () => this.applySearch(),
    });
    void hasSeenCoachmark(FOLDER_ONLY_SEARCH_HINT_ID).then((seen) => {
      this.searchHintSeen ||= seen;
      this.search.refreshLanguage();
    });

    this.body = document.createElement('div');
    this.body.className = `${FLOATING_PANEL_CLASS}__body`;
    this.content = document.createElement('div');
    this.content.className = `${FOLDER_SECTION_CLASS}__content`;
    this.selectionBar = document.createElement('div');
    this.selectionBar.className = `${FOLDER_SECTION_CLASS}__selection`;
    if (selection) this.selectionBar.append(selection.toolbar);
    this.content.append(this.search.element, this.selectionBar, this.body);

    const css = `${panelCss}\n${FOLDER_HEADER_CSS}\n${sectionCss}`;
    this.surface = attachShadowSurface(this.element, css);
    this.surface.root.append(header, this.content);

    // The sidebar scrolls and clips, so the folder menu renders in a body-level layer.
    this.tree = mountFolderTree({
      body: this.body,
      boundary: this.element,
      focusRoot: this.surface.root,
      data,
      rootBucketId,
      conversationSortMode: this.prefs.sortMode,
      actions: actions.onRenameConversation
        ? {
            ...actions,
            onConversationMenu: (e, conversation) =>
              this.tree.apply({
                inlineEditor: null,
                contextMenu: { conversation, x: e.clientX, y: e.clientY },
              }),
          }
        : actions,
      site: this.site(),
      popoverLayer: { css },
    });
    this.showPrefs();
  }

  /** The conversation order the tree shows, for drops that place by position. */
  get sortMode(): ConversationSortMode {
    return this.prefs.sortMode;
  }

  /**
   * Puts the section just before Recents in `sidebar`, unless it is already
   * there. Drops copies ChatGPT may have cloned along with its own nodes.
   */
  place(sidebar: HTMLElement | null): void {
    if (!sidebar) return;
    for (const copy of sidebar.querySelectorAll(`.${FOLDER_SECTION_CLASS}`)) {
      if (copy !== this.element) copy.remove();
    }
    const anchor = findHistoryAnchor(sidebar);
    const parent = anchor?.parentElement;
    if (!anchor || !parent) {
      this.element.remove();
      return;
    }
    if (this.element.parentElement === parent && this.element.nextElementSibling === anchor) {
      // Reinserting here would wake our sidebar watcher forever.
      return;
    }
    parent.insertBefore(this.element, anchor);
  }

  update(data: FolderData): void {
    this.data = data;
    this.layoutHeld = false;
    this.tree.update(data);
  }

  /**
   * New data in which only open times changed. While the pointer is over the
   * section the rows stay put: opening a chat on a double-click's first click
   * would otherwise move another chat under its second. The recent order
   * catches up once the pointer leaves, as Gemini's does on its next render.
   */
  updateOpened(data: FolderData): void {
    if (!this.pointerInside) {
      this.update(data);
      return;
    }
    this.data = data;
    this.layoutHeld = true;
  }

  /** Marks the rows of the conversation the page has open (its stored id), or none. */
  setActiveConversation(conversationId: string | null): void {
    if (conversationId === this.activeConversationId) return;
    this.activeConversationId = conversationId;
    this.tree.setSite(this.site());
  }

  /** The selection changed: rows show whether they are selected again. */
  refreshSelection(): void {
    this.tree.setSite(this.site());
  }

  setDataReady(ready: boolean): void {
    this.body.inert = !ready;
    this.body.setAttribute('aria-busy', String(!ready));
    setFolderHeaderDisabled(this.header, !ready);
    // The sort toggle only reorders what is shown, so it works while data loads.
    this.header.querySelector<HTMLButtonElement>(`.${SORT_TOGGLE_CLASS}`)!.disabled = false;
  }

  /** True while the section's own folder menu or name field is open. */
  get busy(): boolean {
    return this.tree.busy();
  }

  /** The folder drop target under a viewport point, for a drag driven by pointer events. */
  dropTargetAt(x: number, y: number): FolderDropTarget | null {
    return folderDropTargetAt(this.surface.root, x, y);
  }

  destroy(): void {
    closeFolderHeaderMenu();
    this.search.cancel();
    this.tree.destroy();
    this.surface.disconnect();
    this.element.remove();
  }

  private site(): TreeSiteOptions {
    return {
      ...SITE,
      ...searchAndSortOptions(this.searchCriteria() !== null, this.prefs.sortMode),
      filter: this.filter,
      activeConversationId: this.activeConversationId,
      isConversationSelected: this.isConversationSelected,
    };
  }

  private searchCriteria(): FolderSearchCriteria | null {
    return searchCriteriaOf(this.searchQuery);
  }

  /** Filters the tree by the search box once typing pauses. */
  private applySearch(): void {
    const search = this.searchCriteria();
    this.filter = search
      ? createSidebarFilter({ search, currentUserOnly: false }, () => this.data)
      : undefined;
    this.tree.setSite(this.site());
  }

  private setPrefs(change: Partial<ChatGptFolderSectionPrefs>): void {
    const sortChanged = change.sortMode !== undefined && change.sortMode !== this.prefs.sortMode;
    this.prefs = { ...this.prefs, ...change };
    this.showPrefs();
    if (sortChanged) {
      this.layoutHeld = false;
      this.tree.setSite(this.site());
      this.tree.update(this.data, this.prefs.sortMode);
    }
    this.onPrefsChange({ ...this.prefs });
  }

  private showPrefs(): void {
    const { collapsed, sortMode } = this.prefs;
    this.content.hidden = collapsed;
    setFolderHeaderCollapsed(this.header, collapsed);
    const recent = sortMode === 'recent';
    setFolderHeaderAction(this.header, SORT_TOGGLE_CLASS, {
      pressed: recent,
      label: t('folder_sort_recent'),
      title: `${t('folder_sort')}: ${t(recent ? 'folder_sort_recent' : 'folder_sort_manual')}`,
    });
  }
}
