import type { ChatGptFolderStore } from './ChatGptFolderStore';
import { isPlaceholderTitle } from './chatgptPage';
import { listSidebarConversations, readSidebarTitle } from './chatgptSidebarDom';

/**
 * Gives filed conversations the titles ChatGPT's sidebar shows. Reads a row's
 * title only when the row is filed, and ignores the placeholder ChatGPT shows
 * before it names a new conversation. Stored URLs keep the route they were
 * filed under.
 *
 * A title is written only when this tab sees it change (or sees the row for the
 * first time). Another tab's save reloads the store here too; if this tab's
 * sidebar still shows an older cached title, writing it back would start a
 * write → reload → write loop between the two tabs.
 */
export class ChatGptTitleSync {
  /** The title this tab last read from each filed row, by bare id. */
  private readonly seen = new Map<string, string>();

  constructor(private readonly store: ChatGptFolderStore) {}

  sync(sidebar: HTMLElement | null): void {
    const store = this.store;
    if (!sidebar || !store.ready) return;
    const filed = store.filedIds();
    if (filed.size === 0) return;
    const titles = new Map<string, string>();
    const read = new Set<string>();
    for (const row of listSidebarConversations(sidebar)) {
      if (!filed.has(row.id) || read.has(row.id)) continue;
      read.add(row.id);
      const title = readSidebarTitle(row);
      if (!title || isPlaceholderTitle(title) || this.seen.get(row.id) === title) continue;
      this.seen.set(row.id, title);
      titles.set(row.id, title);
    }
    store.applyNativeTitles(titles);
  }
}
