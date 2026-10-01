import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { DOMContentExtractor } from '@/features/export/services/DOMContentExtractor';
import type { SiteAdapter } from '@/features/plugins/types';

import { makeTurns, mountThreadFixture } from '../adapter/__tests__/chatgptThreadFixture';
import type { ChatGptCrawlTiming } from '../adapter/chatgptCrawl';
import {
  collectChatGptTurnContainers,
  resetChatGptThreadSnapshot,
} from '../adapter/chatgptThreadExport';
import { buildChatGptAdapter } from '../adapter/platform/chatgpt';
import type { ExportPlatformAdapter } from '../adapter/platformAdapters';
import { prepareChatGptExportWithProgress } from '../chatgptCrawlProgress';
import { runPreparedExport } from '../preparedExport';

const FAST: Partial<ChatGptCrawlTiming> = {
  pollMs: 1,
  settleMs: 4,
  mountTimeoutMs: 400,
  historyIdleMs: 25,
  historyStallMs: 150,
};

/** Observers that are observing right now. */
const observing = new Set<MutationObserver>();

class TrackedMutationObserver extends MutationObserver {
  override observe(target: Node, options?: MutationObserverInit): void {
    observing.add(this);
    super.observe(target, options);
  }

  override disconnect(): void {
    observing.delete(this);
    super.disconnect();
  }
}

/**
 * The ChatGPT export adapter's preparation and release, crawling at test speed.
 * `onProgress` lets a test act mid-crawl.
 */
function chatGptAdapter(
  onProgress?: (turns: number) => void,
): Pick<ExportPlatformAdapter, 'prepareConversation' | 'releaseConversation'> {
  const adapter = buildChatGptAdapter({
    selectors: { userTurn: '[data-turn-key]', assistantTurn: '[data-turn-key]' },
  } as unknown as SiteAdapter);
  return {
    // The adapter's own preparation, given test timing it does not expose.
    prepareConversation: (options) =>
      prepareChatGptExportWithProgress({ ...options, timing: FAST, onProgress }),
    releaseConversation: adapter.releaseConversation,
  };
}

beforeEach(() => {
  document.body.replaceChildren();
  resetChatGptThreadSnapshot();
  observing.clear();
  vi.stubGlobal('MutationObserver', TrackedMutationObserver);
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
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('runPreparedExport', () => {
  it('watches the ChatGPT thread during selection and stops once the session ends', async () => {
    mountThreadFixture({ turns: makeTurns(4) });
    let observedDuringSelection = 0;
    let listed = 0;

    await runPreparedExport(
      chatGptAdapter(),
      { expectedUrl: location.href },
      {
        scrollToTop: async () => {},
        // The session ends by export, Cancel, Escape or teardown alike: it resolves.
        exportSelection: async () => {
          observedDuringSelection = observing.size;
          listed = collectChatGptTurnContainers().length;
        },
      },
    );

    expect(observedDuringSelection).toBeGreaterThan(0);
    expect(listed).toBe(8);
    expect(observing.size).toBe(0);
    expect(collectChatGptTurnContainers()).toEqual([]);
  });

  it('stops watching the ChatGPT thread when the session fails', async () => {
    mountThreadFixture({ turns: makeTurns(4) });

    await expect(
      runPreparedExport(
        chatGptAdapter(),
        { expectedUrl: location.href },
        {
          scrollToTop: async () => {},
          exportSelection: async () => {
            throw new Error('export failed');
          },
        },
      ),
    ).rejects.toThrow('export failed');

    expect(observing.size).toBe(0);
  });

  it('leaves no watch behind when the crawl is cancelled', async () => {
    const turns = makeTurns(6);
    mountThreadFixture({ turns });
    const controller = new AbortController();
    const adapter = chatGptAdapter((count) => {
      if (count === 2) controller.abort();
    });
    const exportSelection = vi.fn(async () => {});

    await expect(
      runPreparedExport(
        adapter,
        { signal: controller.signal, expectedUrl: location.href },
        { scrollToTop: async () => {}, exportSelection },
      ),
    ).rejects.toMatchObject({ name: 'AbortError' });

    expect(exportSelection).not.toHaveBeenCalled();
    expect(observing.size).toBe(0);
  });

  it('does not open selection when the export is cancelled while scrolling to the top', async () => {
    const controller = new AbortController();
    const exportSelection = vi.fn(async () => {});
    const releaseConversation = vi.fn();

    await expect(
      runPreparedExport(
        { prepareConversation: async () => false, releaseConversation },
        { signal: controller.signal, expectedUrl: location.href },
        { scrollToTop: async () => controller.abort(), exportSelection },
      ),
    ).rejects.toMatchObject({ name: 'AbortError' });

    expect(exportSelection).not.toHaveBeenCalled();
    expect(releaseConversation).toHaveBeenCalledOnce();
  });

  it('scrolls to the top when the adapter does not prepare the conversation itself', async () => {
    const steps: string[] = [];

    await runPreparedExport(
      {
        prepareConversation: async () => false,
        releaseConversation: () => steps.push('release'),
      },
      { expectedUrl: location.href },
      {
        scrollToTop: async () => {
          steps.push('scroll');
        },
        exportSelection: async () => {
          steps.push('select');
        },
      },
    );

    expect(steps).toEqual(['scroll', 'select', 'release']);
  });
});
