import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { DOMContentExtractor } from '@/features/export/services/DOMContentExtractor';

import { makeTurns, mountThreadFixture } from '../adapter/__tests__/chatgptThreadFixture';
import type { ChatGptCrawlTiming } from '../adapter/chatgptCrawl';
import {
  collectChatGptTurnContainers,
  resetChatGptThreadSnapshot,
} from '../adapter/chatgptThreadExport';
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
 * The ChatGPT export adapter's preparation, crawling at test speed.
 * `onProgress` lets a test act mid-crawl.
 */
function chatGptAdapter(
  onProgress?: (turns: number) => void,
): Pick<ExportPlatformAdapter, 'prepareConversation'> {
  return {
    prepareConversation: (options) =>
      prepareChatGptExportWithProgress({ ...options, timing: FAST, onProgress }),
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

  it('leaves the export that replaced one cancelled during its scroll restore intact', async () => {
    const turns = makeTurns(6);
    mountThreadFixture({ turns });
    const first = new AbortController();
    let second: Promise<void> | null = null;
    let firstEnded: Promise<unknown> = Promise.resolve();
    const seen = { listed: 0, observing: 0 };
    const startSecond = () =>
      runPreparedExport(
        chatGptAdapter(),
        { expectedUrl: location.href },
        {
          scrollToTop: async () => {},
          exportSelection: async () => {
            // The cancelled export's cleanup has run by now.
            await firstEnded;
            seen.listed = collectChatGptTurnContainers().length;
            seen.observing = observing.size;
          },
        },
      );
    // Export B starts once A has read everything: A is cancelled and restores the scroll.
    const adapter = chatGptAdapter((count) => {
      if (count !== turns.length || second) return;
      first.abort();
      second = startSecond();
    });

    firstEnded = runPreparedExport(
      adapter,
      { signal: first.signal, expectedUrl: location.href },
      { scrollToTop: async () => {}, exportSelection: async () => {} },
    ).catch((error: unknown) => error);

    await expect(firstEnded).resolves.toMatchObject({ name: 'AbortError' });
    await second;
    expect(seen).toEqual({ listed: 12, observing: 1 });
    expect(observing.size).toBe(0);
  });

  it('ignores a release from a preparation that a newer one replaced', async () => {
    mountThreadFixture({ turns: makeTurns(3) });
    const older = await prepareChatGptExportWithProgress({ timing: FAST });
    const newer = await prepareChatGptExportWithProgress({ timing: FAST });

    older?.release();
    expect(collectChatGptTurnContainers()).toHaveLength(6);
    expect(observing.size).toBe(1);

    newer?.release();
    expect(collectChatGptTurnContainers()).toEqual([]);
    expect(observing.size).toBe(0);
  });

  it('does not open selection when the export is cancelled while scrolling to the top', async () => {
    const controller = new AbortController();
    const exportSelection = vi.fn(async () => {});

    await expect(
      runPreparedExport(
        { prepareConversation: async () => null },
        { signal: controller.signal, expectedUrl: location.href },
        { scrollToTop: async () => controller.abort(), exportSelection },
      ),
    ).rejects.toMatchObject({ name: 'AbortError' });

    expect(exportSelection).not.toHaveBeenCalled();
  });

  it('scrolls to the top when the adapter does not prepare the conversation itself', async () => {
    const steps: string[] = [];

    await runPreparedExport(
      { prepareConversation: async () => null },
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

    expect(steps).toEqual(['scroll', 'select']);
  });
});
