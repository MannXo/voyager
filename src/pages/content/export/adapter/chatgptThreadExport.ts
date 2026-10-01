import type { ChatTurn } from '@/features/export/types/export';

import {
  buildChatGptTurnsForSelection,
  chatgptCollectTurnContainers,
  resolveChatGptSelectionRoles,
} from './chatgpt';
import {
  type ChatGptCrawlOptions,
  crawlChatGptThread,
  normalizedConversationUrl,
} from './chatgptCrawl';
import {
  type ChatGptThreadMessage,
  findAssistantReply,
  findUserBubble,
  hasRenderedThread,
  mountedTurnItems,
  readTurnFingerprint,
  readTurnKey,
  resolveVisibleConversationRoot,
  userSelectionHost,
} from './chatgptThread';
import type { ChatGptTurnContainer, ChatGptTurnRole, ExportSelectionOptions } from './type';

/**
 * Export entry points for ChatGPT.
 *
 * On the current DOM (`[data-turn-key]` items, virtualized whole), the export
 * crawls the thread once before selection mode opens and keeps what it
 * extracted. Selection then reads that snapshot: its ids, roles and content.
 * When the crawl cannot prove the thread complete the snapshot is empty, so
 * the export shows its existing warning instead of offering a partial list.
 * It is dropped as well once a mounted item no longer matches what was read
 * (another branch or a regenerated reply under the same key).
 *
 * The earlier DOM (`[data-turn-id-container]`, persistent per-message
 * containers) keeps its own path in `chatgpt.ts` for accounts ChatGPT has not
 * moved yet.
 */

interface ThreadSnapshot {
  readonly route: string;
  /** null: the crawl started for this route but did not finish, or the thread changed since. */
  readonly messages: readonly ChatGptThreadMessage[] | null;
  /** Why `messages` is null, as the export error to raise. */
  readonly failure: string;
}

let snapshot: ThreadSnapshot | null = null;
/** Counts preparations, so only the latest one publishes its crawl. */
let preparation = 0;
/**
 * The element each message's checkbox was last bound to. An unmounted message
 * keeps it, so selection mode does not rebind it on every refresh.
 */
const lastHosts = new Map<string, HTMLElement>();

/** Test hook: forget the last crawl. */
export function resetChatGptThreadSnapshot(): void {
  snapshot = null;
  lastHosts.clear();
}

function isAbortError(error: unknown): boolean {
  return error instanceof DOMException && error.name === 'AbortError';
}

/**
 * Crawl the current thread before selection mode opens. Resolves true when it
 * handled the preparation: a failed crawl leaves an empty snapshot and still
 * resolves true. Resolves false on the earlier DOM; cancellation rejects.
 */
export async function prepareChatGptExport(options: ChatGptCrawlOptions = {}): Promise<boolean> {
  resetChatGptThreadSnapshot();
  // The earlier DOM keeps its scroll-to-top preparation.
  if (!hasRenderedThread()) return false;
  const current = ++preparation;
  const route = normalizedConversationUrl(options.expectedUrl ?? location.href);
  snapshot = { route, messages: null, failure: 'chatgpt_export_thread_incomplete' };
  try {
    const messages = await crawlChatGptThread(options);
    // A newer preparation owns the snapshot, even when it failed.
    if (current === preparation && snapshot?.route === route) {
      snapshot = { route, messages, failure: '' };
    }
  } catch (error) {
    if (isAbortError(error)) throw error;
    console.warn('[Gemini Voyager] ChatGPT export could not read the whole conversation:', error);
  }
  return true;
}

/** Whether a mounted item shows another version than the one that was read. */
function threadChangedSince(messages: readonly ChatGptThreadMessage[]): boolean {
  const read = new Map(messages.map((message) => [message.turnKey, message.fingerprint]));
  return mountedTurnItems(resolveVisibleConversationRoot(document)).some((item) => {
    const fingerprint = read.get(readTurnKey(item));
    return fingerprint !== undefined && readTurnFingerprint(item) !== fingerprint;
  });
}

function currentSnapshot(): ThreadSnapshot | null {
  if (!snapshot) return null;
  if (snapshot.route !== normalizedConversationUrl()) {
    return { ...snapshot, messages: null, failure: 'chatgpt_export_conversation_changed' };
  }
  if (snapshot.messages && threadChangedSince(snapshot.messages)) {
    snapshot = { ...snapshot, messages: null, failure: 'chatgpt_export_thread_changed' };
  }
  return snapshot;
}

/** Where each message's checkbox goes now: its live element, else the one it was read from. */
function liveHosts(): Map<string, HTMLElement> {
  const hosts = new Map<string, HTMLElement>();
  for (const item of mountedTurnItems(resolveVisibleConversationRoot(document))) {
    const key = readTurnKey(item);
    const bubble = findUserBubble(item);
    const reply = findAssistantReply(item);
    if (bubble) hosts.set(`${key}:u`, userSelectionHost(item, bubble));
    if (reply) hosts.set(`${key}:a`, reply);
  }
  return hosts;
}

export function collectChatGptTurnContainers(): ChatGptTurnContainer[] {
  const current = currentSnapshot();
  if (!current) {
    // A thread on the current DOM that was not crawled would list only the
    // few mounted items; refuse rather than offer a partial selection.
    return hasRenderedThread() ? [] : chatgptCollectTurnContainers();
  }
  if (!current.messages) return [];
  const hosts = liveHosts();
  return current.messages.map((message, sequence) => {
    const container = hosts.get(message.id) ?? lastHosts.get(message.id) ?? message.host;
    lastHosts.set(message.id, container);
    return { id: message.id, sequence, role: message.role, container };
  });
}

function assertActive(options: ExportSelectionOptions): void {
  if (options.signal?.aborted) {
    throw new DOMException('ChatGPT export cancelled', 'AbortError');
  }
  if (
    options.expectedUrl &&
    normalizedConversationUrl(options.expectedUrl) !== normalizedConversationUrl()
  ) {
    throw new Error('chatgpt_export_conversation_changed');
  }
}

function crawledMessages(selectedIds: ReadonlySet<string>): readonly ChatGptThreadMessage[] {
  const current = currentSnapshot();
  if (!current?.messages) throw new Error(current?.failure || 'chatgpt_export_thread_incomplete');
  const known = new Set(current.messages.map((message) => message.id));
  const missing = Array.from(selectedIds).filter((id) => !known.has(id));
  if (missing.length > 0) throw new Error(`chatgpt_export_messages_missing:${missing.join(',')}`);
  return current.messages;
}

/**
 * Selected messages as export turns, in conversation order. A prompt and its
 * reply share an item, so they form one turn when both are selected; either
 * alone becomes a one-sided turn.
 */
export async function buildChatGptExportTurns(
  selectedIds: ReadonlySet<string>,
  options: ExportSelectionOptions = {},
): Promise<ChatTurn[]> {
  if (!snapshot) return buildChatGptTurnsForSelection(selectedIds, options);
  assertActive(options);
  const turns: ChatTurn[] = [];
  const byKey = new Map<string, ChatTurn>();
  for (const message of crawledMessages(selectedIds)) {
    if (!selectedIds.has(message.id)) continue;
    let turn = byKey.get(message.turnKey);
    if (!turn) {
      turn = { user: '', assistant: '', starred: false, omitEmptySections: true };
      byKey.set(message.turnKey, turn);
      turns.push(turn);
    }
    if (message.role === 'user') {
      turn.user = message.content.text;
      turn.attachments = message.content.attachments;
      turn.userContent = message.content;
    } else {
      turn.assistant = message.content.text;
      turn.assistantContent = message.content;
    }
  }
  return turns;
}

export async function resolveChatGptExportRoles(
  selectedIds: ReadonlySet<string>,
  options: ExportSelectionOptions = {},
): Promise<ReadonlyMap<string, ChatGptTurnRole>> {
  if (!snapshot) return resolveChatGptSelectionRoles(selectedIds, options);
  assertActive(options);
  const roles = new Map<string, ChatGptTurnRole>();
  for (const message of crawledMessages(selectedIds)) {
    if (selectedIds.has(message.id)) roles.set(message.id, message.role);
  }
  return roles;
}
