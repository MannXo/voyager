import type { Folder } from '@/core/types/folder';
import { sortFolders } from '@/features/folder/model/folderData';
import { getTranslationSyncUnsafe as t } from '@/utils/i18n';

import { FOLDER_COLORS, getFolderColor, isDarkMode } from './folderColors';

export type DialogView = {
  element: HTMLElement;
  inline: boolean;
  /**
   * A body-level dialog holding user input, which must outlive a panel remount.
   * Everything else is anchored to a sidebar row and is stranded at stale
   * coordinates once that row is rebuilt, so it is closed instead.
   */
  modal: boolean;
  signal: AbortSignal;
  close: () => void;
  defer: (action: () => void, delay: number) => void;
};

/** Registers an element with the dialog owner, which closes it and its listeners together. */
export type OwnDialogView = (
  element: HTMLElement,
  inline?: boolean,
  restore?: () => void,
  modal?: boolean,
) => DialogView;

const VIEWPORT_MARGIN = 8;

/**
 * Pins a confirm at `left`/`top`, moved in as far as its measured width needs
 * to stay on screen. A fixed 280px allowance let a wider dialog spill past the
 * right edge. It is measured at the left edge: a shrink-to-fit box measured
 * at the anchor is narrower there than once it moves in.
 */
export function placeConfirm(dialog: HTMLElement, left: number, top: number): void {
  dialog.style.position = 'fixed';
  dialog.style.top = `${top}px`;
  dialog.style.left = '0px';
  const maxLeft = window.innerWidth - dialog.getBoundingClientRect().width - VIEWPORT_MARGIN;
  dialog.style.left = `${Math.max(VIEWPORT_MARGIN, Math.min(left, maxLeft))}px`;
}

export function dismissOnOutsideClick(view: DialogView): void {
  view.defer(() => {
    document.addEventListener(
      'click',
      (event) => {
        if (!view.element.contains(event.target as Node)) view.close();
      },
      { signal: view.signal },
    );
  }, 0);
}

function normalizeFolderPath(value: string): string {
  return value
    .trim()
    .toLocaleLowerCase()
    .replace(/\s*\/\s*/g, '/');
}

export function openRemovalConfirm(
  own: OwnDialogView,
  message: string,
  label: string,
  onConfirm: () => void,
): HTMLElement {
  const dialog = document.createElement('div');
  dialog.className = 'gv-folder-confirm-dialog';
  const view = own(dialog);
  const text = document.createElement('div');
  text.className = 'gv-folder-confirm-message';
  text.textContent = message;
  const actions = document.createElement('div');
  actions.className = 'gv-folder-confirm-actions';
  const yes = document.createElement('button');
  yes.className = 'gv-folder-confirm-btn gv-folder-confirm-yes';
  yes.textContent = label;
  yes.addEventListener(
    'click',
    () => {
      view.close();
      onConfirm();
    },
    { signal: view.signal },
  );
  const no = document.createElement('button');
  no.className = 'gv-folder-confirm-btn gv-folder-confirm-no';
  no.textContent = t('pm_cancel');
  no.addEventListener('click', view.close, { signal: view.signal });
  actions.append(yes, no);
  dialog.append(text, actions);
  document.body.appendChild(dialog);
  dismissOnOutsideClick(view);
  return dialog;
}

function createCustomColorButton(
  view: DialogView,
  currentColor: string | undefined,
  select: (color: string) => void,
): HTMLElement {
  const custom = document.createElement('button');
  custom.className = 'gv-color-picker-item gv-color-picker-custom';
  custom.title = t('folder_color_custom');
  const input = document.createElement('input');
  input.type = 'color';
  input.style.cssText =
    'position: absolute; opacity: 0; width: 100%; height: 100%; top: 0; left: 0; cursor: pointer;';
  if (currentColor?.startsWith('#')) {
    input.value = currentColor;
    custom.classList.add('selected');
    custom.style.background = currentColor;
  } else {
    custom.style.background =
      'conic-gradient(from 180deg at 50% 50%, #D9231E 0deg, #F06800 66.47deg, #E6A300 125.68deg, #2D9CDB 195.91deg, #9B51E0 262.24deg, #D9231E 360deg)';
  }
  input.addEventListener('change', () => select(input.value), { signal: view.signal });
  custom.addEventListener(
    'click',
    (click) => {
      click.stopPropagation();
      if (click.target === custom) input.click();
    },
    { signal: view.signal },
  );
  custom.appendChild(input);
  return custom;
}

export function openColorPicker(
  own: OwnDialogView,
  currentColor: string | undefined,
  event: MouseEvent,
  onSelect: (color: string) => void,
): DialogView {
  const dialog = document.createElement('div');
  dialog.className = 'gv-color-picker-dialog';
  dialog.style.position = 'fixed';
  dialog.style.left = `${event.clientX + 10}px`;
  dialog.style.top = `${event.clientY}px`;
  dialog.style.zIndex = '10001';
  const view = own(dialog);
  const select = (color: string) => {
    view.close();
    onSelect(color);
  };
  const dark = isDarkMode();
  for (const color of FOLDER_COLORS) {
    const button = document.createElement('button');
    button.className = 'gv-color-picker-item';
    button.title = t(color.nameKey);
    button.style.backgroundColor = getFolderColor(color.id, dark);
    if (currentColor === color.id || (!currentColor && color.id === 'default')) {
      button.classList.add('selected');
    }
    button.addEventListener('click', () => select(color.id), { signal: view.signal });
    dialog.appendChild(button);
  }
  dialog.appendChild(createCustomColorButton(view, currentColor, select));
  document.body.appendChild(dialog);
  dismissOnOutsideClick(view);
  return view;
}

type MoveOption = { folder: Folder; level: number; path: string };

function collectMoveOptions(folders: readonly Folder[]): MoveOption[] {
  const options: MoveOption[] = [];
  const collect = (
    parentId: string | null,
    level = 0,
    parentPath = '',
    ancestors = new Set<string>(),
  ) => {
    for (const folder of sortFolders(folders.filter((item) => item.parentId === parentId))) {
      if (ancestors.has(folder.id)) continue;
      const path = parentPath ? `${parentPath} / ${folder.name}` : folder.name;
      options.push({ folder, level, path });
      collect(folder.id, level + 1, path, new Set([...ancestors, folder.id]));
    }
  };
  collect(null);
  return options;
}

function createMoveItem(
  view: DialogView,
  { folder, level, path }: MoveOption,
  onSelect: (folderId: string) => void,
): HTMLElement {
  const item = document.createElement('button');
  item.className = 'gv-folder-dialog-item';
  // The flat picker always indents children, independent of sidebar spacing.
  item.style.paddingLeft = `${level * 16 + 12}px`;
  item.dataset.folderId = folder.id;
  item.dataset.folderPath = path;
  item.setAttribute('aria-label', path);
  const icon = document.createElement('mat-icon');
  icon.className = 'mat-icon notranslate google-symbols mat-ligature-font mat-icon-no-color';
  icon.setAttribute('role', 'img');
  icon.setAttribute('aria-hidden', 'true');
  icon.textContent = 'folder';
  const name = document.createElement('span');
  name.className = 'gv-folder-dialog-item-text';
  name.textContent = folder.name;
  const pathLabel = document.createElement('span');
  pathLabel.className = 'gv-folder-dialog-item-path';
  pathLabel.textContent = `/${normalizeFolderPath(path)}`;
  item.append(icon, name, pathLabel);
  item.addEventListener(
    'click',
    () => {
      view.close();
      onSelect(folder.id);
    },
    { signal: view.signal },
  );
  return item;
}

export function openMoveDialog(
  own: OwnDialogView,
  folders: readonly Folder[],
  onSelect: (folderId: string) => void,
): void {
  const overlay = document.createElement('div');
  overlay.className = 'gv-folder-dialog-overlay';
  const view = own(overlay, false, undefined, true);
  const dialog = document.createElement('div');
  dialog.className = 'gv-folder-dialog';
  const title = document.createElement('div');
  title.className = 'gv-folder-dialog-title';
  title.textContent = t('conversation_move_to_folder_title');
  const search = document.createElement('input');
  search.type = 'search';
  search.className = 'gv-folder-dialog-search';
  search.placeholder = t('timelinePreviewSearch');
  search.setAttribute('aria-label', t('timelinePreviewSearch'));
  const list = document.createElement('div');
  list.className = 'gv-folder-dialog-list';
  const empty = document.createElement('div');
  empty.className = 'gv-folder-dialog-empty';
  empty.textContent = t('timelinePreviewNoResults');
  const options = collectMoveOptions(folders);
  const render = () => {
    list.replaceChildren();
    const query = normalizeFolderPath(search.value);
    const visible = options.filter((option) => normalizeFolderPath(option.path).includes(query));
    for (const option of visible) list.appendChild(createMoveItem(view, option, onSelect));
    if (visible.length === 0) list.appendChild(empty);
  };
  render();
  search.addEventListener('input', render, { signal: view.signal });
  const cancel = document.createElement('button');
  cancel.className = 'gv-folder-dialog-cancel';
  cancel.textContent = t('pm_cancel');
  cancel.addEventListener('click', view.close, { signal: view.signal });
  dialog.append(title, search, list, cancel);
  overlay.appendChild(dialog);
  document.body.appendChild(overlay);
  overlay.addEventListener(
    'click',
    (click) => {
      if (click.target === overlay) view.close();
    },
    { signal: view.signal },
  );
}

export function openInstructionsDialog(
  own: OwnDialogView,
  instructions: string | undefined,
  onSave: (instructions: string | undefined) => Promise<boolean>,
): void {
  const maxChars = 10000;
  const overlay = document.createElement('div');
  overlay.className = 'gv-fi-overlay';
  const view = own(overlay, false, undefined, true);
  const dialog = document.createElement('div');
  dialog.className = 'gv-fi-dialog';
  dialog.setAttribute('role', 'dialog');
  dialog.setAttribute('aria-modal', 'true');
  dialog.setAttribute('aria-labelledby', 'gv-fi-dialog-title');
  const title = document.createElement('h2');
  title.className = 'gv-fi-title';
  title.id = 'gv-fi-dialog-title';
  title.textContent = t(
    instructions ? 'folderAsProject_editInstructions' : 'folderAsProject_setInstructions',
  );
  const input = document.createElement('textarea');
  input.className = 'gv-fi-textarea';
  input.maxLength = maxChars;
  input.rows = 7;
  input.placeholder = t('folderAsProject_setInstructions');
  input.value = instructions ?? '';
  const count = document.createElement('div');
  count.className = 'gv-fi-char-count';
  const updateCount = () => {
    count.textContent = `${input.value.length} / ${maxChars}`;
  };
  updateCount();
  input.addEventListener('input', updateCount, { signal: view.signal });
  const actions = document.createElement('div');
  actions.className = 'gv-fi-actions';
  const cancel = document.createElement('button');
  cancel.type = 'button';
  cancel.className = 'gv-fi-btn gv-fi-btn-cancel';
  cancel.textContent = t('pm_cancel');
  cancel.addEventListener('click', view.close, { signal: view.signal });
  const save = document.createElement('button');
  save.type = 'button';
  save.className = 'gv-fi-btn gv-fi-btn-save';
  save.textContent = t('pm_save');
  save.addEventListener(
    'click',
    async () => {
      save.disabled = true;
      const saved = await onSave(input.value.trim() || undefined);
      if (saved) view.close();
      else save.disabled = false;
    },
    { signal: view.signal },
  );
  actions.append(cancel, save);
  dialog.append(title, input, count, actions);
  overlay.appendChild(dialog);
  document.body.appendChild(overlay);
  overlay.addEventListener(
    'click',
    (click) => {
      if (click.target === overlay) view.close();
    },
    { signal: view.signal },
  );
  overlay.addEventListener(
    'keydown',
    (event) => {
      if (event.key === 'Escape') view.close();
    },
    { signal: view.signal },
  );
  view.defer(() => input.focus(), 50);
}
