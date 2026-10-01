/**
 * Assemble a research pack into portable Markdown.
 *
 * The scaffolding is English on purpose: the reader is another model, and a
 * fixed structure keeps the pack predictable whatever language the excerpts
 * are in. The instruction goes last so the receiving model reads the context
 * before the task.
 */
import type { ResearchPack, ResearchPackCitation } from './types';

const PLATFORM_LABELS: Readonly<Record<string, string>> = {
  gemini: 'Gemini',
  aistudio: 'AI Studio',
  chatgpt: 'ChatGPT',
  claude: 'Claude',
};

export interface PackSourceEntry extends ResearchPackCitation {
  /** 1-based position in the pack-wide source list. */
  index: number;
}

export interface PackSourceIndex {
  sources: PackSourceEntry[];
  /** For each item (by position), the pack-wide numbers of the sources it cites. */
  refsByItem: number[][];
}

/**
 * Number every cited URL once across the whole pack, in first-seen order, and
 * record which numbers each item cites. A URL cited by three answers appears
 * once in the list and is referenced from all three.
 */
export function indexPackSources(pack: ResearchPack): PackSourceIndex {
  const byUrl = new Map<string, PackSourceEntry>();
  const refsByItem = pack.items.map((item) => {
    const refs: number[] = [];
    for (const citation of item.citations) {
      let entry = byUrl.get(citation.url);
      if (!entry) {
        entry = { ...citation, index: byUrl.size + 1 };
        byUrl.set(citation.url, entry);
      } else if (!entry.title && citation.title) {
        entry.title = citation.title;
      }
      if (!refs.includes(entry.index)) refs.push(entry.index);
    }
    return refs;
  });
  return { sources: Array.from(byUrl.values()), refsByItem };
}

function escapeLinkText(text: string): string {
  return text.replace(/([\\[\]])/g, '\\$1').replace(/\s+/g, ' ');
}

function escapeLinkUrl(url: string): string {
  return url.replace(/\(/g, '%28').replace(/\)/g, '%29').replace(/ /g, '%20');
}

function link(title: string, url: string): string {
  if (!url) return escapeLinkText(title);
  if (!title) return `<${escapeLinkUrl(url)}>`;
  return `[${escapeLinkText(title)}](${escapeLinkUrl(url)})`;
}

function formatDate(now: number): string {
  return new Date(now).toISOString().slice(0, 10);
}

export function platformLabel(platform: string): string {
  return PLATFORM_LABELS[platform] ?? platform;
}

export function buildResearchPackMarkdown(pack: ResearchPack, now: number): string {
  const { sources, refsByItem } = indexPackSources(pack);
  const count = pack.items.length;
  const lines: string[] = [
    '# Research pack',
    '',
    `_${count} ${count === 1 ? 'excerpt' : 'excerpts'} from earlier AI conversations, assembled ${formatDate(now)}._`,
    '',
    'Treat the excerpts as context to check, not as established fact. Numbers in square brackets refer to the source list.',
  ];

  pack.items.forEach((item, position) => {
    const title = item.sourceTitle || `Answer ${position + 1}`;
    lines.push('', `## ${position + 1}. ${title.replace(/\s+/g, ' ')}`, '');
    lines.push(`- From: ${link(title, item.sourceUrl)} (${platformLabel(item.platform)})`);
    if (item.prompt) lines.push(`- Prompt: ${item.prompt}`);
    if (item.excerpt) lines.push('- Scope: selected part of the answer');
    const refs = refsByItem[position];
    if (refs.length > 0) lines.push(`- Cites: ${refs.map((ref) => `[${ref}]`).join(', ')}`);
    lines.push('', item.text);
  });

  if (sources.length > 0) {
    lines.push('', '## Sources', '');
    for (const source of sources) {
      lines.push(`${source.index}. ${link(source.title, source.url)}`);
    }
  }

  const instruction = pack.instruction.trim();
  if (instruction) {
    lines.push('', '## Instruction', '', instruction);
  }

  return `${lines.join('\n')}\n`;
}

/** Filesystem-safe download name, e.g. `research-pack-2026-10-01.md`. */
export function buildResearchPackFilename(now: number): string {
  return `research-pack-${formatDate(now)}.md`;
}
