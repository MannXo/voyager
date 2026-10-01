import { type ScrollView, createScrollView, findScrollContainer } from './chatgptScrollView';
import {
  type ChatGptThreadMessage,
  assistantMessageId,
  extractAssistantMessage,
  extractUserMessage,
  findAssistantReply,
  findMountedTurnItem,
  findUserBubble,
  hasPendingHistory,
  hasRenderedContent,
  isChatGptThreadGenerating,
  isEmptyContent,
  isItemGenerating,
  mountedTurnItems,
  readTurnKey,
  resolveVisibleConversationRoot,
  userMessageId,
  userSelectionHost,
} from './chatgptThread';
import type { ExportSelectionOptions } from './type';

/**
 * Walk ChatGPT's virtualized thread from its first turn to its last and
 * extract every item while it is mounted.
 *
 * Completeness rests on three checks, and any failure throws rather than
 * returning a shorter list:
 * - start: older history is loaded until ChatGPT's history spinner is gone and
 *   the top of the thread stops changing, so the first mounted item is turn 1;
 * - no gaps: every scroll keeps the last recorded item mounted, so each new
 *   window continues the previous one. A window without it is retried with a
 *   shorter step, then fails;
 * - end: the walk stops only at the bottom of the scroller.
 */

export interface ChatGptCrawlTiming {
  /** Interval between DOM reads. */
  readonly pollMs: number;
  /** A window counts as mounted once its keys and the scroll range hold this long. */
  readonly settleMs: number;
  /** Longest wait for a window to settle or an item's content to appear. */
  readonly mountTimeoutMs: number;
  /** The top of the thread must hold this long, spinner gone, to count as fully loaded. */
  readonly historyIdleMs: number;
  /** Longest wait for a pending history page to make progress. */
  readonly historyStallMs: number;
  readonly maxSteps: number;
}

export const DEFAULT_CHATGPT_CRAWL_TIMING: ChatGptCrawlTiming = {
  pollMs: 50,
  settleMs: 150,
  mountTimeoutMs: 2500,
  historyIdleMs: 1000,
  historyStallMs: 10000,
  maxSteps: 5000,
};

export interface ChatGptCrawlOptions extends ExportSelectionOptions {
  readonly timing?: Partial<ChatGptCrawlTiming>;
}

/** A tall last item is crossed in steps of this share of the viewport. */
const TALL_ITEM_STEP = 0.9;
const MAX_GAP_RETRIES = 6;

export function normalizedConversationUrl(url: string = location.href): string {
  const parsed = new URL(url, location.href);
  return `${parsed.origin}${parsed.pathname}${parsed.search}`;
}

function abortError(): DOMException {
  return new DOMException('ChatGPT export cancelled', 'AbortError');
}

function assertActive(options: ExportSelectionOptions): void {
  if (options.signal?.aborted) throw abortError();
  if (
    options.expectedUrl &&
    normalizedConversationUrl(options.expectedUrl) !== normalizedConversationUrl()
  ) {
    throw new Error('chatgpt_export_conversation_changed');
  }
}

function wait(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return Promise.reject(abortError());
  return new Promise((resolve, reject) => {
    const timer = window.setTimeout(done, ms);
    function done(): void {
      signal?.removeEventListener('abort', cancel);
      resolve();
    }
    function cancel(): void {
      window.clearTimeout(timer);
      signal?.removeEventListener('abort', cancel);
      reject(abortError());
    }
    signal?.addEventListener('abort', cancel, { once: true });
  });
}

interface CrawlContext {
  readonly root: HTMLElement;
  readonly view: ScrollView;
  readonly options: ChatGptCrawlOptions;
  readonly timing: ChatGptCrawlTiming;
}

function windowSignature(context: CrawlContext): string {
  const keys = mountedTurnItems(context.root).map(readTurnKey).join(',');
  return `${keys}|${Math.round(context.view.range())}`;
}

/** Wait until the mounted window stops changing, or the mount timeout passes. */
async function settleWindow(context: CrawlContext): Promise<void> {
  const { timing, options } = context;
  const startedAt = Date.now();
  let signature = windowSignature(context);
  let stableSince = Date.now();
  while (Date.now() - startedAt < timing.mountTimeoutMs) {
    await wait(timing.pollMs, options.signal);
    assertActive(options);
    const next = windowSignature(context);
    if (next !== signature) {
      signature = next;
      stableSince = Date.now();
    } else if (Date.now() - stableSince >= timing.settleMs) {
      return;
    }
  }
}

/** Scroll to the top until ChatGPT has no older page left to load. */
async function loadFullHistory(context: CrawlContext): Promise<void> {
  const { root, view, timing, options } = context;
  let signature = '';
  let changedAt = Date.now();
  for (;;) {
    assertActive(options);
    view.scrollTo(0);
    await wait(timing.pollMs, options.signal);
    const first = mountedTurnItems(root)[0] ?? null;
    const next = `${first ? readTurnKey(first) : ''}|${Math.round(view.range())}`;
    if (next !== signature) {
      signature = next;
      changedAt = Date.now();
      continue;
    }
    const pending = hasPendingHistory(root, first);
    const idleFor = Date.now() - changedAt;
    if (!pending && first && view.offset() <= 1 && idleFor >= timing.historyIdleMs) return;
    if (idleFor >= timing.historyStallMs) throw new Error('chatgpt_export_history_unavailable');
  }
}

/** Extract one item's messages, waiting briefly for content that is still mounting. */
async function captureItem(context: CrawlContext, key: string): Promise<ChatGptThreadMessage[]> {
  const { root, timing, options } = context;
  const deadline = Date.now() + timing.mountTimeoutMs;
  for (;;) {
    assertActive(options);
    const item = findMountedTurnItem(root, key);
    if (!item) throw new Error(`chatgpt_export_message_unavailable:${key}`);
    if (isItemGenerating(root, item)) throw new Error('chatgpt_export_response_still_generating');

    const bubble = findUserBubble(item);
    const reply = findAssistantReply(item);
    const ready =
      (bubble !== null || reply !== null) &&
      (!bubble || hasRenderedContent(bubble)) &&
      (!reply || hasRenderedContent(reply));
    if (ready || Date.now() >= deadline) {
      if (!bubble && !reply) {
        // Not a message item. One that shows content has a shape this export
        // does not know, so dropping it would lose part of the conversation.
        if (hasRenderedContent(item)) throw new Error(`chatgpt_export_message_unavailable:${key}`);
        return [];
      }
      // A bubble or reply still empty after the wait is blank in ChatGPT too.
      const messages: ChatGptThreadMessage[] = [];
      if (bubble && hasRenderedContent(bubble)) {
        const content = extractUserMessage(item, bubble);
        if (!isEmptyContent(content)) {
          messages.push({
            id: userMessageId(key),
            turnKey: key,
            role: 'user',
            content,
            host: userSelectionHost(item, bubble),
          });
        }
      }
      if (reply && hasRenderedContent(reply)) {
        const content = extractAssistantMessage(item, reply);
        if (!isEmptyContent(content)) {
          messages.push({
            id: assistantMessageId(key),
            turnKey: key,
            role: 'assistant',
            content,
            host: reply,
          });
        }
      }
      return messages;
    }
    await wait(timing.pollMs, options.signal);
  }
}

async function walkThread(context: CrawlContext): Promise<ChatGptThreadMessage[]> {
  const { root, view, timing } = context;
  const recorded = new Set<string>();
  const order: string[] = [];
  const messages: ChatGptThreadMessage[] = [];
  let anchoredOffset = 0;
  let gapRetries = 0;

  view.scrollTo(0);
  for (let step = 0; ; step++) {
    if (step > timing.maxSteps) throw new Error('chatgpt_export_thread_incomplete');
    await settleWindow(context);
    const keys = mountedTurnItems(root).map(readTurnKey);
    if (keys.length === 0) throw new Error('chatgpt_export_thread_incomplete');

    let start = 0;
    const tail = order.at(-1);
    if (tail === undefined) {
      if (view.offset() > 1 || hasPendingHistory(root, findMountedTurnItem(root, keys[0]))) {
        throw new Error('chatgpt_export_thread_incomplete');
      }
    } else {
      const tailIndex = keys.indexOf(tail);
      if (tailIndex < 0) {
        // The scroll skipped past every recorded item, so an unseen one may
        // lie in between. Retry from halfway back to where the tail was mounted.
        if (++gapRetries > MAX_GAP_RETRIES) throw new Error('chatgpt_export_thread_gap');
        view.scrollTo(anchoredOffset + (view.offset() - anchoredOffset) / 2);
        continue;
      }
      if (keys.slice(0, tailIndex).some((key) => !recorded.has(key))) {
        throw new Error('chatgpt_export_thread_order');
      }
      start = tailIndex + 1;
    }
    gapRetries = 0;

    for (const key of keys.slice(start)) {
      if (recorded.has(key)) throw new Error('chatgpt_export_thread_order');
      messages.push(...(await captureItem(context, key)));
      recorded.add(key);
      order.push(key);
    }

    const current = view.offset();
    if (current >= view.range() - 1) return messages;

    anchoredOffset = current;
    const tailItem = findMountedTurnItem(root, order[order.length - 1]);
    const tailTop = tailItem ? view.offsetOf(tailItem) : current;
    view.scrollTo(
      tailTop > current + 1 ? tailTop : current + view.viewportHeight() * TALL_ITEM_STEP,
    );
    if (view.offset() <= current) throw new Error('chatgpt_export_thread_incomplete');
  }
}

interface ScrollRestore {
  restore(): Promise<void>;
}

/**
 * Remember the reader's place: the first visible item and how far it sits
 * below the viewport top, plus the distance from the end of the thread, which
 * history loaded above does not change.
 */
function captureReaderPosition(context: CrawlContext): ScrollRestore {
  const { root, view } = context;
  const distanceFromEnd = view.range() - view.offset();
  const viewTop = view.offset();
  const anchor = mountedTurnItems(root).find(
    (item) => view.offsetOf(item) + item.getBoundingClientRect().height > viewTop,
  );
  const anchorKey = anchor ? readTurnKey(anchor) : null;
  const anchorDelta = anchor ? view.offsetOf(anchor) - viewTop : 0;
  return {
    async restore() {
      view.scrollTo(view.range() - distanceFromEnd);
      if (!anchorKey) return;
      await new Promise((resolve) => window.setTimeout(resolve, context.timing.pollMs));
      const item = findMountedTurnItem(root, anchorKey);
      if (item) view.scrollTo(view.offsetOf(item) - anchorDelta);
    },
  };
}

/**
 * Crawl the visible ChatGPT thread. Returns its messages in conversation order,
 * or throws when it cannot prove the list complete. The reader's scroll
 * position is restored either way.
 */
export async function crawlChatGptThread(
  options: ChatGptCrawlOptions = {},
): Promise<ChatGptThreadMessage[]> {
  assertActive(options);
  const timing = { ...DEFAULT_CHATGPT_CRAWL_TIMING, ...options.timing };
  const root = resolveVisibleConversationRoot(document);
  const first = mountedTurnItems(root)[0];
  if (!first) throw new Error('chatgpt_export_no_turns');
  if (isChatGptThreadGenerating(root)) throw new Error('chatgpt_export_response_still_generating');

  const context: CrawlContext = {
    root,
    view: createScrollView(findScrollContainer(first)),
    options,
    timing,
  };
  const position = captureReaderPosition(context);
  try {
    await loadFullHistory(context);
    return await walkThread(context);
  } finally {
    await position.restore();
  }
}
