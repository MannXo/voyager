import { describe, expect, it } from 'vitest';

import {
  buildResearchPackFilename,
  buildResearchPackMarkdown,
  indexPackSources,
} from '../markdown';
import { addItem, createEmptyPack, setInstruction } from '../packModel';
import type { ResearchPack, ResearchPackDraftItem } from '../types';

const NOW = Date.UTC(2026, 9, 1, 12);

function draft(overrides: Partial<ResearchPackDraftItem>): ResearchPackDraftItem {
  return {
    text: 'Body',
    excerpt: false,
    prompt: '',
    sourceTitle: 'Conversation',
    sourceUrl: 'https://gemini.google.com/app/abc',
    platform: 'gemini',
    citations: [],
    ...overrides,
  };
}

function buildPack(drafts: ResearchPackDraftItem[], instruction = ''): ResearchPack {
  const pack = drafts.reduce(
    (current, item) => addItem(current, item, NOW).pack,
    createEmptyPack(),
  );
  return setInstruction(pack, instruction, NOW);
}

describe('research pack markdown', () => {
  const pack = buildPack(
    [
      draft({
        text: 'First answer with **bold**.',
        prompt: 'Explain   transformers',
        sourceTitle: 'Transformers [intro]',
        citations: [
          { url: 'https://arxiv.org/abs/1706.03762', title: 'Attention Is All You Need' },
          { url: 'https://example.com/blog?utm_source=x', title: '' },
        ],
      }),
      draft({
        text: 'Selected sentence.',
        excerpt: true,
        sourceTitle: 'Follow-up',
        sourceUrl: 'https://gemini.google.com/u/2/app/def',
        citations: [
          { url: 'https://arxiv.org/abs/1706.03762#page=2', title: '' },
          { url: 'https://en.wikipedia.org/wiki/Transformer_(deep_learning)', title: 'Wikipedia' },
        ],
      }),
    ],
    'Compare these with the latest survey.',
  );

  it('numbers each cited URL once across the pack, in first-seen order', () => {
    const { sources, refsByItem } = indexPackSources(pack);

    expect(sources.map((source) => source.url)).toEqual([
      'https://arxiv.org/abs/1706.03762',
      'https://example.com/blog',
      'https://en.wikipedia.org/wiki/Transformer_(deep_learning)',
    ]);
    expect(refsByItem).toEqual([
      [1, 2],
      [1, 3],
    ]);
  });

  it('assembles excerpts, a deduped source list and the instruction last', () => {
    const markdown = buildResearchPackMarkdown(pack, NOW);

    expect(markdown).toContain('_2 excerpts from earlier AI conversations, assembled 2026-10-01._');
    expect(markdown).toContain('## 1. Transformers [intro]');
    expect(markdown).toContain(
      '- From: [Transformers \\[intro\\]](https://gemini.google.com/app/abc) (Gemini)',
    );
    expect(markdown).toContain('- Prompt: Explain transformers');
    expect(markdown).toContain('- Cites: [1], [2]');
    expect(markdown).toContain(
      '- From: [Follow-up](https://gemini.google.com/u/2/app/def) (Gemini)',
    );
    expect(markdown).toContain('- Scope: selected part of the answer');
    expect(markdown).toContain('- Cites: [1], [3]');
    expect(markdown).toContain('1. [Attention Is All You Need](https://arxiv.org/abs/1706.03762)');
    expect(markdown).toContain('2. <https://example.com/blog>');
    expect(markdown).toContain(
      '3. [Wikipedia](https://en.wikipedia.org/wiki/Transformer_%28deep_learning%29)',
    );
    expect(markdown.match(/arxiv\.org\/abs\/1706\.03762/g)).toHaveLength(1);

    const sourcesAt = markdown.indexOf('## Sources');
    const instructionAt = markdown.indexOf('## Instruction');
    expect(markdown.indexOf('First answer with **bold**.')).toBeLessThan(sourcesAt);
    expect(sourcesAt).toBeLessThan(instructionAt);
    expect(markdown.trimEnd().endsWith('Compare these with the latest survey.')).toBe(true);
  });

  it('omits empty sections', () => {
    const markdown = buildResearchPackMarkdown(buildPack([draft({ text: 'Only text' })]), NOW);

    expect(markdown).toContain('_1 excerpt from earlier AI conversations');
    expect(markdown).not.toContain('## Sources');
    expect(markdown).not.toContain('## Instruction');
    expect(markdown).not.toContain('- Cites:');
    expect(markdown).not.toContain('- Prompt:');
  });

  it('names the download by date', () => {
    expect(buildResearchPackFilename(NOW)).toBe('research-pack-2026-10-01.md');
  });
});
