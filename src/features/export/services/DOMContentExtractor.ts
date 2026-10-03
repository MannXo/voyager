import { logger } from '@/core/services/LoggerService';

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
} from './exportCodeBlocks';
import {
  shouldSkipElement,
  normalizeText,
  escapeHtml,
  escapeHtmlAttribute,
} from './exportDomPolicy';
import { processInlineContent, extractTable, extractList } from './exportRichText';
import type { ProcessedInlineContent } from './exportRichText';
import { extractUserContent } from './exportUserContent';

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

export class DOMContentExtractor {
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
   */
  static extractUserContent(element: HTMLElement): ExtractedContent {
    return extractUserContent(element, this.exportAdapter);
  }

  /**
   * Extract assistant response content with rich formatting
   */
  static extractAssistantContent(element: HTMLElement): ExtractedContent {
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

    // Helper function to search in both light DOM and shadow DOM
    const searchAll = (root: Element, selector: string): Element[] => {
      const results: Element[] = [];

      // Search in light DOM
      results.push(...Array.from(root.querySelectorAll(selector)));

      // Search in shadow DOM recursively
      const searchShadow = (el: Element) => {
        const shadowRoot = el.shadowRoot;
        if (shadowRoot) {
          logger.debug('[DOMContentExtractor] Searching in Shadow DOM', { tagName: el.tagName });
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
    altCodeBlocks.forEach((codeEl) => {
      // Avoid duplicates if already processed
      if ((codeEl as Element & { processedByGV?: boolean }).processedByGV) return;
      // Skip if inside a code-block (already handled by processNodes)
      if (codeEl.closest && codeEl.closest('code-block')) return;
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

    // Check for Shadow DOM
    const shadowRoot = container instanceof Element ? container.shadowRoot : null;
    if (shadowRoot) {
      this.processNodes(shadowRoot, htmlParts, textParts, flags, processedImageSrcs);
    }

    for (const child of children) {
      const tagName = child.tagName.toLowerCase();

      // Skip certain elements
      if (shouldSkipElement(child)) {
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
      if (this.exportAdapter.extractFormula(child, flags, htmlParts, textParts, false)) {
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
      if (this.exportAdapter.extractCodeBlock(child, htmlParts, textParts, flags, tagName, false)) {
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
        const elementToExtract = (tableBlock || child) as HTMLElement;
        const tableContent = extractTable(elementToExtract, this.exportAdapter);
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
          false,
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
        const processed = processInlineContent(child as HTMLElement, this.exportAdapter);
        if (processed.hasFormulas) flags.hasFormulas = true;
        htmlParts.push(`<p>${processed.html}</p>`);
        textParts.push(`${processed.text}\n`);
        continue;
      }

      // Headings
      if (/^h[1-6]$/.test(tagName)) {
        const text = processInlineContent(child as HTMLElement, this.exportAdapter);
        const level = tagName[1];
        htmlParts.push(`<h${level}>${text.html}</h${level}>`);
        textParts.push(`\n${'#'.repeat(parseInt(level))} ${text.text}\n`);
        continue;
      }

      // Lists
      if (tagName === 'ul' || tagName === 'ol') {
        const listContent = extractList(child as HTMLElement, this.exportAdapter);
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
        const hasDirectText = Array.from(child.childNodes).some(
          (node) => node.nodeType === Node.TEXT_NODE && this.normalizeText(node.textContent || ''),
        );
        const onlyInlineChildren = Array.from(child.children).every((element) =>
          /^(?:A|B|CODE|EM|I|IMG|SPAN|STRONG|SUB|SUP)$/.test(element.tagName),
        );
        if (hasDirectText && onlyInlineChildren) {
          const processed = processInlineContent(child as HTMLElement, this.exportAdapter);
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

  public static extractCodeBlock(
    element: HTMLElement,
    languageOverride?: string,
  ): { html: string; text: string } {
    return extractCodeBlock(element, languageOverride);
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
