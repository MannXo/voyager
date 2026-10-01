import type { PluginScope } from '@/features/plugins/runtime/pluginScope';

/** The plugin setting that turns hiding on; absent means off. */
export const HIDE_FILED_SETTING = 'hideFiledChats';

/** Recents only: a filed chat stays visible inside its Project. */
const HISTORY_ROW = '[data-sidebar-project-container-id="chats"] [role="listitem"]';
const ID_PATTERN = /^[A-Za-z0-9_-]+$/;

/**
 * One rule hiding the Recents rows of `ids`, keyed by link (`/c/<id>` or a
 * Project route ending in it). The open conversation's row stays visible. If
 * ChatGPT renames the Recents container the rule matches nothing and every row
 * shows again, which is the safe way to fail.
 */
export function hideFiledRowsCss(ids: Iterable<string>): string {
  const links = [...ids]
    .filter((id) => ID_PATTERN.test(id))
    .sort()
    .map((id) => `a[href$="/c/${id}"]`);
  if (links.length === 0) return '';
  return `${HISTORY_ROW}:has(:is(${links.join(', ')})):not(:has([aria-current="page"])) { display: none !important; }`;
}

/**
 * Keeps one `<style>` in sync with the filed ids. Hides nothing in the DOM
 * itself, so ChatGPT's re-renders and pagination are untouched.
 */
export class ChatGptHideFiled {
  private readonly style: HTMLStyleElement;

  constructor(scope: PluginScope, doc: Document = document) {
    this.style = doc.createElement('style');
    this.style.setAttribute('data-gv-chatgpt-hide-filed', '');
    scope.effect(() => {
      doc.head.append(this.style);
      return () => this.style.remove();
    }, 'chatgpt-folders:hide-filed');
  }

  update(ids: Iterable<string>): void {
    const css = hideFiledRowsCss(ids);
    if (this.style.textContent !== css) this.style.textContent = css;
  }
}
