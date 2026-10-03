import {
  createChevronDownIcon,
  createChevronRightIcon,
  createClockArrowDownIcon,
  createPlusIcon,
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

/** Header icons, at the size of Gemini's folder header icons. */
export const SECTION_ICON_SIZE = 18;

/** How long a `flash` message stays, as in the floating panel. */
const STATUS_MS = 4000;

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

/** A header button beside "Create folder", shown while the header is hovered or focused. */
export type SectionHeaderAction = {
  modifier: string;
  labelKey: string;
  icon: () => SVGElement;
  onClick: () => void;
};

export type ChatGptFolderSectionOptions = {
  data: FolderData;
  rootBucketId: string;
  actions: TreeActions;
  headerActions?: readonly SectionHeaderAction[];
  prefs?: ChatGptFolderSectionPrefs;
  /** The section was collapsed or its conversation order changed. */
  onPrefsChange?: (prefs: ChatGptFolderSectionPrefs) => void;
};

function headerButton(modifier: string, labelKey: string, icon: SVGElement): HTMLButtonElement {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = `${FLOATING_PANEL_CLASS}__icon-button ${FLOATING_PANEL_CLASS}__icon-button--${modifier}`;
  button.setAttribute('aria-label', t(labelKey));
  button.title = t(labelKey);
  button.append(icon);
  return button;
}

export class ChatGptFolderSection {
  readonly element: HTMLElement;
  /** The header row with the section's title: what the one-time guide points at. */
  readonly header: HTMLElement;
  private readonly surface: ShadowSurface;
  private readonly body: HTMLElement;
  /** The search box and the tree, hidden while the section is collapsed. */
  private readonly content: HTMLElement;
  private readonly collapseToggle: HTMLButtonElement;
  private readonly sortToggle: HTMLButtonElement;
  private readonly search: FolderSearchBox;
  private readonly headerButtons: HTMLButtonElement[];
  private readonly status: HTMLElement;
  private readonly tree: FolderTreeController;
  private readonly onPrefsChange: (prefs: ChatGptFolderSectionPrefs) => void;
  private statusTimer: ReturnType<typeof setTimeout> | null = null;
  private activeConversationId: string | null = null;
  private data: FolderData;
  private prefs: ChatGptFolderSectionPrefs;
  private searchQuery = '';
  private searchHintSeen = false;
  private filter: TreeSiteOptions['filter'];

  constructor({
    data,
    rootBucketId,
    actions,
    headerActions = [],
    prefs = { collapsed: false, sortMode: 'manual' },
    onPrefsChange = () => {},
  }: ChatGptFolderSectionOptions) {
    this.data = data;
    this.prefs = { ...prefs };
    this.onPrefsChange = onPrefsChange;
    this.element = document.createElement('div');
    this.element.className = FOLDER_SECTION_CLASS;
    this.element.setAttribute('role', 'region');
    this.element.setAttribute('aria-label', t('floatingPanelTitle'));

    const header = document.createElement('div');
    this.header = header;
    header.className = `${FOLDER_SECTION_CLASS}__header`;
    const title = document.createElement('h2');
    title.className = `${FOLDER_SECTION_CLASS}__title`;
    // ChatGPT's own sections collapse from their heading; its name stays the button's name.
    this.collapseToggle = document.createElement('button');
    this.collapseToggle.type = 'button';
    this.collapseToggle.className = `${FOLDER_SECTION_CLASS}__toggle`;
    this.collapseToggle.addEventListener('click', (event) => {
      event.stopPropagation();
      this.setPrefs({ collapsed: !this.prefs.collapsed });
    });
    title.append(this.collapseToggle);
    const toolbar = document.createElement('div');
    toolbar.className = `${FOLDER_SECTION_CLASS}__actions`;
    this.sortToggle = headerButton(
      'sort',
      'folder_sort_recent',
      createClockArrowDownIcon(SECTION_ICON_SIZE),
    );
    this.sortToggle.classList.add(`${FOLDER_SECTION_CLASS}__reveal`);
    this.sortToggle.addEventListener('click', (event) => {
      event.stopPropagation();
      this.setPrefs({ sortMode: this.prefs.sortMode === 'recent' ? 'manual' : 'recent' });
    });
    this.headerButtons = headerActions.map((action) => {
      const button = headerButton(action.modifier, action.labelKey, action.icon());
      button.classList.add(`${FOLDER_SECTION_CLASS}__reveal`);
      button.addEventListener('click', (event) => {
        event.stopPropagation();
        action.onClick();
      });
      return button;
    });
    const createButton = headerButton(
      'create',
      'floatingPanelCreateFolder',
      createPlusIcon(SECTION_ICON_SIZE),
    );
    createButton.addEventListener('click', (event) => {
      event.stopPropagation();
      if (this.prefs.collapsed) this.setPrefs({ collapsed: false });
      this.tree.apply({ inlineEditor: { mode: 'create', parentId: null }, contextMenu: null });
    });
    this.headerButtons.push(createButton);
    toolbar.append(this.sortToggle, ...this.headerButtons);
    header.append(title, toolbar);

    this.status = document.createElement('div');
    this.status.className = `${FLOATING_PANEL_CLASS}__status`;
    this.status.setAttribute('role', 'status');
    this.status.hidden = true;

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
    this.content.append(this.search.element, this.body);

    const css = `${panelCss}\n${sectionCss}`;
    this.surface = attachShadowSurface(this.element, css);
    this.surface.root.append(header, this.status, this.content);

    // The sidebar scrolls and clips, so the folder menu renders in a body-level layer.
    this.tree = mountFolderTree({
      body: this.body,
      boundary: this.element,
      focusRoot: this.surface.root,
      data,
      rootBucketId,
      conversationSortMode: this.prefs.sortMode,
      actions,
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
    this.tree.update(data);
  }

  /** Marks the rows of the conversation the page has open (its stored id), or none. */
  setActiveConversation(conversationId: string | null): void {
    if (conversationId === this.activeConversationId) return;
    this.activeConversationId = conversationId;
    this.tree.setSite(this.site());
  }

  setDataReady(ready: boolean): void {
    this.body.inert = !ready;
    this.body.setAttribute('aria-busy', String(!ready));
    for (const button of this.headerButtons) button.disabled = !ready;
  }

  /** True while the section's own folder menu or name field is open. */
  get busy(): boolean {
    return this.tree.busy();
  }

  /** The folder drop target under a viewport point, for a drag driven by pointer events. */
  dropTargetAt(x: number, y: number): FolderDropTarget | null {
    return folderDropTargetAt(this.surface.root, x, y);
  }

  /** Shows `message` under the header until the next one or a few seconds pass. */
  flash(message: string): void {
    this.clearStatus();
    this.status.textContent = message;
    this.status.hidden = false;
    this.statusTimer = setTimeout(() => this.clearStatus(), STATUS_MS);
  }

  destroy(): void {
    this.clearStatus();
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
      this.tree.setSite(this.site());
      this.tree.update(this.data, this.prefs.sortMode);
    }
    this.onPrefsChange({ ...this.prefs });
  }

  private showPrefs(): void {
    const { collapsed, sortMode } = this.prefs;
    this.content.hidden = collapsed;
    const toggle = this.collapseToggle;
    toggle.setAttribute('aria-expanded', String(!collapsed));
    toggle.title = t(collapsed ? 'pm_expand' : 'pm_collapse');
    const label = document.createElement('span');
    label.textContent = t('floatingPanelTitle');
    toggle.replaceChildren(
      label,
      collapsed ? createChevronRightIcon(16) : createChevronDownIcon(16),
    );
    const recent = sortMode === 'recent';
    this.sortToggle.setAttribute('aria-pressed', String(recent));
    this.sortToggle.title = `${t('folder_sort')}: ${t(recent ? 'folder_sort_recent' : 'folder_sort_manual')}`;
  }

  private clearStatus(): void {
    if (this.statusTimer) clearTimeout(this.statusTimer);
    this.statusTimer = null;
    this.status.hidden = true;
    this.status.textContent = '';
  }
}
