/**
 * Research Pack data model.
 *
 * A pack is the user's hand-picked set of answers (or parts of answers) plus
 * the links they cite and one instruction, assembled into Markdown the user
 * carries to another model. It is a working set, not an archive: it lives in
 * `chrome.storage.local` only and is never synced or backed up.
 */

export const RESEARCH_PACK_VERSION = 1;

/** Hard caps keep one pack well inside the `storage.local` quota. */
export const RESEARCH_PACK_LIMITS = {
  maxItems: 50,
  maxItemChars: 60_000,
  maxPromptChars: 600,
  maxInstructionChars: 4_000,
  maxCitationsPerItem: 60,
  maxTitleChars: 200,
} as const;

export interface ResearchPackCitation {
  /** Normalized absolute http(s) URL; also the dedupe key. */
  url: string;
  /** Link text as shown on the page; may be empty. */
  title: string;
}

export interface ResearchPackItem {
  /** Stable for the same text from the same conversation, so repeat adds are detected. */
  id: string;
  /** Answer body as Markdown (whole answer) or plain text (a selected part). */
  text: string;
  /** True when the user added a selection rather than the whole answer. */
  excerpt: boolean;
  /** The user prompt that produced the answer, when it could be read. */
  prompt: string;
  sourceTitle: string;
  /** Page URL as it was, so `/u/<index>/` account routes survive. */
  sourceUrl: string;
  /** Site id of the source page (`gemini` today). */
  platform: string;
  citations: ResearchPackCitation[];
  addedAt: number;
}

export interface ResearchPack {
  version: typeof RESEARCH_PACK_VERSION;
  /**
   * Bumped by the background owner on every write, never by a tab. A tab shows
   * a snapshot only if it is at least as new as the one on screen. Packs stored
   * before revisions existed read as 0.
   */
  revision: number;
  instruction: string;
  items: ResearchPackItem[];
  updatedAt: number;
}

/** What a content script hands over when the user adds an answer. */
export type ResearchPackDraftItem = Omit<ResearchPackItem, 'id' | 'addedAt'>;

export type AddItemOutcome = 'added' | 'duplicate' | 'full' | 'empty';
