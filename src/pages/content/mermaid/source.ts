/**
 * Check if a code block contains Mermaid syntax and appears complete enough to render
 */
export const isMermaidCode = (code: string): boolean => {
  const codeTrimmed = code.trim();

  // Minimum length to avoid parsing incomplete/streaming content
  if (codeTrimmed.length < 50) return false;

  // Keywords aligned with mermaid's own detector regexes.
  // Order matters: longer/more-specific prefixes should come before shorter ones
  // so that e.g. "flowchart-elk" isn't matched by "flowchart" and missed.
  const keywords = [
    // Core diagram types (v9+)
    'graph',
    'flowchart',
    'sequenceDiagram',
    'classDiagram',
    'stateDiagram',
    'erDiagram',
    'gantt',
    'pie',
    'gitGraph',
    'journey',
    'mindmap',
    'timeline',
    'zenuml',
    'quadrantChart',
    'requirementDiagram',
    'requirement', // v11: requirement(Diagram)? — shorter form
    'sankey-beta',
    'sankey', // v11: sankey(-beta)?
    // C4 diagrams (v9+, often overlooked)
    'C4Context',
    'C4Container',
    'C4Component',
    'C4Dynamic',
    'C4Deployment',
    // New diagram types (v10+/v11+, Chrome/Safari)
    'xychart-beta',
    'xychart', // v11: xychart(-beta)?
    'block-beta',
    'block', // v11: block(-beta)?
    'packet-beta',
    'packet', // v11: packet(-beta)?
    'architecture-beta',
    'architecture', // v11: architecture(-beta)?
    'kanban',
    'radar-beta', // v11
    'treemap', // v11
  ];

  const startsWithKeyword =
    codeTrimmed.startsWith('%%') ||
    keywords.some((keyword) => codeTrimmed.toLowerCase().startsWith(keyword.toLowerCase()));

  if (!startsWithKeyword) return false;

  // Check if code looks complete (has multiple lines and doesn't end mid-statement)
  const lines = codeTrimmed.split('\n').filter((l) => l.trim().length > 0);
  if (lines.length < 3) return false;

  // Check last line doesn't look incomplete (ending with operators or open brackets)
  const lastLine = lines[lines.length - 1].trim();
  const incompleteEndings = ['-->', '---', '-.', '==>', ':::', '[', '(', '{', '|', '&', ','];
  if (incompleteEndings.some((ending) => lastLine.endsWith(ending))) return false;

  return true;
};

const PICTOGRAPHIC = /\p{Extended_Pictographic}/u;
/** Variation selectors and skin-tone modifiers sit between an emoji and its joiner. */
const EMOJI_MODIFIER = /\uFE0F|\p{Emoji_Modifier}/u;

/**
 * A zero-width joiner is only meaningful when it actually joins two emoji, as in
 * a family or flag sequence. Anywhere else it is invisible noise that breaks the
 * Mermaid parser, so it should be stripped like the other zero-width characters.
 */
const joinsEmoji = (source: string, index: number): boolean => {
  // Array.from splits by code point, so an astral emoji stays in one piece.
  const before = Array.from(source.slice(0, index));
  let previous = before.pop();
  while (previous !== undefined && EMOJI_MODIFIER.test(previous)) previous = before.pop();
  const next = Array.from(source.slice(index + 1))[0];
  return (
    previous !== undefined &&
    next !== undefined &&
    PICTOGRAPHIC.test(previous) &&
    PICTOGRAPHIC.test(next)
  );
};

/** Normalize copy/pasted spaces without splitting composed emoji. */
export const normalizeWhitespace = (code: string): string => {
  return (
    code
      // Replace various special space characters with standard space
      .replace(/[\u00A0\u2002\u2003\u2009\u3000]/g, ' ')
      // Remove zero-width characters that can cause issues
      .replace(/[\u200B\u200C\uFEFF]/g, '')
      // Strip stray joiners, but keep the ones holding an emoji sequence together
      .replace(/\u200D/gu, (match, index: number, source: string) =>
        joinsEmoji(source, index) ? match : '',
      )
  );
};

/**
 * Repair a small set of unambiguous Mermaid mistakes commonly produced by
 * models. Keep these rules narrow so valid diagram text is not rewritten.
 */
export const normalizeMermaidCode = (code: string): string => {
  // Convert simple emphasis to Mermaid Markdown because HTML labels are disabled.
  const lines = normalizeWhitespace(code)
    .replace(/<\s*(?:b|strong)\s*>/gi, '**')
    .replace(/<\s*\/\s*(?:b|strong)\s*>/gi, '**')
    .replace(/<\s*(?:i|em)\s*>/gi, '_')
    .replace(/<\s*\/\s*(?:i|em)\s*>/gi, '_')
    .split('\n');
  const hasActivationParticipant = lines.some((line) =>
    /^\s*(?:actor|participant)\s+激活(?:\s+as\b|\s*$)/i.test(line),
  );
  const lastDeactivationByParticipant = new Map<string, number>();

  lines.forEach((line, index) => {
    const match = line.match(/^\s*deactivate\s+(\S+)\s*$/i);
    if (match) lastDeactivationByParticipant.set(match[1], index);
  });

  return lines
    .flatMap((line, index) => {
      const activationMatch = line.match(/^(\s*)激活\s*->>\s*([^:\s]+)\s*:\s*$/);
      if (
        activationMatch &&
        !hasActivationParticipant &&
        (lastDeactivationByParticipant.get(activationMatch[2]) ?? -1) > index
      ) {
        return [`${activationMatch[1]}activate ${activationMatch[2]}`];
      }

      const subgraphMatch = line.match(
        /^(\s*subgraph\s+)([^"[\]\r\n]*\([^"[\]\r\n]*\)[^"[\]\r\n]*)\s*$/i,
      );
      if (subgraphMatch) {
        return [`${subgraphMatch[1]}"${subgraphMatch[2].trim()}"`];
      }

      const trailingCommentMatch = line.match(
        /^(\s*)((?:classDef|class|style|linkStyle)\b.*?;\s*)%%(.*)$/i,
      );
      if (!trailingCommentMatch) return [line];

      const [, indent, statement, comment] = trailingCommentMatch;
      return [`${indent}${statement.trimEnd()}`, `${indent}%%${comment}`];
    })
    .join('\n');
};

/**
 * Generic/non-specific language labels that should still allow Mermaid detection
 * These are labels that don't represent a specific programming language
 */
const GENERIC_LANGUAGE_LABELS = new Set([
  // Arabic
  'مقتطف الرمز',
  // Spanish
  'fragmento de código',
  // French
  'extrait de code',
  // Korean
  '코드 스니펫',
  // Portuguese
  'snippet de código',
  // Russian
  'фрагмент кода',
  // Simplified Chinese
  '代码段',
  '代码',
  '代码块',
  '示例',
  '示例代码',
  // Traditional Chinese
  '程式碼片段',
  // Japanese
  'コード スニペット',
  // English
  'code',
  'code snippet',
  'snippet',
  'example',
  'code example',
  'sample',
  // Common generic terms
  'text',
  'plain',
  'plaintext',
  'raw',
  'output',
  'result',
]);

/**
 * Check if a language label is generic (not a specific programming language)
 */
export const isGenericLanguageLabel = (language: string | null): boolean => {
  if (!language) return true; // No label = generic
  return GENERIC_LANGUAGE_LABELS.has(language.toLowerCase());
};
