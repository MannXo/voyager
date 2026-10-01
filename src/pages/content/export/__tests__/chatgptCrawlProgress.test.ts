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

const FAST: Partial<ChatGptCrawlTiming> = {
  pollMs: 1,
  settleMs: 4,
  mountTimeoutMs: 400,
  historyIdleMs: 25,
  historyStallMs: 150,
};

function pill(): HTMLElement | null {
  return document.querySelector<HTMLElement>('.gv-export-crawl-progress');
}

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

describe('prepareChatGptExportWithProgress', () => {
  it('counts the turns it reads, then removes itself and uncovers the export pill', async () => {
    const turns = makeTurns(5);
    mountThreadFixture({ turns });
    const exportPill = document.createElement('div');
    exportPill.className = 'gv-export-progress-overlay';
    document.body.appendChild(exportPill);
    const shown: string[] = [];

    await expect(
      prepareChatGptExportWithProgress({
        timing: FAST,
        onProgress: () => {
          expect(exportPill.hidden).toBe(true);
          shown.push(pill()?.textContent ?? '');
        },
      }),
    ).resolves.not.toBeNull();

    expect(shown.at(-1)).toContain('Reading conversation');
    expect(shown.at(-1)).toContain('Turns read: 5');
    expect(pill()).toBeNull();
    expect(exportPill.hidden).toBe(false);
    expect(collectChatGptTurnContainers()).toHaveLength(10);
  });

  it('cancels from its button: restores the scroll, keeps nothing and rejects quietly', async () => {
    const turns = makeTurns(8);
    const fixture = mountThreadFixture({ turns });
    fixture.setOffset(3000);
    const fromEnd = fixture.range() - fixture.offset();
    const onProgress = (count: number) => {
      if (count === 2) pill()?.querySelector<HTMLButtonElement>('.gv-export-crawl-cancel')?.click();
    };

    await expect(
      prepareChatGptExportWithProgress({ timing: FAST, onProgress }),
    ).rejects.toMatchObject({ name: 'AbortError' });
    await new Promise((resolve) => setTimeout(resolve, 10));

    expect(pill()).toBeNull();
    expect(fixture.range() - fixture.offset()).toBe(fromEnd);
    expect(collectChatGptTurnContainers()).toEqual([]);
  });

  it('stops when the export itself is cancelled', async () => {
    mountThreadFixture({ turns: makeTurns(6) });
    const controller = new AbortController();
    const onProgress = (count: number) => {
      if (count === 1) controller.abort();
    };

    await expect(
      prepareChatGptExportWithProgress({ signal: controller.signal, timing: FAST, onProgress }),
    ).rejects.toMatchObject({ name: 'AbortError' });
    expect(pill()).toBeNull();
  });

  it('shows nothing on the earlier DOM, which has no crawl', async () => {
    document.body.innerHTML = '<main><div data-turn-id-container="a"></div></main>';

    await expect(prepareChatGptExportWithProgress({ timing: FAST })).resolves.toBeNull();
    expect(pill()).toBeNull();
  });
});
