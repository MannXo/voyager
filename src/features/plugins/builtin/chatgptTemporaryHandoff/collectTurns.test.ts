import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { DOMContentExtractor } from '@/features/export/services/DOMContentExtractor';
import {
  makeTurns,
  mountThreadFixture,
} from '@/pages/content/export/adapter/__tests__/chatgptThreadFixture';
import type { ExportPlatformAdapter } from '@/pages/content/export/adapter/platformAdapters';

import { collectTemporaryChatTurns } from './index';

const plainAdapter = vi.hoisted(() => ({ current: null as unknown }));

vi.mock('@/pages/content/export/adapter/platformAdapters', () => ({
  resolveExportAdapter: () => plainAdapter.current,
}));

beforeEach(() => {
  history.replaceState({}, '', '/?temporary-chat=true');
  plainAdapter.current = {
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
  } as unknown as ExportPlatformAdapter;
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});

afterEach(() => {
  document.body.replaceChildren();
  history.replaceState({}, '', '/');
  vi.restoreAllMocks();
});

describe('collectTemporaryChatTurns on the current ChatGPT thread', () => {
  it('reads every turn of the virtualized temporary chat', async () => {
    // Short turns: the whole thread fits one window, so the crawl's default
    // timing keeps this quick.
    const turns = makeTurns(4, 200);
    mountThreadFixture({ turns });

    const collected = await collectTemporaryChatTurns(new AbortController().signal);

    expect(collected.map((turn) => [turn.user, turn.assistant])).toEqual(
      turns.map((turn) => [turn.user, turn.assistant]),
    );
  });

  it('refuses a temporary chat whose last prompt is still waiting for its reply', async () => {
    mountThreadFixture({
      turns: [...makeTurns(1, 200), { key: 'turn-02', height: 200, user: 'Unanswered prompt' }],
    });

    await expect(collectTemporaryChatTurns(new AbortController().signal)).rejects.toThrow(
      'chatgpt_export_response_still_generating',
    );
  });
});
