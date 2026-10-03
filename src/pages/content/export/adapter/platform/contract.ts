import type { ExportContentDialect } from '@/features/export/services/exportContentDialect';
import type { ChatTurn } from '@/features/export/types/export';
import type { SiteAdapter } from '@/features/plugins/types';

import type {
  ChatGptTurnContainer,
  ChatGptTurnRole,
  ConversationPreparation,
  ExportSelectionOptions,
} from '../type';

/**
 * Platform boundary for the shared conversation export pipeline.
 *
 * Platform modules translate host DOM into this contract. Shared export
 * services must not branch on a host name or depend on host-specific selectors.
 */
export interface ExportPlatformAdapter extends ExportContentDialect {
  readonly site: SiteAdapter;

  getUserSelectors: () => string[];
  getAssistantSelectors: () => string[];
  extractConversationTitle: () => string;
  extractConversationIdFromUrl: () => string | null;
  shouldPreloadHistory: () => boolean;
  resolveConversationRoot: (userSelectors: string[], doc: Document) => HTMLElement;

  /**
   * Whether this page can hold a conversation. Hosts whose chat UI shares the
   * origin with unrelated pages (ChatGPT: Codex, settings) return false there,
   * and the export entry point stays unmounted until the SPA reaches a
   * conversation. Omitted: every page on the host is eligible.
   */
  isConversationPage?: (doc: Document, url: string) => boolean;

  /**
   * Read the conversation before selection mode opens, for platforms whose
   * DOM cannot be walked in place (ChatGPT's virtualized thread). Resolves
   * with what it keeps for the session when it handled the preparation; null
   * or omitted falls back to scrolling the conversation to the top.
   */
  prepareConversation?: (
    options: ExportSelectionOptions,
  ) => Promise<ConversationPreparation | null>;

  collectTurnContainers?: () => ChatGptTurnContainer[];
  buildTurnsForSelection?: (
    selectedMessageIds: ReadonlySet<string>,
    options?: ExportSelectionOptions,
  ) => Promise<ChatTurn[]>;
  resolveSelectionRoles?: (
    selectedMessageIds: ReadonlySet<string>,
    options?: ExportSelectionOptions,
  ) => Promise<ReadonlyMap<string, ChatGptTurnRole>>;
}
