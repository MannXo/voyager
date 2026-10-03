import { createPlusIcon } from '@/core/icons/folderIcons';
/**
 * The folder tree as a section of ChatGPT's own sidebar, just above Recents. It
 * reuses the floating panel's tree and sheet inside its own shadow host. ChatGPT
 * (React) may drop it on any re-render or remount the whole sidebar; `place`
 * puts it back and is called after every sidebar change. While the sidebar or
 * Recents is missing it stays out of the page and the plugin offers the
 * floating panel's button instead.
 */
import type { FolderData } from '@/core/types/folder';
import panelCss from '@/pages/content/folder/floatingPanel.css?raw';
import { renderFolderTree } from '@/pages/content/folder/floatingTree/FolderTree';
import {
  type FolderDropTarget,
  folderDropTargetAt,
} from '@/pages/content/folder/floatingTree/dropTargets';
import {
  type ContextMenuState,
  FLOATING_PANEL_CLASS,
  type InlineEditorState,
  type TreeActions,
  type TreeChange,
  type TreeSiteOptions,
} from '@/pages/content/folder/floatingTree/shared';
import {
  type ShadowSurface,
  attachShadowSurface,
  eventPassedThrough,
} from '@/pages/content/folder/shadowHost';
import type { Folder } from '@/pages/content/folder/types';
import { getTranslationSyncUnsafe as t } from '@/utils/i18n';

import sectionCss from './chatgptFolderSection.css?raw';
import { findHistoryAnchor } from './chatgptSidebarDom';

export const FOLDER_SECTION_CLASS = 'gv-chatgpt-folder-section';

/** Header icons, at the size of Gemini's folder header icons. */
export const SECTION_ICON_SIZE = 18;

/** How long a `flash` message stays, as in the floating panel. */
const STATUS_MS = 4000;

/**
 * Gemini's folder vocabulary drawn in ChatGPT's line-icon style: chevrons,
 * tinted folder icons, and a menu button on each folder.
 */
const SITE: TreeSiteOptions = {
  lineIcons: true,
  folderMenuButton: { labelKey: 'folder_settings' },
};

/** A header button beside "Create folder", shown while the header is hovered or focused. */
export type SectionHeaderAction = {
  modifier: string;
  labelKey: string;
  icon: () => SVGElement;
  onClick: () => void;
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
  private readonly headerButtons: HTMLButtonElement[];
  private readonly status: HTMLElement;
  private statusTimer: ReturnType<typeof setTimeout> | null = null;
  private inlineEditor: InlineEditorState | null = null;
  private contextMenu: ContextMenuState | null = null;

  constructor(
    private data: FolderData,
    private readonly rootBucketId: string,
    private readonly actions: TreeActions,
    headerActions: readonly SectionHeaderAction[] = [],
  ) {
    this.element = document.createElement('div');
    this.element.className = FOLDER_SECTION_CLASS;
    this.element.setAttribute('role', 'region');
    this.element.setAttribute('aria-label', t('floatingPanelTitle'));

    const header = document.createElement('div');
    this.header = header;
    header.className = `${FOLDER_SECTION_CLASS}__header`;
    const title = document.createElement('h2');
    title.className = `${FOLDER_SECTION_CLASS}__title`;
    title.textContent = t('floatingPanelTitle');
    const toolbar = document.createElement('div');
    toolbar.className = `${FOLDER_SECTION_CLASS}__actions`;
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
      this.apply({ inlineEditor: { mode: 'create', parentId: null }, contextMenu: null });
    });
    this.headerButtons.push(createButton);
    toolbar.append(...this.headerButtons);
    header.append(title, toolbar);

    this.body = document.createElement('div');
    this.body.className = `${FLOATING_PANEL_CLASS}__body`;

    this.status = document.createElement('div');
    this.status.className = `${FLOATING_PANEL_CLASS}__status`;
    this.status.setAttribute('role', 'status');
    this.status.hidden = true;

    this.surface = attachShadowSurface(this.element, `${panelCss}\n${sectionCss}`);
    this.surface.root.append(header, this.status, this.body);

    document.addEventListener('click', this.closeMenuOutside);
    this.render();
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
    if (this.inlineEditor?.mode === 'rename') {
      const folderId = this.inlineEditor.folderId;
      if (!data.folders.some((folder) => folder.id === folderId)) this.inlineEditor = null;
    }
    const menu = this.contextMenu;
    if (menu && !data.folders.some((folder) => folder.id === menu.folderId)) {
      this.contextMenu = null;
    }
    // Rebuilding the tree under an open inline form would empty it; every way out
    // of the form renders again and picks up this data.
    if (this.inlineEditor && this.isTyping()) return;
    this.render();
  }

  setDataReady(ready: boolean): void {
    this.body.inert = !ready;
    this.body.setAttribute('aria-busy', String(!ready));
    for (const button of this.headerButtons) button.disabled = !ready;
  }

  /** True while the section's own folder menu or name field is open. */
  get busy(): boolean {
    return this.contextMenu !== null || this.inlineEditor !== null;
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
    document.removeEventListener('click', this.closeMenuOutside);
    renderFolderTree(this.body, null);
    this.surface.disconnect();
    this.element.remove();
  }

  private clearStatus(): void {
    if (this.statusTimer) clearTimeout(this.statusTimer);
    this.statusTimer = null;
    this.status.hidden = true;
    this.status.textContent = '';
  }

  private isTyping(): boolean {
    return !!this.surface.root.activeElement?.classList.contains(
      `${FLOATING_PANEL_CLASS}__inline-input`,
    );
  }

  private readonly closeMenuOutside = (event: MouseEvent): void => {
    if (this.contextMenu && !eventPassedThrough(event, this.element)) {
      this.apply({ contextMenu: null });
    }
  };

  private readonly isExpanded = (folder: Folder): boolean => folder.isExpanded;

  private readonly apply = (change: TreeChange, effect?: () => void): void => {
    if (change.inlineEditor !== undefined) this.inlineEditor = change.inlineEditor;
    if (change.contextMenu !== undefined) this.contextMenu = change.contextMenu;
    if (change.expand) {
      const { folderId, expanded } = change.expand;
      const folder = this.data.folders.find((candidate) => candidate.id === folderId);
      if (folder && folder.isExpanded !== expanded) this.actions.onToggleFolderExpanded?.(folderId);
    }
    effect?.();
    this.render();
  };

  private render(): void {
    renderFolderTree(this.body, {
      data: this.data,
      rootBucketId: this.rootBucketId,
      conversationSortMode: 'manual',
      actions: this.actions,
      inlineEditor: this.inlineEditor,
      contextMenu: this.contextMenu,
      isExpanded: this.isExpanded,
      apply: this.apply,
      site: SITE,
    });
  }
}
