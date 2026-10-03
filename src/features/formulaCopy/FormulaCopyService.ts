/**
 * Formula Copy Service
 * Handles copying LaTeX/MathJax formulas from Gemini chat conversations
 * Uses enterprise patterns: Singleton, Service Layer, Event Delegation
 */
import browser from 'webextension-polyfill';

import { logger } from '@/core';
import { StorageKeys } from '@/core/types/common';
import type { ILogger } from '@/core/types/common';
import { getTranslationSyncUnsafe } from '@/utils/i18n';

import { copyFormulaToClipboard } from './formulaClipboard';
import { formatFormula } from './formulaCopyPayload';
import {
  extractLatexSource,
  findMathElement,
  isDisplayMode as isFormulaDisplayMode,
} from './formulaSource';

/**
 * Formula copy format options
 */
export type FormulaCopyFormat = 'latex' | 'unicodemath' | 'no-dollar' | 'notion';

/**
 * Configuration for the formula copy service
 */
export interface FormulaCopyConfig {
  toastDuration?: number;
  toastOffsetY?: number;
  maxTraversalDepth?: number;
  format?: FormulaCopyFormat;
  /** Test/embedding override; production defaults to Gemini host detection. */
  observeGeminiArrows?: boolean;
}

/**
 * Service class for handling formula copy functionality
 * Implements Singleton pattern for single instance management
 */
export class FormulaCopyService {
  private static instance: FormulaCopyService | null = null;
  private static readonly ACTIVE_ROOT_CLASS = 'gv-formula-copy-enabled';
  private static readonly IGNORED_INTERACTION_CLASS = 'gv-formula-copy-ignored';
  // Gemini renders prose arrows as inline data-math elements. Treat an
  // arrow-only token as presentation, while formulas containing operands stay
  // copyable. The surrounding checks keep this Gemini- and inline-specific.
  private static readonly PRESENTATIONAL_INLINE_ARROW_COMMANDS = new Set([
    '\\leftarrow',
    '\\gets',
    '\\rightarrow',
    '\\to',
    '\\leftrightarrow',
    '\\Leftarrow',
    '\\Rightarrow',
    '\\Leftrightarrow',
    '\\longleftarrow',
    '\\longrightarrow',
    '\\longleftrightarrow',
    '\\Longleftarrow',
    '\\Longrightarrow',
    '\\Longleftrightarrow',
    '\\mapsto',
    '\\longmapsto',
    '\\hookleftarrow',
    '\\hookrightarrow',
    '\\leftharpoonup',
    '\\leftharpoondown',
    '\\rightharpoonup',
    '\\rightharpoondown',
    '\\rightleftharpoons',
    '\\leftrightharpoons',
    '\\uparrow',
    '\\downarrow',
    '\\updownarrow',
    '\\Uparrow',
    '\\Downarrow',
    '\\Updownarrow',
    '\\nearrow',
    '\\searrow',
    '\\swarrow',
    '\\nwarrow',
    '\\implies',
    '\\impliedby',
    '\\iff',
  ]);
  private static readonly PRESENTATIONAL_INLINE_ARROW_GLYPH =
    /^[\u2190-\u21ff\u27f0-\u27ff\u2900-\u297f]$/u;
  private static readonly PRESENTATIONAL_INLINE_EXTENSIBLE_ARROW =
    /^\\x(?:left|right|leftright)arrow(?:\[[^\]]*\])?\{(?:[^{}]|\{[^{}]*\})*\}$/;
  private readonly logger: ILogger;
  private readonly config: Required<Omit<FormulaCopyConfig, 'format'>>;
  private currentFormat: FormulaCopyFormat = 'latex';

  // Storage change listener, extracted so it can be removed on destroy
  private readonly handleStorageChange: Parameters<
    typeof browser.storage.onChanged.addListener
  >[0] = (changes, areaName) => {
    if (areaName === 'sync' && changes[StorageKeys.FORMULA_COPY_FORMAT]) {
      const newFormat = changes[StorageKeys.FORMULA_COPY_FORMAT].newValue as FormulaCopyFormat;
      if (
        newFormat === 'latex' ||
        newFormat === 'unicodemath' ||
        newFormat === 'no-dollar' ||
        newFormat === 'notion'
      ) {
        this.formatPreferenceChangeVersion += 1;
        this.currentFormat = newFormat;
        this.logger.debug('Formula format changed', { format: newFormat });
      }
    }
  };

  private isInitialized = false;
  private isFormatChangeListenerAttached = false;
  private formatPreferenceLoadGeneration = 0;
  private formatPreferenceChangeVersion = 0;
  private lifecycleGeneration = 0;
  private copyToast: HTMLDivElement | null = null;
  private copyToastHideTimer: ReturnType<typeof setTimeout> | null = null;
  private arrowExclusionObserver: MutationObserver | null = null;
  private activeRootObserver: MutationObserver | null = null;

  private constructor(config: FormulaCopyConfig = {}) {
    this.logger = logger.createChild('FormulaCopy');
    this.config = {
      toastDuration: config.toastDuration ?? 2000,
      toastOffsetY: config.toastOffsetY ?? 40,
      maxTraversalDepth: config.maxTraversalDepth ?? 10,
      observeGeminiArrows:
        config.observeGeminiArrows ??
        (window.location.hostname === 'gemini.google.com' ||
          window.location.hostname === 'business.gemini.google'),
    };
    this.currentFormat = config.format ?? 'latex';
  }

  /**
   * Get singleton instance
   */
  public static getInstance(config?: FormulaCopyConfig): FormulaCopyService {
    if (!FormulaCopyService.instance) {
      FormulaCopyService.instance = new FormulaCopyService(config);
    }
    return FormulaCopyService.instance;
  }

  /**
   * Resolve a toast message in the user's selected in-extension language.
   *
   * Uses the custom translation layer (getTranslationSyncUnsafe), NOT
   * browser.i18n.getMessage — the latter follows the BROWSER UI locale, so an
   * English-browser user who picked Chinese in the popup would see an English
   * toast while the rest of Voyager's UI is Chinese. Resolving here (at toast
   * time) also guarantees initI18n() has populated the cached language by the
   * time the user actually clicks a formula.
   */
  private toastMessage(key: 'formula_copied' | 'formula_copy_failed'): string {
    return getTranslationSyncUnsafe(key);
  }

  /**
   * Load format preference from storage
   */
  private async loadFormatPreference(
    loadGeneration: number,
    changeVersionAtStart: number,
  ): Promise<void> {
    try {
      const result = await browser.storage.sync.get(StorageKeys.FORMULA_COPY_FORMAT);
      if (
        loadGeneration !== this.formatPreferenceLoadGeneration ||
        changeVersionAtStart !== this.formatPreferenceChangeVersion
      )
        return;

      const format = result[StorageKeys.FORMULA_COPY_FORMAT] as FormulaCopyFormat | undefined;
      if (
        format === 'latex' ||
        format === 'unicodemath' ||
        format === 'no-dollar' ||
        format === 'notion'
      ) {
        this.currentFormat = format;
        this.logger.debug('Loaded formula format preference', { format });
      }
    } catch (error) {
      if (loadGeneration === this.formatPreferenceLoadGeneration) {
        this.logger.warn('Failed to load format preference, using default', { error });
      }
    }
  }

  private startFormatPreferenceSync(): Promise<void> {
    const loadGeneration = ++this.formatPreferenceLoadGeneration;
    if (!this.isFormatChangeListenerAttached) {
      try {
        browser.storage.onChanged.addListener(this.handleStorageChange);
        this.isFormatChangeListenerAttached = true;
      } catch (error) {
        this.logger.warn('Failed to listen for formula format changes', { error });
      }
    }

    return this.loadFormatPreference(loadGeneration, this.formatPreferenceChangeVersion);
  }

  private stopFormatPreferenceSync(): void {
    this.formatPreferenceLoadGeneration += 1;
    if (!this.isFormatChangeListenerAttached) return;

    try {
      browser.storage.onChanged.removeListener(this.handleStorageChange);
    } catch (error) {
      this.logger.warn('Failed to remove storage change listener', { error });
    } finally {
      this.isFormatChangeListenerAttached = false;
    }
  }

  /**
   * Resolve the current format before click handling becomes active. The
   * storage listener stays attached while the interaction feature is toggled
   * off, so an off -> on transition cannot briefly copy with a stale format.
   */
  public prepare(): Promise<void> {
    return this.startFormatPreferenceSync();
  }

  /**
   * Initialize the formula copy feature
   */
  public initialize(): void {
    if (this.isInitialized) {
      this.logger.warn('Service already initialized');
      return;
    }

    // Production entry points await prepare(); keep direct callers and older
    // integrations compatible while still subscribing synchronously here.
    if (!this.isFormatChangeListenerAttached) void this.prepare();

    this.startArrowExclusionObserver();
    document.addEventListener('click', this.handleClick, true);
    document.addEventListener('mouseover', this.handleMouseOver, true);
    this.isInitialized = true;
    this.lifecycleGeneration += 1;
    document.documentElement.classList.add(FormulaCopyService.ACTIVE_ROOT_CLASS);
    this.startActiveRootObserver();
    this.logger.info('Formula copy service initialized');
  }

  /**
   * Clean up the service (for extension unloading)
   */
  public destroy(): void {
    if (!this.isInitialized) {
      document.documentElement.classList.remove(FormulaCopyService.ACTIVE_ROOT_CLASS);
      return;
    }

    this.stopActiveRootObserver();
    document.documentElement.classList.remove(FormulaCopyService.ACTIVE_ROOT_CLASS);
    document.removeEventListener('click', this.handleClick, true);
    document.removeEventListener('mouseover', this.handleMouseOver, true);
    this.stopArrowExclusionObserver();
    for (const element of document.querySelectorAll(
      `.${FormulaCopyService.IGNORED_INTERACTION_CLASS}`,
    )) {
      element.classList.remove(FormulaCopyService.IGNORED_INTERACTION_CLASS);
    }
    this.removeCopyToast();
    this.isInitialized = false;
    this.lifecycleGeneration += 1;
    this.logger.info('Formula copy service destroyed');
  }

  /** Fully release long-lived preference synchronization on page teardown. */
  public dispose(): void {
    this.destroy();
    this.stopFormatPreferenceSync();
  }

  /**
   * Handle click events using event delegation
   */
  private handleClick = (event: MouseEvent): void => {
    const target = event.target;
    if (!(target instanceof Element)) return;
    const mathElement = findMathElement(target);

    if (!mathElement) {
      return;
    }

    // Try to extract LaTeX: first from data-math (Gemini), then from annotation (AI Studio)
    const latexSource = extractLatexSource(mathElement);
    if (!latexSource) {
      this.logger.warn('Math element found but no LaTeX source available');
      return;
    }

    const isPresentationalArrow = this.isPresentationalInlineArrow(mathElement, latexSource);
    this.setInteractionIgnored(mathElement, isPresentationalArrow);
    if (isPresentationalArrow) {
      this.logger.debug('Ignoring presentational inline arrow rendered as Gemini math', {
        latexSource,
      });
      return;
    }

    // Wrap formula with delimiters based on display type
    const isDisplayMode = isFormulaDisplayMode(mathElement);
    const { text, html } = formatFormula(
      latexSource,
      isDisplayMode,
      this.currentFormat,
      this.logger,
    );

    void this.copyFormula(text, html, event.clientX, event.clientY, this.lifecycleGeneration);
    event.stopPropagation();
  };

  /**
   * Mouseover fallback for host DOM that is assembled in an unusual order after
   * the initial scan/observer pass.
   */
  private handleMouseOver = (event: MouseEvent): void => {
    const target = event.target;
    if (!(target instanceof Element)) return;

    const mathElement = findMathElement(target);
    if (!mathElement) return;
    const latexSource = extractLatexSource(mathElement);
    if (!latexSource) return;

    this.setInteractionIgnored(
      mathElement,
      this.isPresentationalInlineArrow(mathElement, latexSource),
    );
  };

  /**
   * Mark existing and newly-rendered Gemini arrows before the active CSS can
   * give them formula padding/cursor affordances. Mouseover remains a fallback
   * for host DOM that mutates in an unusual order.
   */
  private startArrowExclusionObserver(): void {
    if (!this.config.observeGeminiArrows) return;
    this.refreshArrowExclusions(document);
    if (this.arrowExclusionObserver || !document.documentElement) return;

    this.arrowExclusionObserver = new MutationObserver((records) => {
      const refreshRoots = new Set<ParentNode>();

      for (const record of records) {
        if (record.type === 'attributes') {
          if (record.target instanceof HTMLElement) {
            refreshRoots.add(record.target.closest<HTMLElement>('.math-inline') ?? record.target);
          }
          continue;
        }

        for (const node of record.addedNodes) {
          if (node instanceof HTMLElement || node instanceof DocumentFragment) {
            if (this.containsMathSource(node)) {
              refreshRoots.add(
                node instanceof HTMLElement
                  ? (node.closest<HTMLElement>('.math-inline') ?? node)
                  : node,
              );
            }
          }
        }

        const inlineContainer =
          record.target instanceof HTMLElement
            ? record.target.closest<HTMLElement>('.math-inline')
            : null;
        if (inlineContainer) {
          const removedRelevantMath = Array.from(record.removedNodes).some(
            (node) =>
              this.containsMathSource(node) ||
              (node instanceof HTMLElement &&
                (node.classList.contains(FormulaCopyService.IGNORED_INTERACTION_CLASS) ||
                  node.querySelector(`.${FormulaCopyService.IGNORED_INTERACTION_CLASS}`) !== null)),
          );
          if (removedRelevantMath) refreshRoots.add(inlineContainer);
        }
      }

      for (const root of refreshRoots) this.refreshArrowExclusions(root);
    });
    this.arrowExclusionObserver.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ['data-math'],
      childList: true,
      subtree: true,
    });
  }

  private containsMathSource(node: Node): boolean {
    if (!(node instanceof HTMLElement || node instanceof DocumentFragment)) return false;
    return (
      (node instanceof HTMLElement && node.matches('[data-math]')) ||
      node.querySelector('[data-math]') !== null
    );
  }

  private stopArrowExclusionObserver(): void {
    this.arrowExclusionObserver?.disconnect();
    this.arrowExclusionObserver = null;
  }

  private startActiveRootObserver(): void {
    if (this.activeRootObserver) return;
    this.activeRootObserver = new MutationObserver(() => {
      if (
        this.isInitialized &&
        !document.documentElement.classList.contains(FormulaCopyService.ACTIVE_ROOT_CLASS)
      ) {
        document.documentElement.classList.add(FormulaCopyService.ACTIVE_ROOT_CLASS);
      }
    });
    this.activeRootObserver.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ['class'],
    });
  }

  private stopActiveRootObserver(): void {
    this.activeRootObserver?.disconnect();
    this.activeRootObserver = null;
  }

  private refreshArrowExclusions(root: ParentNode): void {
    const inlineContainer =
      root instanceof HTMLElement ? root.closest<HTMLElement>('.math-inline') : null;
    const scanRoot: ParentNode = inlineContainer ?? root;

    if (
      scanRoot instanceof HTMLElement &&
      scanRoot.classList.contains(FormulaCopyService.IGNORED_INTERACTION_CLASS)
    ) {
      scanRoot.classList.remove(FormulaCopyService.IGNORED_INTERACTION_CLASS);
    }
    for (const ignored of scanRoot.querySelectorAll<HTMLElement>(
      `.${FormulaCopyService.IGNORED_INTERACTION_CLASS}`,
    )) {
      ignored.classList.remove(FormulaCopyService.IGNORED_INTERACTION_CLASS);
    }

    const candidates: HTMLElement[] = [];
    if (scanRoot instanceof HTMLElement && scanRoot.matches('[data-math]')) {
      candidates.push(scanRoot);
    }
    candidates.push(...scanRoot.querySelectorAll<HTMLElement>('[data-math]'));

    for (const candidate of candidates) {
      const latexSource = candidate.getAttribute('data-math');
      if (!latexSource) continue;
      this.setInteractionIgnored(
        candidate,
        this.isPresentationalInlineArrow(candidate, latexSource),
      );
    }
  }

  private setInteractionIgnored(mathElement: HTMLElement, ignored: boolean): void {
    const exactElements = new Set<HTMLElement>([mathElement]);
    const presentationContainer = mathElement.closest(
      '.math-inline, .math-display, .math-block, ms-katex, .katex, .katex-display',
    );

    for (const katexElement of mathElement.querySelectorAll<HTMLElement>('.katex')) {
      exactElements.add(katexElement);
    }

    for (const element of exactElements) {
      element.classList.toggle(FormulaCopyService.IGNORED_INTERACTION_CLASS, ignored);
    }

    if (presentationContainer instanceof HTMLElement) {
      const sources = presentationContainer.matches('[data-math]')
        ? [presentationContainer]
        : [...presentationContainer.querySelectorAll<HTMLElement>('[data-math]')];
      const containerIsOnlyPresentationalArrows =
        sources.length > 0 &&
        sources.every((source) => {
          const formula = source.getAttribute('data-math');
          return formula !== null && this.isPresentationalInlineArrow(source, formula);
        });
      presentationContainer.classList.toggle(
        FormulaCopyService.IGNORED_INTERACTION_CLASS,
        containerIsOnlyPresentationalArrows,
      );
    }
  }

  /**
   * Copy formula to clipboard and show notification
   */
  private async copyFormula(
    text: string,
    html: string | undefined,
    x: number,
    y: number,
    lifecycleGeneration: number,
  ): Promise<void> {
    try {
      const success = await copyFormulaToClipboard(text, html, this.logger);
      if (!this.isInitialized || lifecycleGeneration !== this.lifecycleGeneration) return;

      if (success) {
        this.showToast(this.toastMessage('formula_copied'), x, y, true);
        this.logger.debug('Formula copied successfully', { length: text.length, hasHtml: !!html });
      } else {
        this.showToast(this.toastMessage('formula_copy_failed'), x, y, false);
        this.logger.error('Failed to copy formula');
      }
    } catch (error) {
      if (!this.isInitialized || lifecycleGeneration !== this.lifecycleGeneration) return;
      this.showToast(this.toastMessage('formula_copy_failed'), x, y, false);
      this.logger.error('Error copying formula', { error });
    }
  }

  private isPresentationalInlineArrow(element: HTMLElement, formula: string): boolean {
    if (
      !this.config.observeGeminiArrows ||
      !element.hasAttribute('data-math') ||
      element.closest('.math-inline') === null ||
      isFormulaDisplayMode(element)
    )
      return false;
    // Explicit delimiters are evidence that this is an intentional formula,
    // even when its entire mathematical content is an arrow.
    const normalized = formula.trim();
    return (
      FormulaCopyService.PRESENTATIONAL_INLINE_ARROW_COMMANDS.has(normalized) ||
      FormulaCopyService.PRESENTATIONAL_INLINE_ARROW_GLYPH.test(normalized) ||
      FormulaCopyService.PRESENTATIONAL_INLINE_EXTENSIBLE_ARROW.test(normalized)
    );
  }

  /**
   * Show toast notification
   */
  private showToast(message: string, x: number, y: number, isSuccess: boolean): void {
    if (!this.copyToast) {
      this.copyToast = this.createCopyToast();
    }

    this.copyToast.textContent = message;
    this.copyToast.style.left = `${x}px`;
    this.copyToast.style.top = `${y - this.config.toastOffsetY}px`;

    // Update toast style based on success/failure
    if (isSuccess) {
      this.copyToast.classList.remove('gv-copy-toast-error');
      this.copyToast.classList.add('gv-copy-toast-success');
    } else {
      this.copyToast.classList.remove('gv-copy-toast-success');
      this.copyToast.classList.add('gv-copy-toast-error');
    }

    this.copyToast.classList.add('gv-copy-toast-show');

    if (this.copyToastHideTimer !== null) clearTimeout(this.copyToastHideTimer);
    const toast = this.copyToast;
    this.copyToastHideTimer = setTimeout(() => {
      if (this.copyToast === toast) toast.classList.remove('gv-copy-toast-show');
      this.copyToastHideTimer = null;
    }, this.config.toastDuration);
  }

  /**
   * Create toast element
   */
  private createCopyToast(): HTMLDivElement {
    const toast = document.createElement('div');
    toast.className = 'gv-copy-toast';
    document.body.appendChild(toast);
    return toast;
  }

  /**
   * Remove toast element from DOM
   */
  private removeCopyToast(): void {
    if (this.copyToastHideTimer !== null) {
      clearTimeout(this.copyToastHideTimer);
      this.copyToastHideTimer = null;
    }
    if (this.copyToast?.parentElement) {
      this.copyToast.parentElement.removeChild(this.copyToast);
      this.copyToast = null;
    }
  }

  /**
   * Check if service is initialized
   */
  public isServiceInitialized(): boolean {
    return this.isInitialized;
  }
}

// Export singleton instance getter
export const getFormulaCopyService = (config?: FormulaCopyConfig) =>
  FormulaCopyService.getInstance(config);
