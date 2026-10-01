/** @jsxImportSource preact */
import { getFolderDepth } from '@/features/folder/model/folderData';

import { FOLDER_COLORS, getFolderColor, isDarkMode } from '../folderColors';
import { type TreeProps, canCreateChildAtDepth, cls, t } from './shared';

type MenuButtonProps = {
  labelKey: string;
  extraClass?: string;
  onClick: (e: MouseEvent) => void;
};

function MenuButton({ labelKey, extraClass, onClick }: MenuButtonProps) {
  const classes = extraClass ? `${cls('menu-item')} ${extraClass}` : cls('menu-item');
  return (
    <button type="button" class={classes} onClick={onClick}>
      {t(labelKey)}
    </button>
  );
}

const DANGER = cls('menu-item--danger');
const CONFIRM_BUTTON = cls('confirm-button');

/** Right-click menu for one folder: pin, subfolder, rename, color, delete. */
export function ContextMenu({ data, contextMenu, actions, apply }: TreeProps) {
  if (!contextMenu) return null;
  const folder = data.folders.find((candidate) => candidate.id === contextMenu.folderId);
  if (!folder) return null;

  const position = { left: `${contextMenu.x}px`, top: `${contextMenu.y}px` };

  if (contextMenu.confirmingDelete) {
    return (
      <div
        class={`${cls('context-menu')} ${cls('context-menu--confirming')}`}
        style={position}
        role="menu"
      >
        <div class={cls('confirm-inline')}>
          <div class={cls('confirm-actions')}>
            <MenuButton
              labelKey="floatingPanelDeleteFolder"
              extraClass={`${DANGER} ${CONFIRM_BUTTON}`}
              onClick={(e) => {
                e.stopPropagation();
                apply({ contextMenu: null }, () => actions.onDeleteFolder?.(folder.id));
              }}
            />
            <MenuButton
              labelKey="floatingPanelCancel"
              extraClass={CONFIRM_BUTTON}
              onClick={(e) => {
                e.stopPropagation();
                apply({ contextMenu: null });
              }}
            />
          </div>
        </div>
      </div>
    );
  }

  const dark = isDarkMode();
  const activeColor = folder.color ?? 'default';

  return (
    <div class={cls('context-menu')} style={position} role="menu">
      {actions.onAddCurrentConversation && (
        <MenuButton
          labelKey="floatingPanelAddCurrentHere"
          onClick={(e) => {
            e.stopPropagation();
            apply({ contextMenu: null }, () => actions.onAddCurrentConversation?.(folder.id));
          }}
        />
      )}
      <MenuButton
        labelKey={folder.pinned ? 'floatingPanelUnpinFolder' : 'floatingPanelPinFolder'}
        onClick={(e) => {
          e.stopPropagation();
          apply({ contextMenu: null }, () => actions.onToggleFolderPinned?.(folder.id));
        }}
      />
      {canCreateChildAtDepth(getFolderDepth(data, folder.id)) && (
        <MenuButton
          labelKey="floatingPanelCreateSubfolder"
          onClick={(e) => {
            e.stopPropagation();
            apply({
              expand: { folderId: folder.id, expanded: true },
              contextMenu: null,
              inlineEditor: { mode: 'create', parentId: folder.id },
            });
          }}
        />
      )}
      <MenuButton
        labelKey="floatingPanelRenameFolder"
        onClick={(e) => {
          e.stopPropagation();
          apply({ contextMenu: null, inlineEditor: { mode: 'rename', folderId: folder.id } });
        }}
      />
      <div class={cls('color-section')}>
        <div class={cls('color-title')}>{t('floatingPanelColor')}</div>
        <div class={cls('color-swatches')}>
          {FOLDER_COLORS.map((color) => (
            <button
              key={color.id}
              type="button"
              class={
                activeColor === color.id
                  ? `${cls('color-swatch')} ${cls('color-swatch--active')}`
                  : cls('color-swatch')
              }
              style={{ backgroundColor: getFolderColor(color.id, dark) }}
              aria-label={t(color.nameKey)}
              title={t(color.nameKey)}
              onClick={(e) => {
                e.stopPropagation();
                apply({ contextMenu: null }, () => actions.onSetFolderColor?.(folder.id, color.id));
              }}
            />
          ))}
        </div>
      </div>
      <div class={cls('menu-divider')} />
      <MenuButton
        labelKey="floatingPanelDeleteFolder"
        extraClass={DANGER}
        onClick={(e) => {
          e.stopPropagation();
          apply({ contextMenu: { ...contextMenu, confirmingDelete: true } });
        }}
      />
    </div>
  );
}
