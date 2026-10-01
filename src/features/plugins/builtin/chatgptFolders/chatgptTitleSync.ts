import type { ChatGptFolderStore } from './ChatGptFolderStore';
import { isPlaceholderTitle } from './chatgptPage';
import { listSidebarConversations, readSidebarTitle } from './chatgptSidebarDom';

/**
 * Gives filed conversations the titles ChatGPT's sidebar shows. Reads a row's
 * title only when the row is filed, and ignores the placeholder ChatGPT shows
 * before it names a new conversation. Stored URLs keep the route they were
 * filed under.
 */
export function syncSidebarTitles(store: ChatGptFolderStore, sidebar: HTMLElement | null): void {
  if (!sidebar || !store.ready) return;
  const filed = store.filedIds();
  if (filed.size === 0) return;
  const titles = new Map<string, string>();
  for (const row of listSidebarConversations(sidebar)) {
    if (!filed.has(row.id) || titles.has(row.id)) continue;
    const title = readSidebarTitle(row);
    if (title && !isPlaceholderTitle(title)) titles.set(row.id, title);
  }
  store.applyNativeTitles(titles);
}
