import { beforeEach, describe, expect, it } from 'vitest';

import { resolveExportAdapter } from '@/pages/content/export/adapter/platformAdapters';

import { DEFAULT_EXPORT_SPEAKER_LABELS } from '../../types/export';
import type { ExtractedContent } from '../DOMContentExtractor';
import { DOMContentExtractor } from '../DOMContentExtractor';
import { createPDFDocumentTurn, createPDFPrintContainer } from '../pdfPrintDocument';

DOMContentExtractor.setExportAdapter(resolveExportAdapter());

describe('PDF print document construction', () => {
  const metadata = {
    url: 'https://gemini.google.com/app/abcdefghijk',
    exportedAt: '2025-01-15T10:30:00.000Z',
    count: 1,
    title: 'Document title',
  };
  const captured: ExtractedContent = {
    html: '<p>Captured content</p>',
    text: 'Captured content',
    attachments: [],
    hasImages: false,
    hasFormulas: false,
    hasTables: false,
    hasCode: false,
  };

  beforeEach(() => {
    document.body.innerHTML = '';
    document.title = 'Gemini';
  });

  it('prefers captured rich content over changed live elements and plain text', () => {
    const stale = document.createElement('div');
    stale.textContent = 'Changed after capture';
    const container = createPDFPrintContainer(
      [
        {
          user: 'Plain user',
          assistant: 'Plain assistant',
          starred: true,
          userContent: captured,
          assistantContent: {
            ...captured,
            html: '<table><tr><td>Captured table</td></tr></table>',
          },
          userElement: stale,
          assistantElement: stale,
        },
      ],
      metadata,
      DEFAULT_EXPORT_SPEAKER_LABELS,
    );
    expect(container.querySelector('.gv-print-turn-user p')?.textContent).toBe('Captured content');
    expect(container.querySelector('.gv-print-turn-assistant td')?.textContent).toBe(
      'Captured table',
    );
    expect(container.textContent).not.toContain('Changed after capture');
    expect(container.textContent).not.toContain('Plain user');
    expect(container.textContent).not.toContain('Plain assistant');
    expect(container.querySelector('.gv-print-turn-starred .gv-print-star')?.textContent).toBe(
      '⭐',
    );
    expect(container.isConnected).toBe(false);
  });

  it('falls back to live rich content when captured HTML is empty', () => {
    const live = document.createElement('div');
    live.innerHTML =
      '<message-content><div class="markdown"><p>Live response</p></div></message-content>';
    const container = createPDFPrintContainer(
      [
        {
          user: '',
          assistant: 'Plain response',
          starred: false,
          omitEmptySections: true,
          assistantContent: { ...captured, html: '' },
          assistantElement: live,
        },
      ],
      metadata,
      DEFAULT_EXPORT_SPEAKER_LABELS,
    );
    expect(container.querySelector('.gv-print-turn-user')).toBeNull();
    expect(container.querySelector('.gv-print-turn-assistant p')?.textContent).toBe(
      'Live response',
    );
    expect(container.textContent).not.toContain('Plain response');
  });

  it('escapes plain text while preserving paragraphs, line breaks and turn order', () => {
    const container = createPDFPrintContainer(
      [
        { user: '<b>First</b>\nSecond\n\nThird', assistant: '', starred: false },
        { user: '', assistant: 'Last', starred: false, omitEmptySections: true },
      ],
      { ...metadata, count: 2 },
      DEFAULT_EXPORT_SPEAKER_LABELS,
    );
    const first = container.querySelector('.gv-print-turn-user .gv-print-turn-text')!;
    expect(first.querySelector('b')).toBeNull();
    expect(first.querySelectorAll('p')).toHaveLength(2);
    expect(first.querySelectorAll('br')).toHaveLength(1);
    expect(first.textContent).toBe('<b>First</b>SecondThird');
    expect(container.querySelectorAll('.gv-print-turn-user')).toHaveLength(1);
    expect(container.querySelector('.gv-print-turn-assistant em')?.textContent).toBe('No content');
    expect(
      Array.from(container.querySelectorAll('.gv-print-turn-number'), (node) => node.textContent),
    ).toEqual(['Turn 1', 'Turn 2']);
    expect(container.querySelector('.gv-print-meta a')?.textContent).toBe(
      'Gemini Conversation abcdefgh',
    );
    expect(container.querySelector('.gv-print-footer')?.textContent).toContain(
      '2 conversation turns',
    );
  });

  it('keeps sections backed by a captured record even when their content is empty', () => {
    const container = createPDFPrintContainer(
      [
        {
          user: '',
          assistant: '',
          starred: false,
          omitEmptySections: true,
          userContent: { ...captured, html: '', text: '' },
        },
      ],
      metadata,
      DEFAULT_EXPORT_SPEAKER_LABELS,
    );
    expect(container.querySelector('.gv-print-turn-user em')?.textContent).toBe('No content');
    expect(container.querySelector('.gv-print-turn-assistant')).toBeNull();
  });

  it.each([
    [
      '<script>ignore</script><style>ignore</style><template>ignore</template><p> Body \r\n\n\nMore </p>',
      'Markdown',
      'Body\n\nMore',
    ],
    ['<style>ignore</style>', '  Markdown fallback  ', 'Markdown fallback'],
    ['', '   ', 'No content'],
  ])(
    'derives document fallback text from HTML, then Markdown, then the empty label',
    (html, markdown, expected) => {
      const turn = createPDFDocumentTurn(html, markdown);
      expect(turn.assistant).toBe(expected);
      expect(turn.user).toBe('');
      expect(turn.omitEmptySections).toBe(true);
      expect(turn.assistantElement?.innerHTML).toBe(html.trim().replace(/\r\n/g, '\n'));
    },
  );
});
