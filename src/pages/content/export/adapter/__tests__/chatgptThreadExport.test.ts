import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { DOMContentExtractor } from '@/features/export/services/DOMContentExtractor';

import { type ChatGptCrawlTiming, crawlChatGptThread } from '../chatgptCrawl';
import {
  buildChatGptExportTurns,
  collectChatGptTurnContainers,
  prepareChatGptExport,
  resetChatGptThreadSnapshot,
  resolveChatGptExportRoles,
} from '../chatgptThreadExport';
import { chatgptIsConversationPage } from '../platform/chatgpt';
import type { ExportPlatformAdapter } from '../platformAdapters';
import { type FixtureTurn, makeTurns, mountThreadFixture } from './chatgptThreadFixture';

const FAST: Partial<ChatGptCrawlTiming> = {
  pollMs: 1,
  settleMs: 4,
  mountTimeoutMs: 60,
  historyIdleMs: 25,
  historyStallMs: 150,
};

beforeEach(() => {
  document.body.replaceChildren();
  resetChatGptThreadSnapshot();
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  DOMContentExtractor.setExportAdapter({
    extractUserImage: (element: HTMLElement) => element.querySelectorAll('img'),
    extractUserText: (
      _lines: NodeListOf<HTMLElement>,
      textParts: string[],
      element: HTMLElement,
    ) => {
      const text = DOMContentExtractor.normalizeText(element.textContent || '');
      if (text) textParts.push(text);
    },
    getUserAttachmentCandidates: () => [],
    extractAssistantImage: () => undefined,
    extractFormula: () => undefined,
    extractCodeBlock: () => undefined,
    extractInlineFormula: () => undefined,
  } as unknown as ExportPlatformAdapter);
});

afterEach(() => {
  vi.restoreAllMocks();
});

function ids(turns: readonly FixtureTurn[]): string[] {
  return turns.flatMap((turn) => [
    ...(turn.user !== undefined ? [`${turn.key}:u`] : []),
    ...(turn.assistant !== undefined ? [`${turn.key}:a`] : []),
  ]);
}

describe('crawlChatGptThread', () => {
  it('reads every turn of a virtualized thread that unmounts items while scrolling', async () => {
    const turns = makeTurns(12);
    const fixture = mountThreadFixture({ turns });
    expect(fixture.mountedKeys().length).toBeLessThan(turns.length);
    const unmounted = new Set<string>();
    const observer = new MutationObserver((records) =>
      records.forEach((record) =>
        record.removedNodes.forEach((node) => {
          if (node instanceof HTMLElement && node.dataset.turnKey) {
            unmounted.add(node.dataset.turnKey);
          }
        }),
      ),
    );
    observer.observe(fixture.scroller, { childList: true, subtree: true });

    const messages = await crawlChatGptThread({ timing: FAST });
    observer.disconnect();

    expect(unmounted.size).toBeGreaterThan(0);
    expect(messages.map((message) => message.id)).toEqual(ids(turns));
    expect(messages.map((message) => message.content.text)).toEqual(
      turns.flatMap((turn) => [turn.user, turn.assistant]),
    );
  });

  it('loads paginated history before reading, so the first turn is the conversation start', async () => {
    const turns = makeTurns(10);
    const fixture = mountThreadFixture({ turns, initiallyLoaded: 2, pageSize: 3 });

    const messages = await crawlChatGptThread({ timing: FAST });

    expect(fixture.loadedCount()).toBe(turns.length);
    expect(messages[0]?.id).toBe('turn-01:u');
    expect(messages.map((message) => message.id)).toEqual(ids(turns));
  });

  it.each([
    ['over several pages', 3],
    ['in one page', 7],
  ])(
    'keeps scrolling the thread when it overflows only once older history loads (%s)',
    async (_label, pageSize) => {
      const turns = makeTurns(16, 100);
      const fixture = mountThreadFixture({ turns, initiallyLoaded: 9, pageSize, overscan: 0 });
      expect(fixture.range()).toBe(0);
      vi.spyOn(window, 'scrollTo').mockImplementation(() => {});

      const messages = await crawlChatGptThread({ timing: FAST });

      expect(fixture.loadedCount()).toBe(turns.length);
      expect(messages.map((message) => message.id)).toEqual(ids(turns));
    },
  );

  it('crosses a turn taller than several viewports without losing its neighbours', async () => {
    const turns = makeTurns(5).map((turn, index) =>
      index === 2 ? { ...turn, height: 9000 } : turn,
    );
    mountThreadFixture({ turns, overscan: 0 });

    const messages = await crawlChatGptThread({ timing: FAST });

    expect(messages.map((message) => message.id)).toEqual(ids(turns));
  });

  it('reads the visible page, not a cached conversation ChatGPT keeps hidden before it', async () => {
    const turns = makeTurns(4);
    mountThreadFixture({
      turns,
      cachedPageTurns: [{ key: 'cached-1', height: 500, user: 'Old page', assistant: 'Old' }],
    });

    const messages = await crawlChatGptThread({ timing: FAST });

    expect(messages.map((message) => message.turnKey)).not.toContain('cached-1');
    expect(messages.map((message) => message.id)).toEqual(ids(turns));
  });

  it('gives a prompt without a reply only a user message', async () => {
    const turns: FixtureTurn[] = [
      ...makeTurns(2),
      { key: 'turn-03', height: 400, user: 'Unanswered prompt' },
    ];
    mountThreadFixture({ turns });

    const messages = await crawlChatGptThread({ timing: FAST });

    expect(messages.at(-1)).toMatchObject({ id: 'turn-03:u', role: 'user' });
    expect(messages.map((message) => message.id)).not.toContain('turn-03:a');
  });

  it('fails instead of starting mid-thread when older history never finishes loading', async () => {
    mountThreadFixture({ turns: makeTurns(8), initiallyLoaded: 3, historyDelayMs: Infinity });

    await expect(crawlChatGptThread({ timing: FAST })).rejects.toThrow(
      'chatgpt_export_history_unavailable',
    );
  });

  it('steps back when a scroll overshoots past every recorded turn', async () => {
    const turns = makeTurns(12);
    mountThreadFixture({ turns, overscan: 0, scrollOvershoot: 4000, overshootWrites: 2 });

    const messages = await crawlChatGptThread({ timing: FAST });

    expect(messages.map((message) => message.id)).toEqual(ids(turns));
  });

  it('fails when every scroll skips past the recorded turns, rather than leaving a gap', async () => {
    mountThreadFixture({ turns: makeTurns(12), overscan: 0, scrollOvershoot: 4000 });

    await expect(crawlChatGptThread({ timing: FAST })).rejects.toThrow('chatgpt_export_thread_gap');
  });

  it('refuses a reply that is still streaming', async () => {
    mountThreadFixture({ turns: makeTurns(3) });
    document
      .querySelector('main')!
      .insertAdjacentHTML(
        'beforeend',
        '<button data-testid="stop-button" aria-label="Stop streaming"></button>',
      );

    await expect(crawlChatGptThread({ timing: FAST })).rejects.toThrow(
      'chatgpt_export_response_still_generating',
    );
  });

  it('puts the reader back where they were, history loaded above or not', async () => {
    const turns = makeTurns(10);
    const fixture = mountThreadFixture({ turns, initiallyLoaded: 4, pageSize: 3 });
    const fromEnd = 2200;
    fixture.setOffset(fixture.range() - fromEnd);

    await crawlChatGptThread({ timing: FAST });
    await new Promise((resolve) => setTimeout(resolve, 10));

    expect(fixture.range() - fixture.offset()).toBe(fromEnd);
  });

  it('restores the scroll position when the crawl fails', async () => {
    const fixture = mountThreadFixture({
      turns: makeTurns(10),
      initiallyLoaded: 4,
      historyDelayMs: Infinity,
    });
    fixture.setOffset(1700);
    const fromEnd = fixture.range() - fixture.offset();

    await expect(crawlChatGptThread({ timing: FAST })).rejects.toThrow();
    await new Promise((resolve) => setTimeout(resolve, 10));

    expect(fromEnd).toBeGreaterThan(0);
    expect(fixture.range() - fixture.offset()).toBe(fromEnd);
  });

  it('stops when cancelled', async () => {
    mountThreadFixture({ turns: makeTurns(6) });
    const controller = new AbortController();
    const crawl = crawlChatGptThread({ signal: controller.signal, timing: FAST });
    controller.abort();

    await expect(crawl).rejects.toMatchObject({ name: 'AbortError' });
  });
});

describe('ChatGPT selection export on the live thread', () => {
  it('lists every message with stable ids and known roles after preparation', async () => {
    const turns: FixtureTurn[] = [
      ...makeTurns(8),
      { key: 'turn-09', height: 400, user: 'Last prompt' },
    ];
    mountThreadFixture({ turns });

    await expect(prepareChatGptExport({ timing: FAST })).resolves.toBe(true);
    const containers = collectChatGptTurnContainers();

    expect(containers.map((turn) => turn.id)).toEqual(ids(turns));
    expect(containers.map((turn) => turn.sequence)).toEqual(containers.map((_, index) => index));
    expect(containers.every((turn) => turn.role !== 'unknown')).toBe(true);
    expect(containers.find((turn) => turn.id === 'turn-01:u')?.role).toBe('user');
    expect(containers.find((turn) => turn.id === 'turn-01:a')?.role).toBe('assistant');
  });

  it('binds a mounted message to its live element and keeps an unmounted one stable', async () => {
    const fixture = mountThreadFixture({ turns: makeTurns(10) });
    await prepareChatGptExport({ timing: FAST });

    const first = collectChatGptTurnContainers();
    const second = collectChatGptTurnContainers();
    const mounted = new Set(fixture.mountedKeys());
    for (const turn of first) {
      const key = turn.id.slice(0, -2);
      if (mounted.has(key)) expect(turn.container.isConnected).toBe(true);
    }
    expect(second.map((turn) => turn.container)).toEqual(first.map((turn) => turn.container));
  });

  it('offers nothing to select when the crawl cannot prove the thread complete', async () => {
    mountThreadFixture({ turns: makeTurns(8), initiallyLoaded: 3, historyDelayMs: Infinity });

    await expect(prepareChatGptExport({ timing: FAST })).resolves.toBe(true);

    expect(collectChatGptTurnContainers()).toEqual([]);
  });

  it('offers nothing to select on the live thread before it has been crawled', () => {
    mountThreadFixture({ turns: makeTurns(8) });

    expect(collectChatGptTurnContainers()).toEqual([]);
  });

  it('leaves the earlier DOM to its scroll-to-top preparation', async () => {
    document.body.innerHTML = '<main><div data-turn-id-container="a"></div></main>';

    await expect(prepareChatGptExport({ timing: FAST })).resolves.toBe(false);
  });

  it('pairs a prompt with its reply and keeps a lone selection one-sided', async () => {
    const turns: FixtureTurn[] = [
      ...makeTurns(3),
      { key: 'turn-04', height: 400, user: 'Unanswered prompt' },
    ];
    mountThreadFixture({ turns });
    await prepareChatGptExport({ timing: FAST });

    const exported = await buildChatGptExportTurns(
      new Set(['turn-01:u', 'turn-01:a', 'turn-02:a', 'turn-04:u']),
    );

    expect(exported).toHaveLength(3);
    expect(exported[0]).toMatchObject({ user: 'Question 1', assistant: 'Answer 1' });
    expect(exported[1]).toMatchObject({ user: '', assistant: 'Answer 2', omitEmptySections: true });
    expect(exported[1]?.assistantContent?.html).toContain('Answer 2');
    expect(exported[2]).toMatchObject({ user: 'Unanswered prompt', assistant: '' });
    expect(exported[2]?.userContent?.text).toBe('Unanswered prompt');
  });

  it('fails rather than exporting a selection it never read', async () => {
    mountThreadFixture({ turns: makeTurns(3) });
    await prepareChatGptExport({ timing: FAST });

    await expect(buildChatGptExportTurns(new Set(['turn-01:u', 'missing:a']))).rejects.toThrow(
      'chatgpt_export_messages_missing:missing:a',
    );
  });

  it('refuses to export after the reader switches conversations', async () => {
    mountThreadFixture({ turns: makeTurns(3) });
    await prepareChatGptExport({ timing: FAST });

    await expect(
      buildChatGptExportTurns(new Set(['turn-01:u']), {
        expectedUrl: 'https://chatgpt.com/c/another-conversation',
      }),
    ).rejects.toThrow('chatgpt_export_conversation_changed');
  });

  it('resolves roles from the crawl for role-only selection', async () => {
    mountThreadFixture({ turns: makeTurns(2) });
    await prepareChatGptExport({ timing: FAST });

    const roles = await resolveChatGptExportRoles(new Set(['turn-02:u', 'turn-02:a']));

    expect(Object.fromEntries(roles)).toEqual({ 'turn-02:u': 'user', 'turn-02:a': 'assistant' });
  });
});

describe('chatgptIsConversationPage on the live thread', () => {
  it('accepts a rendered turn on a route without a conversation id', () => {
    mountThreadFixture({ turns: makeTurns(1) });

    expect(chatgptIsConversationPage(document, 'https://chatgpt.com/?temporary-chat=true')).toBe(
      true,
    );
  });
});
