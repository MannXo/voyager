/**
 * DOM Content Extractor
 * Extracts rich content from Gemini's DOM structure preserving formatting
 */
import type { ExportPlatformAdapter } from '../../../pages/content/export/adapter/platformAdapters';
import type { ExportAttachment } from '../types/export';
import {
  findExportCodeBlocks,
  extractExportCodeBlock,
  extractCodeBlock,
  extractCodeFromCodeElement,
  serializeListHtml,
} from './exportCodeBlocks';
import {
  shouldSkipElement,
  stripExportArtifacts,
  normalizeText,
  escapeHtml,
  escapeHtmlAttribute,
} from './exportDomPolicy';

export interface ExtractedContent {
  text: string;
  html: string;
  attachments: ExportAttachment[];
  hasImages: boolean;
  hasFormulas: boolean;
  hasTables: boolean;
  hasCode: boolean;
}

export interface ExtractedTurn {
  user: ExtractedContent;
  assistant: ExtractedContent;
  starred: boolean;
}

/**
 * Extracts structured content from Gemini's DOM
 * Preserves formatting including LaTeX formulas, code blocks, tables, etc.
 */

/**
 * querySelector variant that skips elements nested inside model-thoughts / thoughts-container.
 * When the user expands Gemini's "thinking" section, a second `message-content` element
 * appears *before* the real response in DOM order.  A plain `querySelector` would match
 * the thinking panel first, causing exports to grab the wrong content.
 */
function queryOutsideThoughts<T extends Element = Element>(
  root: Element,
  selector: string,
): T | null {
  const candidates = root.querySelectorAll<T>(selector);
  for (const el of Array.from(candidates)) {
    if (!el.closest('model-thoughts, .thoughts-container, .thoughts-content')) {
      return el;
    }
  }
  return null;
}

interface SerializedTableCell {
  text: string;
  hasFormulas: boolean;
}

interface SerializedTable {
  rows: string[][];
  hasFormulas: boolean;
}

interface ProcessedInlineContent {
  html: string;
  text: string;
  hasFormulas: boolean;
  hasLeadingWhitespace: boolean;
  hasTrailingWhitespace: boolean;
}

export class DOMContentExtractor {
  private static DEBUG = false;
  private static exportAdapter: ExportPlatformAdapter;

  /**
   * Set the export adapter.
   * @param adapter - The export adapter.
   */
  static setExportAdapter(adapter: ExportPlatformAdapter) {
    this.exportAdapter = adapter;
  }

  /**
   * Extract user query content.
   * @param imageSelectors - Platform-specific selectors for finding images.
   *   Empty/omitted = use Gemini's built-in selectors only.
   */
  static extractUserContent(element: HTMLElement): ExtractedContent {
    const result: ExtractedContent = {
      text: '',
      html: '',
      attachments: [],
      hasImages: false,
      hasFormulas: false,
      hasTables: false,
      hasCode: false,
    };

    const images = this.exportAdapter.extractUserImage(element) ?? [];
    result.hasImages = images.length > 0;

    const attachments = this.extractUserAttachments(element);
    result.attachments = attachments;

    // Extract user message text. Each platform exposes its own DOM shape
    // (Gemini's .query-text-line paragraphs vs. ChatGPT's plain text node),
    // so the actual extraction strategy is delegated to the platform adapter.
    const textLines = element.querySelectorAll<HTMLElement>('.query-text-line');
    const textParts: string[] = [];
    this.exportAdapter.extractUserText(textLines, textParts, element);

    result.text = textParts.join('\n');

    // Build HTML representation
    const htmlParts: string[] = [];

    // Add image markdown
    const imageMarkdown: string[] = [];
    images.forEach((img, index) => {
      const src = (img as HTMLImageElement).src;
      const alt = (img as HTMLImageElement).alt || `Uploaded image ${index + 1}`;
      htmlParts.push(
        `<img src="${this.escapeHtmlAttribute(src)}" alt="${this.escapeHtmlAttribute(alt)}" />`,
      );
      imageMarkdown.push(`![${alt}](${src})`);
    });

    attachments.forEach((attachment) => {
      htmlParts.push(
        `<div class="gv-export-attachment"><span class="gv-export-attachment-icon" aria-hidden="true">📄</span><span class="gv-export-attachment-name">${this.escapeHtml(attachment.name)}</span></div>`,
      );
    });

    // Combine image markdown and text
    const allTextParts: string[] = [];
    if (imageMarkdown.length > 0) {
      allTextParts.push(imageMarkdown.join('\n\n'));
    }
    if (attachments.length > 0) {
      allTextParts.push(attachments.map(({ name }) => `📎 ${name}`).join('\n'));
    }
    if (textParts.length > 0) {
      allTextParts.push(textParts.join('\n'));
    }
    result.text = allTextParts.join('\n\n');

    // Add text paragraphs to HTML
    textParts.forEach((text) => {
      htmlParts.push(`<p>${this.escapeHtml(text).replace(/\n/g, '<br />')}</p>`);
    });

    result.html = htmlParts.join('\n');

    return result;
  }

  /**
   * Extract assistant response content with rich formatting
   */
  static extractAssistantContent(element: HTMLElement): ExtractedContent {
    if (this.DEBUG)
      console.log('[DOMContentExtractor] extractAssistantContent called, element:', element);

    const result: ExtractedContent = {
      text: '',
      html: '',
      attachments: [],
      hasImages: false,
      hasFormulas: false,
      hasTables: false,
      hasCode: false,
    };

    // Prefer the message-content we were given. querySelector skips the root, so
    // passing <message-content> used to collapse onto an inner .markdown and
    // drop sibling search/generated images (copy-as-image illustrations).
    const givenMessageContent =
      element.tagName.toLowerCase() === 'message-content' &&
      !element.closest('model-thoughts, .thoughts-container, .thoughts-content')
        ? element
        : null;
    let messageContent = givenMessageContent || queryOutsideThoughts(element, 'message-content');

    if (!messageContent) {
      messageContent = queryOutsideThoughts(
        element,
        '.markdown-main-panel, .markdown, .model-response-text',
      );
    }

    if (
      !messageContent &&
      (element.classList.contains('markdown') ||
        element.tagName.toLowerCase() === 'message-content')
    ) {
      messageContent = element;
    }

    if (!messageContent) {
      // Last resort: use element directly
      console.warn('[DOMContentExtractor] Response container not found, using element directly');
      messageContent = element;
    }

    if (this.DEBUG)
      console.log(
        '[DOMContentExtractor] Using container:',
        messageContent.tagName,
        messageContent.className,
      );

    // Don't clone! Angular custom elements may lose content when cloned
    // Instead, skip model-thoughts during processNodes
    const htmlParts: string[] = [];
    const textParts: string[] = [];
    const processedImageSrcs = new Set<string>();

    const markdownDiv = messageContent.querySelector('.markdown, .markdown-main-panel');
    this.processNodes(
      markdownDiv || messageContent,
      htmlParts,
      textParts,
      result,
      processedImageSrcs,
    );

    // Additionally, look for code blocks and tables at the element level
    // These might be siblings to message-content in response-element containers
    // IMPORTANT: Angular may use Shadow DOM, so we need to search both light DOM and shadow DOM
    if (this.DEBUG) {
      console.log(
        '[DOMContentExtractor] Searching for code blocks in:',
        element.tagName,
        element.className,
      );
      console.log(
        '[DOMContentExtractor] Element HTML preview:',
        element.outerHTML.substring(0, 200),
      );
    }

    // Helper function to search in both light DOM and shadow DOM
    const searchAll = (root: Element, selector: string): Element[] => {
      const results: Element[] = [];

      // Search in light DOM
      results.push(...Array.from(root.querySelectorAll(selector)));

      // Search in shadow DOM recursively
      const searchShadow = (el: Element) => {
        const shadowRoot = el.shadowRoot;
        if (shadowRoot) {
          console.log(`[DOMContentExtractor] Searching in Shadow DOM of`, el.tagName);
          results.push(...Array.from(shadowRoot.querySelectorAll(selector)));
        }

        // Recursively check children for shadow roots
        Array.from(el.children).forEach(searchShadow);
      };

      searchShadow(root);
      return results;
    };

    // Also search for raw code elements regardless of presence of code-block
    const altCodeBlocks = searchAll(messageContent, 'pre > code, [data-test-id="code-content"]');
    if (this.DEBUG)
      console.log(
        '[DOMContentExtractor] Found',
        altCodeBlocks.length,
        'raw code elements with alternative selector',
      );
    altCodeBlocks.forEach((codeEl, idx) => {
      // Avoid duplicates if already processed
      if ((codeEl as Element & { processedByGV?: boolean }).processedByGV) return;
      // Skip if inside a code-block (already handled by processNodes)
      if (codeEl.closest && codeEl.closest('code-block')) return;
      if (this.DEBUG)
        console.log(
          `[DOMContentExtractor] Processing raw code element ${idx + 1}/${altCodeBlocks.length}`,
        );
      const extracted = extractCodeFromCodeElement(codeEl as HTMLElement);
      if (extracted.text) {
        (codeEl as Element & { processedByGV?: boolean }).processedByGV = true;
        result.hasCode = true;
        htmlParts.push(extracted.html);
        textParts.push(`\n${extracted.text}\n`);
      }
    });
    // Note: tables and code-blocks were already processed via processNodes()

    const leftoverRoot =
      (messageContent.closest(
        'model-response, .model-response, .presented-response-container, .response-container, response-container',
      ) as HTMLElement | null) || messageContent;
    this.processYouTubeCovers(leftoverRoot, htmlParts, textParts, result);
    if (markdownDiv) {
      this.exportAdapter.collectAssistantImages?.(
        leftoverRoot,
        htmlParts,
        textParts,
        result,
        processedImageSrcs,
        markdownDiv,
      );
    }

    result.html = htmlParts.join('\n');
    // Clean up multiple newlines but preserve intentional spacing
    let combinedText = textParts
      .join('')
      .replace(/\n{3,}/g, '\n\n') // Max 2 consecutive newlines
      .trim();
    // Last-chance fallback: if no structured text captured, use plain innerText
    if (!combinedText) {
      const fallbackContainer =
        (messageContent as HTMLElement) ||
        queryOutsideThoughts<HTMLElement>(element, 'message-content') ||
        (element as HTMLElement);
      try {
        const plain =
          (fallbackContainer as HTMLElement).innerText || fallbackContainer.textContent || '';
        combinedText = this.normalizeText(plain);
      } catch {
        /* ignore */
      }
    }
    result.text = combinedText;

    return result;
  }

  /**
   * Extract non-image uploads from platform-specific user message file cards.
   * Image previews are already exported as images above, so they are not duplicated.
   */
  private static extractUserAttachments(element: HTMLElement): ExportAttachment[] {
    const candidates = this.exportAdapter.getUserAttachmentCandidates(element);
    const attachments: ExportAttachment[] = [];
    const seen = new Set<string>();

    candidates?.forEach((candidate) => {
      const labelledElement = candidate.matches('[aria-label]')
        ? candidate
        : candidate.querySelector<HTMLElement>('[aria-label]');
      const name =
        labelledElement?.getAttribute('aria-label')?.trim() ||
        candidate.getAttribute('title')?.trim() ||
        this.normalizeText(candidate.textContent ?? '').replace(
          /^(?:PDF|DOCX?|PPTX?|XLSX?|CSV|TXT|ZIP|FILE)\s+/i,
          '',
        );

      if (!name) return;

      const type = name.match(/\.([a-z0-9]{1,12})$/i)?.[1].toLowerCase() ?? 'file';
      const preview = candidate.closest('user-query-file-preview') ?? candidate;
      const isImage =
        /^(?:avif|bmp|gif|heic|heif|jpe?g|png|svg|tiff?|webp)$/i.test(type) &&
        !!preview.querySelector('img');
      const key = `${name}\u0000${type}`;

      if (isImage || seen.has(key)) return;

      seen.add(key);
      attachments.push({ name, type });
    });

    return attachments;
  }

  /**
   * Process DOM nodes recursively
   */
  private static processNodes(
    container: Element | ShadowRoot,
    htmlParts: string[],
    textParts: string[],
    flags: Pick<ExtractedContent, 'hasImages' | 'hasFormulas' | 'hasTables' | 'hasCode'>,
    processedImageSrcs: Set<string> = new Set<string>(),
  ): void {
    const children = Array.from(container.children);
    const appendInlineContent = (processed: ProcessedInlineContent): void => {
      const isWhitespaceOnly =
        !processed.html &&
        !processed.text &&
        (processed.hasLeadingWhitespace || processed.hasTrailingWhitespace);

      if (isWhitespaceOnly) {
        const previousText = textParts.at(-1) ?? '';
        if (previousText && !/\s$/.test(previousText)) {
          htmlParts.push('<span> </span>');
          textParts.push(' ');
        }
        return;
      }

      if (processed.html) {
        htmlParts.push(`<span>${processed.html}</span>`);
      }

      if (processed.text) {
        const previousText = textParts.at(-1) ?? '';
        const needsLeadingSpace =
          processed.hasLeadingWhitespace && previousText.length > 0 && !/\s$/.test(previousText);

        textParts.push(
          `${needsLeadingSpace ? ' ' : ''}${processed.text}${
            processed.hasTrailingWhitespace ? ' ' : ''
          }`,
        );
      }
    };
    if (this.DEBUG)
      console.log(
        `[DOMContentExtractor] processNodes: ${children.length} children in`,
        container instanceof Element ? container.tagName : '#shadow-root',
        container instanceof Element ? container.className : '',
      );

    // Check for Shadow DOM
    const shadowRoot = container instanceof Element ? container.shadowRoot : null;
    if (shadowRoot) {
      if (this.DEBUG)
        console.log('[DOMContentExtractor] Found Shadow DOM! Processing shadow children');
      this.processNodes(shadowRoot, htmlParts, textParts, flags, processedImageSrcs);
    }

    for (const child of children) {
      const tagName = child.tagName.toLowerCase();
      if (this.DEBUG)
        console.log('[DOMContentExtractor] Processing child:', tagName, child.className);

      // Skip certain elements
      if (shouldSkipElement(child)) {
        if (this.DEBUG) console.log('[DOMContentExtractor] Skipping element:', tagName);
        continue;
      }

      if (child.shadowRoot && child.children.length === 0) {
        this.processNodes(child.shadowRoot, htmlParts, textParts, flags, processedImageSrcs);
        continue;
      }

      // Canvas Export Section (Injected Canvas document content)
      if (child.classList.contains('gv-canvas-export-section')) {
        const headingEl = child.querySelector('h3');
        const contentEl = child.querySelector('.gv-canvas-content');
        const headingText = headingEl?.textContent || 'Canvas Document';
        const contentText = contentEl?.textContent || '';

        htmlParts.push(
          `<div class="gv-canvas-export-section"><h3>${this.escapeHtml(headingText)}</h3><pre style="white-space: pre-wrap;">${this.escapeHtml(contentText)}</pre></div>`,
        );
        textParts.push(`\n### ${headingText}\n\n${contentText}\n`);
        continue;
      }

      // Extract formula
      if (this.exportAdapter.extractFormula(child, flags, htmlParts, textParts, this.DEBUG)) {
        continue;
      }

      const exportCodeBlocks = findExportCodeBlocks(child);
      const directExportCodeBlock = exportCodeBlocks.find((element) => element === child);
      if (directExportCodeBlock) {
        const content = extractExportCodeBlock(directExportCodeBlock);
        if (content) {
          htmlParts.push(content.html);
        }
        if (content?.text) {
          flags.hasCode = true;
          textParts.push(`\n${content.text}\n`);
        }
        continue;
      }

      // Extract code block via the per-platform adapter
      if (
        this.exportAdapter.extractCodeBlock(child, htmlParts, textParts, flags, tagName, this.DEBUG)
      ) {
        continue;
      }

      // Traverse containers that own export blocks instead of consuming only their first
      // descendant. This keeps prose, code, and Mermaid output in DOM order.
      if (tagName !== 'ul' && tagName !== 'ol' && exportCodeBlocks.length > 0) {
        this.processNodes(child, htmlParts, textParts, flags);
        continue;
      }

      // Table block (check for nested table-block first)
      const tableBlock = child.querySelector('table-block');
      if (
        tagName === 'table' ||
        tagName === 'table-block' ||
        tableBlock ||
        child.querySelector('table')
      ) {
        if (this.DEBUG) console.log('[DOMContentExtractor] Found table block!');
        const elementToExtract = (tableBlock || child) as HTMLElement;
        const tableContent = this.extractTable(elementToExtract);
        if (this.DEBUG) console.log('[DOMContentExtractor] Table content:', tableContent.text);
        if (tableContent.hasFormulas) flags.hasFormulas = true;
        if (tableContent.text) {
          // Only add if table was successfully extracted
          flags.hasTables = true;
          htmlParts.push(tableContent.html);
          textParts.push(`\n${tableContent.text}\n\n`);
        }
        continue;
      }

      // Extract assistant image
      if (
        this.exportAdapter.extractAssistantImage(
          child,
          htmlParts,
          textParts,
          flags,
          tagName,
          this.DEBUG,
          processedImageSrcs,
        )
      ) {
        continue;
      }

      // Horizontal rule
      if (tagName === 'hr') {
        htmlParts.push('<hr>');
        textParts.push('\n---\n');
        continue;
      }

      // Paragraph with possible inline formulas
      if (tagName === 'p') {
        const processed = this.processInlineContent(child as HTMLElement);
        if (processed.hasFormulas) flags.hasFormulas = true;
        htmlParts.push(`<p>${processed.html}</p>`);
        textParts.push(`${processed.text}\n`);
        continue;
      }

      // Headings
      if (/^h[1-6]$/.test(tagName)) {
        const text = this.extractTextWithInlineFormulas(child as HTMLElement);
        const level = tagName[1];
        htmlParts.push(`<h${level}>${text.html}</h${level}>`);
        textParts.push(`\n${'#'.repeat(parseInt(level))} ${text.text}\n`);
        continue;
      }

      // Lists
      if (tagName === 'ul' || tagName === 'ol') {
        const listContent = this.extractList(child as HTMLElement);
        if (listContent.hasFormulas) flags.hasFormulas = true;
        if (listContent.hasCode) flags.hasCode = true;
        htmlParts.push(listContent.html);
        textParts.push(`\n${listContent.text}\n`);
        continue;
      }

      if (tagName === 'blockquote') {
        const quoteHtml: string[] = [];
        const quoteText: string[] = [];
        this.processNodes(child, quoteHtml, quoteText, flags, processedImageSrcs);
        htmlParts.push(`<blockquote>${quoteHtml.join('')}</blockquote>`);
        const markdown = quoteText
          .join('')
          .trim()
          .split('\n')
          .map((line) => (line ? `> ${line}` : '>'))
          .join('\n');
        if (markdown) textParts.push(`\n${markdown}\n`);
        continue;
      }

      // Generic containers: recurse if the element has child elements,
      // regardless of tag name. This handles custom elements from any platform
      // (e.g. Claude's response containers) without needing a whitelist.
      if (child.children.length > 0) {
        if (this.DEBUG)
          console.log('[DOMContentExtractor] Recursing into container:', tagName, child.className);
        const hasDirectText = Array.from(child.childNodes).some(
          (node) => node.nodeType === Node.TEXT_NODE && this.normalizeText(node.textContent || ''),
        );
        const onlyInlineChildren = Array.from(child.children).every((element) =>
          /^(?:A|B|CODE|EM|I|IMG|SPAN|STRONG|SUB|SUP)$/.test(element.tagName),
        );
        if (hasDirectText && onlyInlineChildren) {
          const processed = this.processInlineContent(child as HTMLElement);
          if (processed.hasFormulas) flags.hasFormulas = true;
          appendInlineContent(processed);
        } else {
          this.processNodes(child, htmlParts, textParts, flags, processedImageSrcs);
        }
        continue;
      }

      // Leaf element with no child elements: extract text content
      const rawText = child.textContent || '';
      const text = this.normalizeText(rawText);
      appendInlineContent({
        html: this.escapeHtml(text),
        text,
        hasFormulas: false,
        hasLeadingWhitespace: /^\s/.test(rawText),
        hasTrailingWhitespace: /\s$/.test(rawText),
      });
    }
  }

  /**
   * Extract YouTube video cover thumbnails as clickable cover images.
   *
   * Gemini renders a video as
   *   `.attachment-container.youtube > … > youtube-block > single-video > … > img.thumbnail`
   * plus an `<iframe>` player that can't be exported. The custom elements
   * (youtube-block / single-video / default-player) stop processNodes' generic
   * recursion, so the cover is otherwise dropped. Here we emit the cover image
   * linked to the watch URL so it survives Markdown / PDF / image exports.
   *
   * Deduped across call sites via a `processedByGV` marker on the <img>.
   * Returns true if at least one cover was emitted.
   */
  public static processYouTubeCovers(
    scope: Element,
    htmlParts: string[],
    textParts: string[],
    flags: Pick<ExtractedContent, 'hasImages' | 'hasFormulas' | 'hasTables' | 'hasCode'>,
  ): boolean {
    const thumbs = scope.querySelectorAll<HTMLImageElement>(
      '.attachment-container.youtube img.thumbnail, youtube-block img.thumbnail, single-video img.thumbnail',
    );
    const videoIdFrom = (u: string | null | undefined): string => {
      const m = (u || '').match(/(?:\/vi\/|[?&]v=|youtu\.be\/|embed\/)([\w-]{11})/);
      return m ? m[1] : '';
    };
    let emitted = false;
    for (const imgEl of Array.from(thumbs)) {
      const marked = imgEl as Element & { processedByGV?: boolean };
      if (marked.processedByGV) continue;
      let src = imgEl.src || imgEl.getAttribute('src') || '';
      if (!src || src === 'about:blank') continue;
      marked.processedByGV = true;

      const card =
        imgEl.closest('single-video, youtube-block, .attachment-container.youtube') ||
        imgEl.parentElement ||
        scope;
      let videoId = videoIdFrom(src);
      if (!videoId) {
        const ref = card.querySelector('a[href*="youtu"], iframe[src*="youtube"]') as
          | HTMLAnchorElement
          | HTMLIFrameElement
          | null;
        videoId = videoIdFrom(
          (ref as HTMLAnchorElement | null)?.href || (ref as HTMLIFrameElement | null)?.src,
        );
      }
      // Prefer a stable cover URL when we know the id and the live src isn't a ytimg URL.
      if (videoId && !/ytimg\.com|img\.youtube\.com/.test(src)) {
        src = `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg`;
      }
      const watchUrl = videoId ? `https://www.youtube.com/watch?v=${videoId}` : '';
      const titleRaw =
        (imgEl.alt && imgEl.alt.trim()) ||
        card.querySelector('.video-title, [class*="title"]')?.textContent?.trim() ||
        'YouTube video';
      const title = this.normalizeText(titleRaw);

      flags.hasImages = true;
      const imgHtml = `<img src="${this.escapeHtmlAttribute(src)}" alt="${this.escapeHtmlAttribute(title)}" />`;
      htmlParts.push(
        watchUrl ? `<a href="${this.escapeHtmlAttribute(watchUrl)}">${imgHtml}</a>` : imgHtml,
      );
      const mdAlt = title.replace(/\]/g, '\\]');
      textParts.push(
        watchUrl ? `\n[![${mdAlt}](${src})](${watchUrl})\n` : `\n![${mdAlt}](${src})\n`,
      );
      emitted = true;
    }
    return emitted;
  }

  /**
   * Process inline content (text with inline formulas)
   */
  private static processInlineContent(
    element: HTMLElement,
    forMarkdownTable = false,
  ): ProcessedInlineContent {
    let hasFormulas = false;
    const htmlParts: string[] = [];
    const textParts: string[] = [];

    const appendFormattedContent = (
      processed: ProcessedInlineContent,
      htmlTag: 'code' | 'em' | 'strong',
      serializeMarkdown: (text: string) => string,
    ): void => {
      if (processed.hasFormulas) hasFormulas = true;

      const leadingSpace = processed.hasLeadingWhitespace ? ' ' : '';
      const trailingSpace = processed.hasTrailingWhitespace ? ' ' : '';
      const hasBoundaryWhitespace =
        processed.hasLeadingWhitespace || processed.hasTrailingWhitespace;

      if (processed.html) {
        htmlParts.push(`${leadingSpace}<${htmlTag}>${processed.html}</${htmlTag}>${trailingSpace}`);
      } else if (hasBoundaryWhitespace) {
        htmlParts.push(' ');
      }

      if (processed.text) {
        textParts.push(`${leadingSpace}${serializeMarkdown(processed.text)}${trailingSpace}`);
      } else if (hasBoundaryWhitespace) {
        textParts.push(' ');
      }
    };

    // Process all child nodes including text nodes
    const processNode = (node: Node): void => {
      if (node.nodeType === Node.TEXT_NODE) {
        const text = node.textContent || '';
        if (text.trim()) {
          htmlParts.push(this.escapeHtml(text));
          textParts.push(text);
        } else if (text && (htmlParts.length > 0 || textParts.length > 0)) {
          // Whitespace-only nodes can be the only separator between adjacent
          // inline elements, for example <strong>high</strong> <em>risk</em>.
          htmlParts.push(' ');
          textParts.push(' ');
        }
      } else if (node.nodeType === Node.ELEMENT_NODE) {
        const el = node as Element;

        if (shouldSkipElement(el)) {
          return;
        }

        const formulaHtmlParts: string[] = [];
        const formulaTextParts: string[] = [];

        if (this.exportAdapter.extractInlineFormula(el, formulaHtmlParts, formulaTextParts)) {
          hasFormulas = true;
          htmlParts.push(...formulaHtmlParts);

          const formulaMarkdown = formulaTextParts.join('');
          textParts.push(
            forMarkdownTable
              ? this.preserveLatexPipeCommandsInMarkdownTable(formulaMarkdown)
              : formulaMarkdown,
          );
          return;
        }

        // Emphasis
        if (el.tagName === 'I' || el.tagName === 'EM') {
          const processed = this.processInlineContent(el as HTMLElement, forMarkdownTable);
          appendFormattedContent(processed, 'em', (text) => `*${text}*`);
          return;
        }

        // Strong
        if (el.tagName === 'B' || el.tagName === 'STRONG') {
          const processed = this.processInlineContent(el as HTMLElement, forMarkdownTable);
          appendFormattedContent(processed, 'strong', (text) => `**${text}**`);
          return;
        }

        // Code
        if (el.tagName === 'CODE' && !el.closest('pre')) {
          const processed = this.processInlineCodeContent(el as HTMLElement);
          appendFormattedContent(processed, 'code', (text) =>
            this.serializeInlineCodeSpan(text, forMarkdownTable),
          );
          return;
        }

        // Inline images
        if (el.tagName === 'IMG') {
          const imgEl = el as HTMLImageElement;
          const src = imgEl.currentSrc || imgEl.src || imgEl.getAttribute('src') || '';
          if (src && src !== 'about:blank') {
            const alt = imgEl.alt || 'Image';
            htmlParts.push(
              `<img src="${this.escapeHtmlAttribute(src)}" alt="${this.escapeHtmlAttribute(alt)}" />`,
            );
            const mdAlt = alt.replace(/\]/g, '\\]');
            textParts.push(`![${mdAlt}](${src})`);
          }
          return;
        }

        // Recurse for other elements
        Array.from(el.childNodes).forEach(processNode);
      }
    };

    Array.from(element.childNodes).forEach(processNode);

    const rawHtml = htmlParts.join('');
    const rawText = textParts.join('');

    return {
      html: rawHtml.trim(),
      text: rawText.trim(),
      hasFormulas,
      hasLeadingWhitespace: /^\s/.test(rawText),
      hasTrailingWhitespace: /\s$/.test(rawText),
    };
  }

  private static processInlineCodeContent(element: HTMLElement): ProcessedInlineContent {
    const textParts: string[] = [];

    const collectText = (node: Node): void => {
      if (node.nodeType === Node.TEXT_NODE) {
        textParts.push(node.textContent || '');
        return;
      }

      if (node.nodeType !== Node.ELEMENT_NODE) return;

      const child = node as Element;
      if (shouldSkipElement(child)) return;

      Array.from(child.childNodes).forEach(collectText);
    };

    Array.from(element.childNodes).forEach(collectText);

    const rawText = textParts.join('');
    const text = rawText.trim();

    return {
      html: this.escapeHtml(text),
      text,
      hasFormulas: false,
      hasLeadingWhitespace: /^\s/.test(rawText),
      hasTrailingWhitespace: /\s$/.test(rawText),
    };
  }

  private static serializeInlineCodeSpan(text: string, forMarkdownTable = false): string {
    const needsTableSafeHtml =
      forMarkdownTable &&
      (/\\+\|/.test(text) || (text.includes('|') && this.normalizeText(text) !== text));

    if (needsTableSafeHtml) {
      // Marked continues parsing Markdown inside raw inline HTML. Encode every
      // code point so backslashes and collapsible whitespace stay literal.
      const escapedCode = Array.from(
        text,
        (character) => `&#x${character.codePointAt(0)!.toString(16)};`,
      ).join('');

      return `<code>${escapedCode}</code>`;
    }

    const longestBacktickRun = (text.match(/`+/g) ?? []).reduce(
      (longest, run) => Math.max(longest, run.length),
      0,
    );
    const delimiter = '`'.repeat(longestBacktickRun + 1);
    const needsPadding =
      text.startsWith('`') ||
      text.endsWith('`') ||
      (text.startsWith(' ') && text.endsWith(' ') && text.trim() !== '');
    const padding = needsPadding ? ' ' : '';

    return `${delimiter}${padding}${text}${padding}${delimiter}`;
  }

  /**
   * Extract text with inline formulas
   */
  private static extractTextWithInlineFormulas(element: HTMLElement): {
    html: string;
    text: string;
  } {
    const processed = this.processInlineContent(element);
    return { html: processed.html, text: processed.text };
  }

  public static extractCodeBlock(
    element: HTMLElement,
    languageOverride?: string,
  ): { html: string; text: string } {
    return extractCodeBlock(element, languageOverride);
  }

  /**
   * Extract table content
   */
  private static extractTable(element: HTMLElement): {
    html: string;
    text: string;
    hasFormulas: boolean;
  } {
    // Accept either a container that holds a <table>, or a <table> element itself
    let table: HTMLTableElement | null = null;
    if (element.tagName && element.tagName.toLowerCase() === 'table') {
      table = element as HTMLTableElement;
    } else {
      table = element.querySelector('table') as HTMLTableElement | null;
    }
    if (!table) {
      return { html: '', text: '', hasFormulas: false };
    }

    // Extract HTML (clean version)
    const cleanTable = table.cloneNode(true) as HTMLElement;
    stripExportArtifacts(cleanTable);

    // Convert to Markdown
    const rowCells: Element[][] = [];
    const headerCells = Array.from(table.querySelectorAll('thead tr td, thead tr th'));
    if (headerCells.length > 0) {
      rowCells.push(headerCells);
    }

    const bodyRows = table.querySelectorAll('tbody tr');
    bodyRows.forEach((row) => {
      rowCells.push(Array.from(row.querySelectorAll('td, th')));
    });
    const serializedTable = this.serializeTableRows(rowCells);

    // Build Markdown table
    const markdownLines: string[] = [];
    if (serializedTable.rows.length > 0) {
      // Header
      markdownLines.push('| ' + serializedTable.rows[0].join(' | ') + ' |');
      markdownLines.push('| ' + serializedTable.rows[0].map(() => '---').join(' | ') + ' |');
      // Body
      for (let i = 1; i < serializedTable.rows.length; i++) {
        markdownLines.push('| ' + serializedTable.rows[i].join(' | ') + ' |');
      }
    }

    return {
      html: cleanTable.outerHTML,
      text: markdownLines.join('\n'),
      hasFormulas: serializedTable.hasFormulas,
    };
  }

  private static serializeTableRows(rowCells: Element[][]): SerializedTable {
    let hasFormulas = false;
    const rows = rowCells.map((cells) =>
      cells.map((cell) => {
        const serializedCell = this.serializeTableCell(cell as HTMLElement);
        if (serializedCell.hasFormulas) hasFormulas = true;
        return serializedCell.text;
      }),
    );

    return { rows, hasFormulas };
  }

  private static serializeTableCell(cell: HTMLElement): SerializedTableCell {
    const processed = this.processInlineContent(cell, true);

    return {
      text: this.escapeMarkdownTableCell(this.normalizeText(processed.text)),
      hasFormulas: processed.hasFormulas,
    };
  }

  /**
   * Escape pipes before joining cells into a Markdown table row.
   * Existing backslashes are doubled so the rendered cell preserves them while
   * the final odd backslash still prevents the pipe from becoming a delimiter.
   * Inline code containing pipes is serialized without literal pipes before
   * reaching this table-level escape.
   */
  private static escapeMarkdownTableCell(text: string): string {
    return text.replace(/(\\*)\|/g, (_match, backslashes: string) => {
      return `${'\\'.repeat(backslashes.length * 2 + 1)}|`;
    });
  }

  /**
   * Keep LaTeX's `\|` double-vertical-bar command intact when the formula is
   * embedded in a Markdown table. The table parser consumes backslashes used
   * to escape pipes before the KaTeX extension receives the formula, so use
   * the equivalent pipe-free command instead.
   */
  private static preserveLatexPipeCommandsInMarkdownTable(latex: string): string {
    return latex.replace(/\\+\|/g, (command) => {
      return command === '\\|' ? '\\Vert{}' : command;
    });
  }

  /**
   * Extract list content with support for nested lists
   */
  private static extractList(
    element: HTMLElement,
    depth: number = 0,
  ): { html: string; text: string; hasFormulas: boolean; hasCode: boolean } {
    const isOrdered = element.tagName === 'OL';
    const orderedStart = isOrdered ? (element as HTMLOListElement).start : 1;
    const items = Array.from(element.querySelectorAll(':scope > li'));
    const indent = '  '.repeat(depth); // 2 spaces per level

    const textLines: string[] = [];
    let hasFormulas = false;
    let hasCode = false;
    items.forEach((item, index) => {
      const prefix = isOrdered ? `${orderedStart + index}. ` : '- ';
      const continuationIndent = indent + ' '.repeat(prefix.length);
      let hasItemContent = false;
      let proseNodes: Node[] = [];

      const ensureItemMarker = (): void => {
        if (!hasItemContent) {
          textLines.push(indent + prefix.trimEnd());
          hasItemContent = true;
        }
      };

      const flushProse = (): void => {
        if (proseNodes.length === 0) return;

        const proseContainer = document.createElement('div');
        proseNodes.forEach((node) => proseContainer.appendChild(node.cloneNode(true)));
        proseNodes = [];

        const processed = this.processInlineContent(proseContainer);
        if (processed.hasFormulas) hasFormulas = true;
        const prose = this.normalizeText(processed.text || proseContainer.textContent || '');
        if (!prose) return;

        textLines.push((hasItemContent ? continuationIndent : indent + prefix) + prose);
        hasItemContent = true;
      };

      const processItemNodes = (nodes: Node[]): void => {
        nodes.forEach((node) => {
          if (node.nodeType !== Node.ELEMENT_NODE) {
            proseNodes.push(node);
            return;
          }

          const child = node as HTMLElement;
          if (child.tagName === 'UL' || child.tagName === 'OL') {
            flushProse();
            const nestedResult = this.extractList(child, depth + 1);
            if (nestedResult.hasFormulas) hasFormulas = true;
            if (nestedResult.hasCode) hasCode = true;
            if (nestedResult.text) {
              ensureItemMarker();
              textLines.push(nestedResult.text);
            }
            return;
          }

          const exportCodeBlocks = findExportCodeBlocks(child);
          const directExportCodeBlock = exportCodeBlocks.find((element) => element === child);
          if (directExportCodeBlock) {
            flushProse();
            const content = extractExportCodeBlock(directExportCodeBlock);
            if (!content?.text) return;

            ensureItemMarker();
            hasCode = true;
            textLines.push(
              content.text
                .split('\n')
                .map((line) => continuationIndent + line)
                .join('\n'),
            );
            return;
          }

          if (exportCodeBlocks.length > 0 || child.querySelector('ul, ol')) {
            flushProse();
            processItemNodes(Array.from(child.childNodes));
            return;
          }

          proseNodes.push(node);
        });
      };

      processItemNodes(Array.from(item.childNodes));

      flushProse();
      if (!hasItemContent) {
        textLines.push(indent + prefix);
      }
    });

    const html = serializeListHtml(element);

    return {
      hasFormulas,
      hasCode,
      html,
      text: textLines.join('\n'),
    };
  }

  public static normalizeText(text: string): string {
    return normalizeText(text);
  }

  public static escapeHtml(text: string): string {
    return escapeHtml(text);
  }

  public static escapeHtmlAttribute(text: string): string {
    return escapeHtmlAttribute(text);
  }
}
