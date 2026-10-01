import type { ExtractedContent } from '@/features/export/services/DOMContentExtractor';
import type { ChatTurn } from '@/features/export/types/export';
import type { SiteAdapter } from '@/features/plugins/types';

import type { ChatGptTurnContainer, ChatGptTurnRole, ExportSelectionOptions } from '../type';

/**
 * Platform boundary for the shared conversation export pipeline.
 *
 * Platform modules translate host DOM into this contract. Shared export
 * services must not branch on a host name or depend on host-specific selectors.
 */
export interface ExportPlatformAdapter {
  readonly site: SiteAdapter;

  getUserSelectors: () => string[];
  getAssistantSelectors: () => string[];
  getConversationRootCandidates: () => string[];
  extractConversationTitle: () => string;
  extractConversationIdFromUrl: () => string | null;
  shouldPreloadHistory: () => boolean;
  resolveConversationRoot: (userSelectors: string[], doc: Document) => HTMLElement;
  extractUserImage: (element: HTMLElement) => NodeListOf<HTMLImageElement>;
  extractUserText: (
    textLines: NodeListOf<HTMLElement>,
    textParts: string[],
    element: HTMLElement,
  ) => void;
  getUserAttachmentCandidates: (element: HTMLElement) => HTMLElement[] | undefined;
  extractAssistantImage: (
    child: Element,
    htmlParts: string[],
    textParts: string[],
    flags: Pick<ExtractedContent, 'hasImages' | 'hasFormulas' | 'hasTables' | 'hasCode'>,
    tagName?: string,
    DEBUG?: boolean,
    processedImageSrcs?: Set<string>,
  ) => boolean | undefined;
  /**
   * Images rendered beside the markdown walk (search / generated attachments).
   * Deduped via `processedImageSrcs`. Hosts inside `skipInside` were already
   * visited in DOM order and must not be appended again.
   */
  collectAssistantImages?: (
    root: Element,
    htmlParts: string[],
    textParts: string[],
    flags: Pick<ExtractedContent, 'hasImages' | 'hasFormulas' | 'hasTables' | 'hasCode'>,
    processedImageSrcs?: Set<string>,
    skipInside?: Element | null,
  ) => void;
  extractFormula: (
    child: Element,
    flags: Pick<ExtractedContent, 'hasImages' | 'hasFormulas' | 'hasTables' | 'hasCode'>,
    htmlParts: string[],
    textParts: string[],
    DEBUG: boolean,
  ) => boolean | undefined;
  extractCodeBlock: (
    child: Element,
    htmlParts: string[],
    textParts: string[],
    flags: Pick<ExtractedContent, 'hasImages' | 'hasFormulas' | 'hasTables' | 'hasCode'>,
    tagName?: string,
    DEBUG?: boolean,
  ) => boolean | undefined;
  extractInlineFormula: (
    el: Element,
    htmlParts: string[],
    textParts: string[],
  ) => boolean | undefined;

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
   * true when it handled the preparation; false or omitted falls back to
   * scrolling the conversation to the top.
   */
  prepareConversation?: (options: ExportSelectionOptions) => Promise<boolean>;
  /** Drop what `prepareConversation` kept once the export session ends. */
  releaseConversation?: () => void;

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
