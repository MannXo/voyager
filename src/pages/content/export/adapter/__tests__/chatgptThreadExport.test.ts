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
  mountTimeoutMs: 400,
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

function nextTask(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

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

  it('waits for a window that renders later than it would otherwise count as settled', async () => {
    // Slower than the settle interval and than the top of the thread takes to
    // look idle, so the reader's window is still mounted when the walk starts.
    const turns = makeTurns(8);
    mountThreadFixture({ turns, renderDelayMs: 40 });

    const messages = await crawlChatGptThread({ timing: FAST });

    expect(messages.map((message) => message.id)).toEqual(ids(turns));
  });

  it('fails instead of reading a stale window that never moves to the scroll position', async () => {
    const fixture = mountThreadFixture({ turns: makeTurns(8), renderDelayMs: Infinity });
    expect(fixture.mountedKeys()).not.toContain('turn-01');

    await expect(crawlChatGptThread({ timing: FAST })).rejects.toThrow(
      'chatgpt_export_thread_unsettled',
    );
  });

  it('fails when a branch switch changes a turn it already read, rather than mixing branches', async () => {
    const fixture = mountThreadFixture({ turns: makeTurns(8) });
    let switched = false;
    const onProgress = (count: number) => {
      if (count < 3 || switched) return;
      switched = true;
      // Regenerating turn 3 keeps its key (the prompt's id) but swaps the
      // reply, and every later turn with it.
      fixture.replaceTurn('turn-03', { replyId: 'turn-03-b', assistant: 'Answer 3, branch 2' });
      fixture.replaceTurn('turn-04', { replyId: 'turn-04-b', assistant: 'Answer 4, branch 2' });
    };

    await expect(crawlChatGptThread({ timing: FAST, onProgress })).rejects.toThrow(
      'chatgpt_export_thread_changed',
    );
    expect(switched).toBe(true);
  });

  it('reports how many turns it has read', async () => {
    const turns = makeTurns(5);
    mountThreadFixture({ turns });
    const counts: number[] = [];

    await crawlChatGptThread({ timing: FAST, onProgress: (count) => counts.push(count) });

    expect(counts).toEqual([1, 2, 3, 4, 5]);
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

  it('stays cancelled when cancelled while it restores the scroll position', async () => {
    const turns = makeTurns(6);
    const fixture = mountThreadFixture({ turns });
    const controller = new AbortController();
    const onProgress = (count: number) => {
      if (count === turns.length) controller.abort();
    };

    await expect(
      crawlChatGptThread({ signal: controller.signal, timing: FAST, onProgress }),
    ).rejects.toMatchObject({ name: 'AbortError' });
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(fixture.offset()).toBe(fixture.range());
  });
});

describe('ChatGPT selection export on the live thread', () => {
  it('lists every message with stable ids and known roles after preparation', async () => {
    const turns: FixtureTurn[] = [
      ...makeTurns(8),
      { key: 'turn-09', height: 400, user: 'Last prompt' },
    ];
    mountThreadFixture({ turns });

    await expect(prepareChatGptExport({ timing: FAST })).resolves.not.toBeNull();
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

    await expect(prepareChatGptExport({ timing: FAST })).resolves.not.toBeNull();

    expect(collectChatGptTurnContainers()).toEqual([]);
  });

  it('offers nothing to select on the live thread before it has been crawled', () => {
    mountThreadFixture({ turns: makeTurns(8) });

    expect(collectChatGptTurnContainers()).toEqual([]);
  });

  it('leaves the earlier DOM to its scroll-to-top preparation', async () => {
    document.body.innerHTML = '<main><div data-turn-id-container="a"></div></main>';

    await expect(prepareChatGptExport({ timing: FAST })).resolves.toBeNull();
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

  it('drops the crawl once a mounted turn switches branch after it was read', async () => {
    const fixture = mountThreadFixture({ turns: makeTurns(6) });
    await prepareChatGptExport({ timing: FAST });
    expect(collectChatGptTurnContainers()).toHaveLength(12);

    // The reader regenerates the last reply, which keeps its turn key.
    fixture.replaceTurn('turn-06', { replyId: 'turn-06-b', assistant: 'Answer 6, branch 2' });

    await expect(buildChatGptExportTurns(new Set(['turn-06:a']))).rejects.toThrow(
      'chatgpt_export_thread_changed',
    );
    expect(collectChatGptTurnContainers()).toEqual([]);
  });

  it("drops the crawl once the reader switches to an edited prompt's branch of the same length", async () => {
    const fixture = mountThreadFixture({ turns: makeTurns(6) });
    await prepareChatGptExport({ timing: FAST });

    // Editing turn 5's prompt gives it and every later turn new keys.
    fixture.switchBranch('turn-05', [
      { key: 'edit-05', height: 1500, user: 'Question 5, edited', assistant: 'Answer 5, edited' },
      { key: 'edit-06', height: 1500, user: 'Question 6, edited', assistant: 'Answer 6, edited' },
    ]);

    await expect(buildChatGptExportTurns(new Set(['turn-05:u']))).rejects.toThrow(
      'chatgpt_export_thread_changed',
    );
    expect(collectChatGptTurnContainers()).toEqual([]);
  });

  it('drops the crawl when a turn switches branch and scrolls out of view before the export', async () => {
    const fixture = mountThreadFixture({ turns: makeTurns(10) });
    await prepareChatGptExport({ timing: FAST });
    const bottom = fixture.offset();

    fixture.setOffset(0);
    await nextTask();
    fixture.replaceTurn('turn-01', { replyId: 'turn-01-b', assistant: 'Answer 1, branch 2' });
    await nextTask();
    fixture.setOffset(bottom);
    expect(fixture.mountedKeys()).not.toContain('turn-01');

    await expect(buildChatGptExportTurns(new Set(['turn-01:a']))).rejects.toThrow(
      'chatgpt_export_thread_changed',
    );
  });

  it('drops the crawl when a turn re-renders as another branch and unmounts in the same task', async () => {
    const fixture = mountThreadFixture({ turns: makeTurns(10) });
    await prepareChatGptExport({ timing: FAST });
    const bottom = fixture.offset();
    fixture.setOffset(0);
    await nextTask();

    fixture.replaceTurn('turn-01', { replyId: 'turn-01-b', assistant: 'Answer 1, branch 2' });
    fixture.setOffset(bottom);
    expect(fixture.mountedKeys()).not.toContain('turn-01');
    // The observer delivers both changes together, after the item is gone.
    await nextTask();

    await expect(buildChatGptExportTurns(new Set(['turn-01:a']))).rejects.toThrow(
      'chatgpt_export_thread_changed',
    );
  });

  it("drops the crawl when a turn's ids change in place and it unmounts in the same task", async () => {
    const fixture = mountThreadFixture({ turns: makeTurns(10) });
    await prepareChatGptExport({ timing: FAST });
    const bottom = fixture.offset();
    fixture.setOffset(0);
    await nextTask();

    const reply = fixture.main.querySelector(
      '[data-turn-key="turn-01"] [data-chatgpt-selection-message-id]',
    )!;
    reply.setAttribute('data-chatgpt-selection-message-id', 'turn-01-b');
    reply.parentElement!.setAttribute('data-chatgpt-search-message-ids', 'turn-01-b');
    fixture.setOffset(bottom);
    expect(fixture.mountedKeys()).not.toContain('turn-01');

    await expect(buildChatGptExportTurns(new Set(['turn-01:a']))).rejects.toThrow(
      'chatgpt_export_thread_changed',
    );
  });

  it('drops the crawl when an unread turn mounts inside a wrapper and leaves in the same task', async () => {
    const fixture = mountThreadFixture({ turns: makeTurns(4) });
    await prepareChatGptExport({ timing: FAST });

    const list = fixture.main.querySelector('[data-turn-key]')!.parentElement!;
    const wrapper = document.createElement('div');
    wrapper.innerHTML = '<div data-turn-key="edit-04"><p>Edited prompt</p></div>';
    list.appendChild(wrapper);
    wrapper.remove();

    await expect(buildChatGptExportTurns(new Set(['turn-04:a']))).rejects.toThrow(
      'chatgpt_export_thread_changed',
    );
  });

  it('keeps the crawl when turns mount and unmount in the same task without changing', async () => {
    const fixture = mountThreadFixture({ turns: makeTurns(10) });
    await prepareChatGptExport({ timing: FAST });
    const bottom = fixture.offset();

    fixture.setOffset(0);
    fixture.setOffset(bottom / 2);
    fixture.setOffset(bottom);
    await nextTask();

    expect(collectChatGptTurnContainers()).toHaveLength(20);
    await expect(buildChatGptExportTurns(new Set(['turn-01:a']))).resolves.toHaveLength(1);
  });

  it('drops the crawl when a turn it read switches branch mid-crawl and is never revisited', async () => {
    // Short turns: several share a window, so an early one leaves before the next read.
    const fixture = mountThreadFixture({ turns: makeTurns(20, 300), overscan: 0 });
    let switched = '';
    const onProgress = (count: number) => {
      if (switched || count !== 5) return;
      // A turn the crawl has read, still on screen, but not the one it continues from.
      const read = new Set(makeTurns(count).map((turn) => turn.key));
      const tail = makeTurns(count).at(-1)?.key;
      switched = fixture.mountedKeys().find((key) => read.has(key) && key !== tail) ?? '';
      if (switched) fixture.replaceTurn(switched, { replyId: `${switched}-b` });
    };

    await prepareChatGptExport({ timing: FAST, onProgress });

    expect(switched).not.toBe('');
    expect(collectChatGptTurnContainers()).toEqual([]);
  });

  it('does not let a superseded preparation publish over a newer one that failed', async () => {
    mountThreadFixture({ turns: makeTurns(8) });
    let newer: ReturnType<typeof prepareChatGptExport> | null = null;
    const onProgress = (count: number) => {
      if (count !== 2 || newer) return;
      // A newer export starts mid-crawl on the same route and fails at once.
      const main = document.querySelector<HTMLElement>('[data-app-shell-active-page] main')!;
      main.insertAdjacentHTML('beforeend', '<button data-testid="stop-button"></button>');
      newer = prepareChatGptExport({ timing: FAST });
      main.querySelector('[data-testid="stop-button"]')!.remove();
    };

    await expect(prepareChatGptExport({ timing: FAST, onProgress })).resolves.not.toBeNull();
    await expect(newer).resolves.not.toBeNull();

    expect(collectChatGptTurnContainers()).toEqual([]);
  });

  it('does not publish a preparation cancelled while it restores the scroll position', async () => {
    const turns = makeTurns(6);
    mountThreadFixture({ turns });
    const controller = new AbortController();
    const onProgress = (count: number) => {
      if (count === turns.length) controller.abort();
    };

    await expect(
      prepareChatGptExport({ signal: controller.signal, timing: FAST, onProgress }),
    ).rejects.toMatchObject({ name: 'AbortError' });

    expect(collectChatGptTurnContainers()).toEqual([]);
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
