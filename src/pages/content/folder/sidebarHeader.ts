import { createBellIcon } from '@/core/icons/bellIcon';
import { CLOUD_SYNC_PATH, CLOUD_UPLOAD_PATH } from '@/core/icons/cloudSyncPaths';
import {
  createChevronDownIcon,
  createChevronRightIcon,
  createCloudIcon,
  createFolderIcon,
  createPlusIcon,
  createSettingsIcon,
  createUserRoundIcon,
} from '@/core/icons/folderIcons';
import { isSafari } from '@/core/utils/browser';
import { getTranslationSyncUnsafe as t } from '@/utils/i18n';

import type { FolderTransferController } from './FolderTransferController';
import type { createFolderHeaderMenus } from './headerMenus';

export type SidebarHeaderOptions = {
  headerMenus: ReturnType<typeof createFolderHeaderMenus>;
  transfer: FolderTransferController;
  filterCurrentUserOnly: boolean;
  accountIsolationEnabled: boolean;
  onToggleCollapsed(): void;
  onToggleViewMode(): void;
  onToggleUserFilter(): void;
  onOpenSettings(event: MouseEvent): void;
  onCreateFolder(): void;
};

function actionButton(className: string, icon: SVGElement, labelKey?: string): HTMLButtonElement {
  const button = document.createElement('button');
  button.className = className;
  button.type = 'button';
  button.replaceChildren(icon);
  if (labelKey) {
    button.title = t(labelKey);
    button.setAttribute('aria-label', t(labelKey));
  }
  return button;
}

function cloudMenuIcon(path: string): string {
  return `<svg xmlns="http://www.w3.org/2000/svg" height="20px" viewBox="0 -960 960 960" width="20px" fill="currentColor"><path d="${path}"/></svg>`;
}

function createTitle(options: SidebarHeaderOptions): HTMLElement {
  // Match the style of Recent section title
  const titleContainer = document.createElement('div');
  titleContainer.className = 'title-container';

  const title = document.createElement('h1');
  title.className = 'title gds-label-l';
  title.textContent = t('folder_title');
  title.style.visibility = 'visible';

  const collapseButton = document.createElement('button');
  collapseButton.className = 'gv-folder-section-toggle';
  collapseButton.type = 'button';
  collapseButton.addEventListener('click', (e) => {
    e.stopPropagation();
    e.preventDefault();
    options.onToggleCollapsed();
  });
  collapseButton.replaceChildren(createChevronDownIcon(16));

  titleContainer.append(title, collapseButton);
  return titleContainer;
}

function createActions(options: SidebarHeaderOptions): HTMLElement {
  const { headerMenus, transfer } = options;
  const actions = document.createElement('div');
  actions.className = 'gv-folder-header-actions';

  // Activity is a read-only projection over the same folder data. The bell
  // occupies the old section-hider eye slot while the left chevron remains
  // the single collapse control.
  const activity = actionButton(
    'gv-folder-action-btn gv-folder-activity-toggle',
    createBellIcon(18),
  );
  activity.addEventListener('click', (event) => {
    event.stopPropagation();
    options.onToggleViewMode();
  });

  const filterUser = actionButton(
    'gv-folder-action-btn gv-folder-user-filter-toggle',
    createUserRoundIcon(18),
    'folder_filter_current_user',
  );
  filterUser.setAttribute('aria-pressed', String(options.filterCurrentUserOnly));
  filterUser.hidden = options.accountIsolationEnabled;
  filterUser.classList.toggle('gv-filter-active', options.filterCurrentUserOnly);
  filterUser.addEventListener('click', () => options.onToggleUserFilter());

  const importExport = actionButton(
    'gv-folder-action-btn gv-folder-import-export-btn',
    createFolderIcon(18),
    'folder_import_export',
  );
  importExport.addEventListener('click', (event) => {
    headerMenus.openActions(event, [
      { label: t('folder_import'), icon: 'upload', action: () => transfer.showImportDialog() },
      { label: t('folder_export'), icon: 'download', action: () => transfer.exportFolders() },
    ]);
  });
  actions.append(activity, filterUser, importExport);

  // Cloud popover (single button → menu with Upload + Sync). Skipped on Safari.
  if (!isSafari()) {
    const cloud = actionButton(
      'gv-folder-action-btn gv-folder-cloud-btn',
      createCloudIcon(18),
      'folder_cloud',
    );
    cloud.addEventListener('click', (event) => {
      // Gemini's bundled symbol font lacks these cloud glyphs.
      headerMenus.openActions(event, [
        {
          label: t('folder_cloud_upload'),
          iconHtml: cloudMenuIcon(CLOUD_UPLOAD_PATH),
          action: () => void transfer.upload(),
        },
        {
          label: t('folder_cloud_sync'),
          iconHtml: cloudMenuIcon(CLOUD_SYNC_PATH),
          action: () => void transfer.sync(),
        },
      ]);
    });
    actions.appendChild(cloud);
  }

  // Folder settings (conversation order, font size, spacing, and indentation).
  const settings = actionButton(
    'gv-folder-action-btn gv-folder-settings-btn',
    createSettingsIcon(18),
    'folder_settings',
  );
  settings.addEventListener('click', (event) => options.onOpenSettings(event));

  const add = actionButton('gv-folder-add-btn', createPlusIcon(18), 'folder_create');
  add.addEventListener('click', () => options.onCreateFolder());

  actions.append(settings, add);
  return actions;
}

/** The folder section's title row: collapse, activity, filter, transfer, settings, add. */
export function createSidebarHeader(options: SidebarHeaderOptions): HTMLElement {
  const header = document.createElement('div');
  header.className = 'gv-folder-header';
  header.append(createTitle(options), createActions(options));
  return header;
}

export function applyCollapsedState(panel: HTMLElement, collapsed: boolean): void {
  panel.classList.toggle('gv-folder-collapsed', collapsed);
  const button = panel.querySelector<HTMLButtonElement>('.gv-folder-section-toggle');
  if (!button) return;

  const label = t(collapsed ? 'pm_expand' : 'pm_collapse');
  button.title = label;
  button.setAttribute('aria-label', label);
  button.setAttribute('aria-expanded', String(!collapsed));
  button.replaceChildren(collapsed ? createChevronRightIcon(16) : createChevronDownIcon(16));
}

export function applyViewModeState(panel: HTMLElement, activityMode: boolean): void {
  panel.classList.toggle('gv-folder-activity-mode', activityMode);
  const button = panel.querySelector<HTMLButtonElement>('.gv-folder-activity-toggle');
  if (!button) return;

  const label = t(activityMode ? 'folder_activity_turn_off' : 'folder_activity_turn_on');
  button.title = label;
  button.setAttribute('aria-label', label);
  button.setAttribute('aria-pressed', String(activityMode));
  button.classList.toggle('is-active', activityMode);
}

export function applyUserFilterButtonState(
  panel: HTMLElement | null,
  active: boolean,
  accountIsolationEnabled: boolean,
): void {
  const button = panel?.querySelector<HTMLButtonElement>('.gv-folder-user-filter-toggle');
  if (!button) return;
  button.hidden = accountIsolationEnabled;
  button.classList.toggle('gv-filter-active', active);
  button.setAttribute('aria-pressed', String(active));
}

const HEADER_BUTTON_LABELS: ReadonlyArray<[string, string]> = [
  ['gv-folder-add-btn', 'folder_create'],
  ['gv-folder-user-filter-toggle', 'folder_filter_current_user'],
  ['gv-folder-import-export-btn', 'folder_import_export'],
  ['gv-folder-cloud-btn', 'folder_cloud'],
  ['gv-folder-settings-btn', 'folder_settings'],
];

/** Retranslates the title and button labels; state-dependent labels are the caller's. */
export function refreshHeaderLanguage(panel: HTMLElement): void {
  const title = panel.querySelector('.gv-folder-header .title');
  if (title) title.textContent = t('folder_title');
  panel.querySelectorAll('.gv-folder-header-actions button').forEach((button) => {
    const entry = HEADER_BUTTON_LABELS.find(([className]) => button.classList.contains(className));
    if (!entry) return;
    const label = t(entry[1]);
    (button as HTMLButtonElement).title = label;
    button.setAttribute('aria-label', label);
  });
}
