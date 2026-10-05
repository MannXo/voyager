/**
 * The default menu behind a folder header button: a body-level popover below
 * the button, so a scrolling, clipping sidebar cannot cut it. The popover layer
 * owns Escape, Tab, outside presses and following the button.
 */
import { openPopover } from '@/core/ui/layer';

import type { FolderHeaderMenuItem } from './folderHeader';
import menuCss from './folderHeaderMenu.css?raw';

const ITEM_CLASS = 'gv-folder-header-menu-item';

let open: { anchor: HTMLElement; close: () => void } | null = null;

function moveFocus(items: HTMLButtonElement[], from: Element | null, step: number): void {
  const index = items.findIndex((item) => item === from);
  const next = (index + step + items.length) % items.length;
  items[next]?.focus({ preventScroll: true });
}

/** Opens `items` below `anchor`; pressing the same button again closes the menu. */
export function openFolderHeaderMenu(
  anchor: HTMLButtonElement,
  items: readonly FolderHeaderMenuItem[],
): void {
  const wasOpen = open?.anchor === anchor;
  closeFolderHeaderMenu();
  if (wasOpen || items.length === 0) return;

  const finish = (): void => {
    anchor.setAttribute('aria-expanded', 'false');
    if (open?.close === popover.close) open = null;
  };
  const popover = openPopover({
    anchor,
    side: 'below',
    align: 'end',
    css: menuCss,
    anchorToggles: true,
    onDismiss: finish,
  });
  const close = (): void => {
    popover.close();
    finish();
  };
  open = { anchor, close };
  anchor.setAttribute('aria-haspopup', 'menu');
  anchor.setAttribute('aria-expanded', 'true');

  const menu = document.createElement('div');
  menu.className = 'gv-folder-header-menu';
  menu.setAttribute('role', 'menu');
  const buttons = items.map((item) => {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = ITEM_CLASS;
    button.setAttribute('role', 'menuitem');
    // Icons are the module's own constant SVG markup, never page text.
    if (item.iconHtml) button.insertAdjacentHTML('afterbegin', item.iconHtml);
    button.append(item.label);
    button.addEventListener('click', () => {
      close();
      item.action();
    });
    return button;
  });
  menu.addEventListener('keydown', (event) => {
    const step = event.key === 'ArrowDown' ? 1 : event.key === 'ArrowUp' ? -1 : 0;
    if (step === 0) return;
    event.preventDefault();
    moveFocus(buttons, popover.root.activeElement, step);
  });
  menu.append(...buttons);
  popover.root.append(menu);
  popover.place();
  buttons[0]?.focus({ preventScroll: true });
}

/** Closes the open header menu, if any. */
export function closeFolderHeaderMenu(): void {
  open?.close();
  open = null;
}
