import { createBellIcon } from '@/core/icons/bellIcon';
import {
  createFolderIcon,
  createPlusIcon,
  createSettingsIcon,
  createUserRoundIcon,
} from '@/core/icons/folderIcons';
import { getTranslationSyncUnsafe as t } from '@/utils/i18n';

import type { FolderTransferController } from './FolderTransferController';
import { KEEPS_INLINE_FORM_ATTR } from './floatingTree/shared';
import {
  cloudMenuAction,
  createFolderHeader,
  ensureFolderHeaderStyle,
  refreshFolderHeaderLanguage,
  setFolderHeaderAction,
  setFolderHeaderCollapsed,
} from './folderHeader/folderHeader';
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

/**
 * Gemini's folder section title row on the shared folder header: collapse,
 * activity, filter, import/export, cloud, settings, add.
 */
export function createSidebarHeader(options: SidebarHeaderOptions): HTMLElement {
  const { headerMenus, transfer } = options;
  ensureFolderHeaderStyle();
  const header = createFolderHeader({
    // Match the style of Recent section title
    title: { tag: 'h1', labelKey: 'folder_title', className: 'gds-label-l' },
    collapse: { onToggle: options.onToggleCollapsed },
    openMenu: (event, _anchor, items) => headerMenus.openActions(event, items),
    actions: [
      // Activity is a read-only projection over the same folder data. The bell
      // occupies the old section-hider eye slot while the left chevron remains
      // the single collapse control.
      {
        className: 'gv-folder-activity-toggle',
        icon: () => createBellIcon(18),
        onClick: (event) => {
          event.stopPropagation();
          options.onToggleViewMode();
        },
      },
      {
        className: 'gv-folder-user-filter-toggle',
        icon: () => createUserRoundIcon(18),
        labelKey: 'folder_filter_current_user',
        pressed: options.filterCurrentUserOnly,
        hidden: options.accountIsolationEnabled,
        onClick: () => options.onToggleUserFilter(),
      },
      {
        className: 'gv-folder-import-export-btn',
        icon: () => createFolderIcon(18),
        labelKey: 'folder_import_export',
        menu: () => [
          { label: t('folder_import'), icon: 'upload', action: () => transfer.showImportDialog() },
          { label: t('folder_export'), icon: 'download', action: () => transfer.exportFolders() },
        ],
      },
      cloudMenuAction({
        upload: () => void transfer.upload(),
        sync: () => void transfer.sync(),
      }),
      // Folder settings (conversation order, font size, spacing, and indentation).
      {
        className: 'gv-folder-settings-btn',
        icon: () => createSettingsIcon(18),
        labelKey: 'folder_settings',
        onClick: (event) => options.onOpenSettings(event),
      },
      {
        className: 'gv-folder-add-btn',
        primary: true,
        icon: () => createPlusIcon(18),
        labelKey: 'folder_create',
        // A second press refocuses the open name field, so it must not dismiss it first.
        attributes: { [KEEPS_INLINE_FORM_ATTR]: '' },
        onClick: () => options.onCreateFolder(),
      },
    ],
  });
  header.querySelector<HTMLElement>('.title')!.style.visibility = 'visible';
  header
    .querySelector('.gv-folder-user-filter-toggle')
    ?.classList.toggle('gv-filter-active', options.filterCurrentUserOnly);
  return header;
}

export function applyCollapsedState(panel: HTMLElement, collapsed: boolean): void {
  panel.classList.toggle('gv-folder-collapsed', collapsed);
  setFolderHeaderCollapsed(panel, collapsed);
}

export function applyViewModeState(panel: HTMLElement, activityMode: boolean): void {
  panel.classList.toggle('gv-folder-activity-mode', activityMode);
  setFolderHeaderAction(panel, 'gv-folder-activity-toggle', {
    pressed: activityMode,
    label: t(activityMode ? 'folder_activity_turn_off' : 'folder_activity_turn_on'),
  })?.classList.toggle('is-active', activityMode);
}

export function applyUserFilterButtonState(
  panel: HTMLElement | null,
  active: boolean,
  accountIsolationEnabled: boolean,
): void {
  if (!panel) return;
  setFolderHeaderAction(panel, 'gv-folder-user-filter-toggle', {
    pressed: active,
    hidden: accountIsolationEnabled,
  })?.classList.toggle('gv-filter-active', active);
}

/** Retranslates the title and button labels; state-dependent labels are the caller's. */
export function refreshHeaderLanguage(panel: HTMLElement): void {
  refreshFolderHeaderLanguage(panel);
}
