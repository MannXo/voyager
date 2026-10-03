/**
 * What the conversation export needs from one host: its name, which pages hold
 * a conversation, and where the selectable messages and their turns come from.
 * Factories live in `sites/`.
 */
import type { ChatTurn } from '@/features/export/types/export';

import type { ExportSelectionOptions } from './adapter/type';
import type {
  ConversationCollector,
  ExportMessage,
  ExportMessageRole,
} from './conversationCollector';

/** Selectable messages and the export turns built from a selection of them. */
export interface ExportTurnReader {
  /** Selectable messages, in reading order. */
  readonly messages: () => ExportMessage[];
  /** Export turns for the selected messages, content already read from the page. */
  readonly build: (
    selectedIds: ReadonlySet<string>,
    options: ExportSelectionOptions,
  ) => Promise<ChatTurn[]>;
  /** Roles of selected messages the page does not show (a virtualized thread). */
  readonly roles?: (
    selectedIds: ReadonlySet<string>,
    options: ExportSelectionOptions,
  ) => Promise<ReadonlyMap<string, ExportMessageRole>>;
}

/** What a preparation read for one export. It stands in for its source until released. */
export interface ExportTurnSession extends ExportTurnReader {
  readonly release: () => void;
}

export interface ExportTurnSource extends ExportTurnReader {
  /** Reading a selection scrolls the page, so the export shows its collecting banner meanwhile. */
  readonly scrollsWhileBuilding: boolean;
  /**
   * Read the conversation before selection mode opens, for a host whose DOM
   * cannot be walked in place. Null: nothing was read, and the export scrolls
   * the conversation to the top instead.
   */
  readonly prepare?: (options: ExportSelectionOptions) => Promise<ExportTurnSession | null>;
}

export interface ExportSite {
  readonly id: string;
  /** The host's name as exports print it (`ConversationMetadata.platform`). */
  readonly label: string;
  /**
   * Whether this page can hold a conversation. Hosts whose chat UI shares the
   * origin with unrelated pages (ChatGPT: Codex, settings) return false there,
   * and the export entry point stays unmounted until the SPA reaches a
   * conversation. Omitted: every page on the host is eligible.
   */
  readonly isConversationPage?: (doc: Document, url: string) => boolean;
  title(): string;
  readonly turns: ExportTurnSource;
  /** The conversation as rendered: prompts, pairs, Canvas documents and overlay anchors. */
  readonly page: ConversationCollector;
  /**
   * Present on a host that lazy-loads history: an export clicks the topmost
   * prompt until the conversation stops growing, and resumes after a reload.
   */
  readonly history?: {
    userSelectors(): string[];
    assistantSelectors(): string[];
  };
}
