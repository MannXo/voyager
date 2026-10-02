// Gemini may use either role="menuitemradio" or role="menuitem" depending on the UI variant.
// The 2026 redesign uses <gem-menu-item data-mode-id="..." role="menuitem">.
const MODE_ITEM_SELECTOR = '[role="menuitemradio"], [role="menuitem"]';

// Fallback selector that excludes known non-model menus (e.g. the settings/profile dropdown).
const NON_MODEL_MENU_EXCLUSION_FALLBACK =
  '.mat-mdc-menu-panel[role="menu"]:not(.desktop-settings-menu)';

// 2026 redesign: model picker is now rendered inside a plain cdk-overlay-pane (no Material menu wrapper).
// The pane is identified by containing one or more items carrying data-mode-id.
const NEW_LAYOUT_ITEM_SELECTOR = '[data-mode-id]';
const MODE_SWITCH_CONTAINER_SELECTOR =
  '.cdk-overlay-pane, .mat-mdc-menu-panel[role="menu"], mat-action-list.gds-mode-switch-menu-list';
const MODE_SWITCH_OBSERVER_ROOT_SELECTOR = [
  '.cdk-overlay-container',
  '.cdk-global-overlay-wrapper',
  '.cdk-overlay-connected-position-bounding-box',
  '.cdk-overlay-pane',
  '.mat-mdc-menu-panel[role="menu"]',
  'mat-action-list.gds-mode-switch-menu-list',
  NEW_LAYOUT_ITEM_SELECTOR,
  MODE_ITEM_SELECTOR,
].join(', ');
// Stable Gemini event id observed on the inline Extended thinking toggle. Its
// jslog payload also contains the current model id, so treating the last hex id
// as a model id makes this row impersonate Pro (#808).
const EXTENDED_THINKING_TOGGLE_JSLOG_ID = '323336';

export class ModelPicker {
  public mayContainModeSwitchContainer(root: HTMLElement): boolean {
    return (
      root.matches(MODE_SWITCH_OBSERVER_ROOT_SELECTOR) ||
      root.closest(MODE_SWITCH_CONTAINER_SELECTOR) !== null
    );
  }

  public resolveModeSwitchContainer(root: HTMLElement): HTMLElement | null {
    if (
      root.matches('.mat-mdc-menu-panel.gds-mode-switch-menu[role="menu"]') ||
      root.matches('mat-action-list.gds-mode-switch-menu-list') ||
      root.matches(NON_MODEL_MENU_EXCLUSION_FALLBACK)
    ) {
      return root;
    }

    // 2026 redesign: the added node may be a cdk-overlay-pane containing gem-menu-item entries
    // (model menu) or the thinking-level submenu (no data-mode-id, but aria-controls'd by a
    // value="thinking_level" row that lives in a sibling overlay).
    if (root.matches?.('.cdk-overlay-pane')) {
      if (root.querySelector(NEW_LAYOUT_ITEM_SELECTOR) !== null) return root;
      if (this.isThinkingLevelSubmenuPane(root)) return root;
    }

    if (root.matches(NEW_LAYOUT_ITEM_SELECTOR) || root.matches(MODE_ITEM_SELECTOR)) {
      const pane = root.closest<HTMLElement>(MODE_SWITCH_CONTAINER_SELECTOR);
      if (pane) return pane;
    }

    const legacy =
      root.querySelector<HTMLElement>('.mat-mdc-menu-panel.gds-mode-switch-menu[role="menu"]') ??
      root.querySelector<HTMLElement>('mat-action-list.gds-mode-switch-menu-list');
    if (legacy) return legacy;

    const newItem = root.querySelector<HTMLElement>(NEW_LAYOUT_ITEM_SELECTOR);
    if (newItem) {
      const pane = newItem.closest<HTMLElement>(MODE_SWITCH_CONTAINER_SELECTOR);
      if (pane) return pane;
    }

    const modeItem = root.querySelector<HTMLElement>(MODE_ITEM_SELECTOR);
    if (modeItem) {
      const pane = modeItem.closest<HTMLElement>(MODE_SWITCH_CONTAINER_SELECTOR);
      if (pane) return pane;
    }

    // Thinking submenu may appear nested inside a different root (rare; observer normally sees the pane directly).
    const thinkingPane = this.findThinkingLevelSubmenuPane();
    if (thinkingPane && root.contains(thinkingPane)) return thinkingPane;

    return root.querySelector<HTMLElement>(NON_MODEL_MENU_EXCLUSION_FALLBACK);
  }

  public getModeSwitchMenuPanel(): HTMLElement | null {
    const legacy =
      document.querySelector<HTMLElement>(
        '.mat-mdc-menu-panel.gds-mode-switch-menu[role="menu"]',
      ) ?? document.querySelector<HTMLElement>('mat-action-list.gds-mode-switch-menu-list');
    if (legacy) return legacy;

    // 2026 redesign: any cdk-overlay-pane that contains a [data-mode-id] item is the model picker.
    const newItem = document.querySelector<HTMLElement>(
      `.cdk-overlay-pane ${NEW_LAYOUT_ITEM_SELECTOR}`,
    );
    if (newItem) {
      const pane = newItem.closest<HTMLElement>('.cdk-overlay-pane');
      if (pane) return pane;
    }

    return document.querySelector<HTMLElement>(NON_MODEL_MENU_EXCLUSION_FALLBACK);
  }

  public async waitForModeSwitchMenuPanel(timeoutMs: number): Promise<HTMLElement | null> {
    const startedAt = Date.now();
    const pollIntervalMs = 50;
    while (Date.now() - startedAt < timeoutMs) {
      const panel = this.getModeSwitchMenuPanel();
      if (panel?.isConnected) return panel;
      await new Promise<void>((resolve) => window.setTimeout(resolve, pollIntervalMs));
    }
    return null;
  }

  public isNestedThinkingLevelItem(item: HTMLElement): boolean {
    const row = item.closest<HTMLElement>('[value="thinking_level"]');
    return !!row && row !== item;
  }

  public isInlineExtendedThinkingToggle(item: HTMLElement): boolean {
    if (item.getAttribute('value') === 'thinking_level') return false;
    const jslogId = item.getAttribute('jslog')?.split(';', 1)[0]?.trim();
    return jslogId === EXTENDED_THINKING_TOGGLE_JSLOG_ID;
  }

  public findInlineExtendedThinkingToggle(root: ParentNode): HTMLElement | null {
    return (
      Array.from(root.querySelectorAll<HTMLElement>(MODE_ITEM_SELECTOR)).find((item) =>
        this.isInlineExtendedThinkingToggle(item),
      ) ?? null
    );
  }

  public getThinkingLevelLabel(item: HTMLElement): string {
    const titleEl = item.querySelector('.label, .gds-title-m, .gds-label-l');
    return titleEl?.textContent?.trim() || '';
  }

  public getModelNameFromItem(item: HTMLElement): string {
    const titleEl = item.querySelector('.mode-title, .gds-title-m, .gds-label-l, .label');
    return titleEl?.textContent?.trim() || '';
  }

  public getModelIdFromItem(item: HTMLElement): string | null {
    const raw = item.getAttribute('data-mode-id') || item.dataset.modeId;
    if (typeof raw === 'string') {
      const id = raw.trim();
      if (id.length) return id;
    }

    // Compact layout may omit data-mode-id but keeps the internal model id in jslog metadata.
    const jslog = item.getAttribute('jslog');
    if (typeof jslog === 'string') {
      const matchedIds = jslog.match(/[a-f0-9]{16}/gi);
      const id = matchedIds?.[matchedIds.length - 1]?.trim();
      if (id) return id;
    }

    return null;
  }

  public isModelItemSelected(item: HTMLElement): boolean {
    return (
      item.getAttribute('aria-checked') === 'true' ||
      item.classList.contains('is-selected') ||
      item.classList.contains('selected')
    );
  }

  public openThinkingLevelSubmenu(thinkingRow: HTMLElement): void {
    const content = thinkingRow.querySelector<HTMLElement>(
      'gem-menu-item-content, .label-container',
    );
    const targets = content && content !== thinkingRow ? [thinkingRow, content] : [thinkingRow];
    const mouseInit: MouseEventInit = { bubbles: true, cancelable: true };
    const enterInit: MouseEventInit = { bubbles: false, cancelable: true };

    for (const target of targets) {
      if ('PointerEvent' in window) {
        const pointerInit: PointerEventInit = {
          bubbles: true,
          cancelable: true,
          pointerType: 'mouse',
        };
        const pointerEnterInit: PointerEventInit = { ...pointerInit, bubbles: false };
        target.dispatchEvent(new PointerEvent('pointerover', pointerInit));
        target.dispatchEvent(new PointerEvent('pointerenter', pointerEnterInit));
        target.dispatchEvent(new PointerEvent('pointermove', pointerInit));
      }

      target.dispatchEvent(new MouseEvent('mouseover', mouseInit));
      target.dispatchEvent(new MouseEvent('mouseenter', enterInit));
      target.dispatchEvent(new MouseEvent('mousemove', mouseInit));
    }

    thinkingRow.focus({ preventScroll: true });
    thinkingRow.click();
  }

  public async waitForThinkingLevelSubmenu(timeoutMs: number): Promise<HTMLElement | null> {
    const startedAt = Date.now();
    while (Date.now() - startedAt < timeoutMs) {
      const pane = this.findThinkingLevelSubmenuPane();
      if (pane?.isConnected && this.getThinkingLevelItems().length > 0) return pane;
      await new Promise<void>((resolve) => window.setTimeout(resolve, 50));
    }
    return null;
  }

  // ==================== Thinking level helpers (2026 redesign) ====================

  /**
   * Find the "Thinking level" submenu row in any open model picker.
   * Detected by the stable attribute value="thinking_level" rendered by Gemini.
   */
  public findThinkingLevelTriggerRow(): HTMLElement | null {
    return document.querySelector<HTMLElement>(
      '.cdk-overlay-pane [value="thinking_level"], .cdk-overlay-pane gem-menu-item[value="thinking_level"]',
    );
  }

  /**
   * Resolve the submenu pane (the one containing Standard/Extended) by walking
   * from the Thinking level row's aria-controls to the matching menu id.
   */
  public findThinkingLevelSubmenuPane(): HTMLElement | null {
    const row = this.findThinkingLevelTriggerRow();
    const controlsId = row?.getAttribute('aria-controls');
    if (controlsId) {
      const submenu = document.getElementById(controlsId);
      if (submenu) {
        return submenu.closest<HTMLElement>('.cdk-overlay-pane') ?? submenu;
      }
    }
    return row?.querySelector('gem-menu-item, [role="menuitem"]') ? row : null;
  }

  public getThinkingLevelItems(): HTMLElement[] {
    const submenu = this.findThinkingLevelSubmenuPane();
    if (!submenu) return [];
    return Array.from(submenu.querySelectorAll<HTMLElement>('gem-menu-item, [role="menuitem"]'));
  }

  public isThinkingLevelSubmenuPane(pane: HTMLElement): boolean {
    // The submenu pane never carries the trigger row itself — that lives only in the parent overlay.
    if (pane.querySelector('[value="thinking_level"]')) return false;
    const row = this.findThinkingLevelTriggerRow();
    const controlsId = row?.getAttribute('aria-controls');
    if (!controlsId) return false;
    const submenuEl = document.getElementById(controlsId);
    if (!submenuEl) return false;
    return pane.id === controlsId || pane.contains(submenuEl);
  }

  /**
   * Find the model selector trigger button using all known selectors.
   * Shared by `readTriggerPillLines`, `tryLockToModel`, and `tryLockToThinkingLevel`
   * so the fast-path check and the actual menu-opening code always agree on
   * whether the button exists (prevents unnecessary menu clicks when the button
   * is only discoverable via a selector that the fast-path didn't check — #756).
   */
  public findSelectorButton(): HTMLElement | null {
    return (
      document.querySelector<HTMLElement>('[data-test-id="bard-mode-menu-button"]') ??
      document.querySelector<HTMLElement>('button.input-area-switch') ??
      document.querySelector<HTMLElement>('.input-area-switch-label') ??
      document.querySelector<HTMLElement>('[data-test-id="model-selector"]') ??
      document.querySelector<HTMLElement>('button[aria-haspopup="menu"].mat-mdc-menu-trigger')
    );
  }

  /**
   * Read the trigger pill's visible text. The 2026 redesign renders the model name and
   * the optional thinking level on two separate lines (innerText newline-separated).
   * Returns the raw lines so callers can match against stored labels.
   */
  public readTriggerPillLines(): string[] {
    const btn = this.findSelectorButton();
    const text = btn?.innerText ?? btn?.textContent ?? '';
    return text
      .split(/\n+/)
      .map((s) => s.trim())
      .filter(Boolean);
  }
}
