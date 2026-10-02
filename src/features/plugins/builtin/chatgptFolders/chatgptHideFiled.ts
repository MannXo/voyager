import type { PluginScope } from '@/features/plugins/runtime/pluginScope';

import { listSidebarConversations } from './chatgptSidebarDom';

/** The plugin setting that turns hiding on; absent means off. */
export const HIDE_FILED_SETTING = 'hideFiledChats';
export const FILED_ROW_ATTRIBUTE = 'data-gv-chatgpt-filed';

/** Recents only: a filed chat stays visible inside its Project. */
const HISTORY_ROW = '[data-sidebar-project-container-id="chats"] [role="listitem"]';
const ID_PATTERN = /^[A-Za-z0-9_-]+$/;

// The current-page exception responds to navigation without waiting for a row pass.
const HIDE_FILED_CSS = `${HISTORY_ROW}[${FILED_ROW_ATTRIBUTE}]:not([aria-current="page"]):not(:has([aria-current="page"])) { display: none !important; }`;

/**
 * One constant rule, with membership checked only for mounted native rows.
 * The existing sidebar watcher reconciles recycled rows and pagination.
 */
export class ChatGptHideFiled {
  private readonly style: HTMLStyleElement;
  private filed: ReadonlySet<string> = new Set();
  private marked = new Set<HTMLElement>();

  constructor(
    scope: PluginScope,
    private readonly doc: Document = document,
  ) {
    this.style = doc.createElement('style');
    this.style.setAttribute('data-gv-chatgpt-hide-filed', '');
    this.style.textContent = HIDE_FILED_CSS;
    scope.effect(() => {
      doc.head.append(this.style);
      return () => {
        this.style.remove();
        this.sync(null);
        this.filed = new Set();
      };
    }, 'chatgpt-folders:hide-filed');
  }

  update(ids: Iterable<string>): void {
    this.filed = new Set([...ids].filter((id) => ID_PATTERN.test(id)));
  }

  sync(sidebar: HTMLElement | null): void {
    // Include cloned marks, and tracked rows that React has already detached.
    const stale = new Set([
      ...this.marked,
      ...this.doc.querySelectorAll<HTMLElement>(`[${FILED_ROW_ATTRIBUTE}]`),
    ]);
    this.marked = new Set();
    for (const row of sidebar?.querySelectorAll<HTMLElement>(HISTORY_ROW) ?? []) {
      if (!listSidebarConversations(row).some(({ id }) => this.filed.has(id))) continue;
      if (!row.hasAttribute(FILED_ROW_ATTRIBUTE)) row.setAttribute(FILED_ROW_ATTRIBUTE, '');
      this.marked.add(row);
      stale.delete(row);
    }
    for (const row of stale) row.removeAttribute(FILED_ROW_ATTRIBUTE);
  }
}
