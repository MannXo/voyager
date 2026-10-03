import { openFullscreen } from './fullscreen';
import { isGenericLanguageLabel, isMermaidCode, normalizeMermaidCode } from './source';

export { isGenericLanguageLabel } from './source';

/**
 * Lazily loaded Mermaid instance.
 * Mermaid is dynamically imported to reduce initial content script bundle size.
 * The library (~1 MB) is only loaded when a Mermaid code block is actually detected.
 */
let mermaidInstance: Awaited<typeof import('mermaid')>['default'] | null = null;
let mermaidLoadFailed = false;

type MermaidTheme = 'dark' | 'light';

let initializedMermaidTheme: MermaidTheme | null = null;

const MERMAID_LIGHT_EXPORT_TEMPLATE_CLASS = 'gv-mermaid-light-export';
const MERMAID_LIGHT_THEME_DIRECTIVE = '%%{init: {"theme":"default"}}%%';
const MERMAID_FORBIDDEN_TAGS = [
  'a',
  'audio',
  'base',
  'button',
  'embed',
  'form',
  'iframe',
  'image',
  'img',
  'input',
  'link',
  'meta',
  'object',
  'script',
  'source',
  'video',
];
const MERMAID_FORBIDDEN_ATTRIBUTES = [
  'action',
  'download',
  'formaction',
  'href',
  'poster',
  'src',
  'srcdoc',
  'srcset',
  'target',
  'xlink:href',
];

function decodeCssEscapes(value: string): string {
  return value.replace(/\\([0-9a-f]{1,6}\s?|.)/gi, (_match, escaped: string) => {
    const hex = escaped.trim();
    if (/^[0-9a-f]{1,6}$/i.test(hex)) {
      const codePoint = Number.parseInt(hex, 16);
      return codePoint > 0 && codePoint <= 0x10ffff ? String.fromCodePoint(codePoint) : '';
    }
    return escaped;
  });
}

function containsUnsafeMermaidCss(value: string): boolean {
  const normalized = decodeCssEscapes(value)
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .toLowerCase();
  return (
    /(?:^|[;{])\s*position\s*:\s*(?:fixed|sticky)/.test(normalized) ||
    /(?:^|[;{])\s*inset(?:-[a-z]+)?\s*:/.test(normalized) ||
    /@import|(?:expression|behavior|-moz-binding)\s*[:(]/.test(normalized) ||
    /url\s*\(\s*(?!["']?#)/.test(normalized)
  );
}

async function sanitizeMermaidSvg(svg: string): Promise<string> {
  const DOMPurifyModule = await import('dompurify');
  const DOMPurify = DOMPurifyModule.default ?? DOMPurifyModule;
  const sanitized = DOMPurify.sanitize(svg, {
    FORBID_ATTR: MERMAID_FORBIDDEN_ATTRIBUTES,
    FORBID_TAGS: MERMAID_FORBIDDEN_TAGS,
    KEEP_CONTENT: true,
    USE_PROFILES: { html: true, svg: true, svgFilters: true },
  });
  const template = document.createElement('template');
  template.innerHTML = sanitized;

  template.content.querySelectorAll('style').forEach((style) => {
    if (containsUnsafeMermaidCss(style.textContent ?? '')) style.remove();
  });
  template.content.querySelectorAll<HTMLElement>('[style]').forEach((element) => {
    const value = element.getAttribute('style') ?? '';
    if (containsUnsafeMermaidCss(value)) element.removeAttribute('style');
  });
  template.content.querySelectorAll('*').forEach((element) => {
    for (const attribute of Array.from(element.attributes)) {
      if (/^on/i.test(attribute.name)) {
        element.removeAttribute(attribute.name);
        continue;
      }
      if (
        /^(?:fill|stroke|filter|clip-path|mask|marker-start|marker-mid|marker-end)$/i.test(
          attribute.name,
        ) &&
        /url\s*\(\s*(?!["']?#)/i.test(attribute.value)
      ) {
        element.removeAttribute(attribute.name);
      }
    }
  });
  template.content.querySelectorAll('text, tspan').forEach((element) => {
    element.childNodes.forEach((node) => {
      if (node.nodeType === 3 && node.textContent?.includes('&amp;')) {
        node.textContent = node.textContent.replace(/&amp;/gi, '&');
      }
    });
  });

  return template.innerHTML;
}

function createMermaidErrorCard(errorMessage: string): HTMLElement {
  const card = document.createElement('div');
  card.style.cssText =
    'padding: 24px; text-align: center; color: var(--gemini-on-surface-variant, #666);';

  const icon = document.createElement('div');
  icon.style.cssText = 'font-size: 32px; margin-bottom: 12px;';
  icon.textContent = '⚠️';

  const title = document.createElement('div');
  title.style.cssText = 'font-weight: 500; margin-bottom: 8px;';
  title.textContent = 'Mermaid Syntax Error';

  const details = document.createElement('div');
  details.style.cssText =
    'font-size: 12px; opacity: 0.7; font-family: monospace; max-width: 400px; margin: 0 auto; word-break: break-word;';
  details.textContent = errorMessage;

  const hint = document.createElement('div');
  hint.style.cssText = 'margin-top: 12px; font-size: 13px;';
  hint.append('Click ');
  const codeLabel = document.createElement('b');
  codeLabel.textContent = '"</> Code"';
  hint.append(codeLabel, ' to view source');

  card.append(icon, title, details, hint);
  return card;
}

/**
 * Reset internal loader state. Only for testing.
 * @internal
 */
export const _resetMermaidLoader = () => {
  mermaidInstance = null;
  mermaidLoadFailed = false;
  initializedMermaidTheme = null;
};

/**
 * Dynamically load the Mermaid library.
 * Returns the mermaid default export, or null if loading fails.
 * Once loaded (or failed), the result is cached.
 */
/**
 * @internal Exported for testing
 */
export const loadMermaid = async (): Promise<typeof mermaidInstance> => {
  if (mermaidInstance) return mermaidInstance;
  if (mermaidLoadFailed) return null;

  try {
    const mod = await import('mermaid');
    mermaidInstance = mod.default;
    return mermaidInstance;
  } catch (error) {
    mermaidLoadFailed = true;
    console.error('[Gemini Voyager] Failed to load Mermaid library:', error);
    return null;
  }
};

/**
 * Resolve the Mermaid theme from Gemini's explicit page state before falling
 * back to the browser's system preference.
 * @internal Exported for testing
 */
export function resolveMermaidTheme(doc: Document, prefersDark: boolean): 'dark' | 'default' {
  const body = doc.body;
  const root = doc.documentElement;

  if (doc.querySelector('.theme-host.dark-theme')) return 'dark';
  if (doc.querySelector('.theme-host.light-theme')) return 'default';

  const hasExplicitDarkTheme = Boolean(
    body.classList.contains('dark-theme') ||
    root.classList.contains('dark') ||
    body.getAttribute('data-theme') === 'dark',
  );
  if (hasExplicitDarkTheme) return 'dark';

  const hasExplicitLightTheme = Boolean(
    body.classList.contains('light-theme') ||
    root.classList.contains('light') ||
    body.getAttribute('data-theme') === 'light',
  );
  if (hasExplicitLightTheme) return 'default';

  return prefersDark ? 'dark' : 'default';
}

const getMermaidTheme = (): MermaidTheme =>
  resolveMermaidTheme(document, window.matchMedia('(prefers-color-scheme: dark)').matches) ===
  'dark'
    ? 'dark'
    : 'light';

/**
 * Initialize Mermaid configuration
 */
const initMermaid = async (): Promise<boolean> => {
  const mermaid = await loadMermaid();
  if (!mermaid) return false;

  const theme = getMermaidTheme();

  mermaid.initialize({
    startOnLoad: false,
    theme: theme === 'dark' ? 'dark' : 'default',
    htmlLabels: false,
    flowchart: { htmlLabels: false },
    securityLevel: 'strict',
    fontFamily: 'Google Sans, Roboto, sans-serif',
    logLevel: 5, // 5 = fatal, only log fatal errors (v9.x uses numbers)
  });
  initializedMermaidTheme = theme;

  return true;
};

/** @internal Exported for theme-marker testing. */
export const _initMermaidForTest = initMermaid;

/**
 * Create styles for mermaid components and fullscreen viewer
 */
const createStyles = () => {
  if (document.getElementById('gv-mermaid-styles')) return;

  const style = document.createElement('style');
  style.id = 'gv-mermaid-styles';
  style.textContent = `
    .gv-mermaid-wrapper {
      position: relative;
    }
    
    .gv-mermaid-toggle {
      position: absolute;
      top: 8px;
      right: 8px;
      z-index: 10;
      display: flex;
      align-items: center; /* Center items vertically */
      gap: 4px;
      background: var(--gemini-surface-container, rgba(0,0,0,0.05));
      border-radius: 8px;
      padding: 2px;
      border: 1px solid var(--gemini-outline-variant, rgba(0,0,0,0.1));
    }
    
    .gv-mermaid-toggle button {
      padding: 4px 10px;
      border: none;
      border-radius: 6px;
      cursor: pointer;
      font-size: 12px;
      font-family: 'Google Sans', sans-serif;
      transition: all 0.2s ease;
      background: transparent;
      color: var(--gemini-on-surface-variant, #666);
    }
    
    .gv-mermaid-toggle button:hover {
      background: var(--gemini-surface-container-high, rgba(0,0,0,0.08));
    }
    
    .gv-mermaid-toggle button.active {
      background: var(--gemini-primary, #1a73e8);
      color: white;
    }
    
    .gv-mermaid-diagram {
      position: relative;
      padding: 16px;
      text-align: center;
      overflow: auto;
      min-height: 100px;
      cursor: zoom-in;
      contain: paint;
      isolation: isolate;
    }
    
    .gv-mermaid-diagram svg {
      max-width: 100%;
      height: auto;
    }
    
    /* Fullscreen Modal */
    .gv-mermaid-modal {
      position: fixed;
      top: 0;
      left: 0;
      width: 100vw;
      height: 100vh;
      background: rgba(0, 0, 0, 0.9);
      z-index: 999999;
      display: flex;
      align-items: center;
      justify-content: center;
      opacity: 0;
      transition: opacity 0.3s ease;
    }
    
    .gv-mermaid-modal.visible {
      opacity: 1;
    }
    
    .gv-mermaid-modal-toolbar {
      position: fixed;
      top: 16px;
      right: 16px;
      display: flex;
      gap: 8px;
      z-index: 1000000;
    }
    
    .gv-mermaid-modal-toolbar button {
      width: 40px;
      height: 40px;
      border-radius: 50%;
      border: none;
      background: rgba(255, 255, 255, 0.2);
      color: white;
      font-size: 18px;
      cursor: pointer;
      transition: all 0.2s ease;
      display: flex;
      align-items: center;
      justify-content: center;
    }
    
    .gv-mermaid-modal-toolbar button:hover {
      background: rgba(255, 255, 255, 0.3);
      transform: scale(1.1);
    }
    
    .gv-mermaid-modal-content {
      position: relative;
      cursor: grab;
      user-select: none;
    }
    
    .gv-mermaid-modal-content.dragging {
      cursor: grabbing;
    }
    
    .gv-mermaid-modal-content svg {
      max-width: none;
      max-height: none;
    }
    
    .gv-mermaid-modal-hint {
      position: fixed;
      bottom: 20px;
      left: 50%;
      transform: translateX(-50%);
      color: rgba(255, 255, 255, 0.6);
      font-size: 14px;
      font-family: 'Google Sans', sans-serif;
      pointer-events: none;
    }
  `;
  document.head.appendChild(style);
};

/**
 * Render Mermaid diagram for a code block
 */
const renderMermaid = async (codeBlock: HTMLElement, code: string) => {
  // Normalize common copy/paste and model-output issues before processing.
  const normalizedCode = normalizeMermaidCode(code);
  if (codeBlock.dataset.mermaidCode === normalizedCode) return;
  if (codeBlock.dataset.mermaidProcessing === 'true') return;

  codeBlock.dataset.mermaidProcessing = 'true';

  try {
    const codeBlockHost = codeBlock.closest('code-block') as HTMLElement;
    if (!codeBlockHost) {
      codeBlock.dataset.mermaidProcessing = 'false';
      return;
    }

    // Ensure Mermaid is loaded before rendering
    const mermaid = await loadMermaid();
    if (!mermaid) {
      // Mermaid failed to load — gracefully degrade by showing raw code
      codeBlock.dataset.mermaidProcessing = 'false';
      return;
    }

    // First, try to render to validate the code
    const uniqueId = `mermaid-${Math.random().toString(36).substr(2, 9)}`;
    let svg: string;
    let renderedDiagram = false;
    let renderErrorMessage: string | null = null;

    try {
      // v9.x render returns string directly, v10.x returns {svg: string}
      const result = await mermaid.render(uniqueId, normalizedCode);
      svg = typeof result === 'string' ? result : (result as { svg: string }).svg;
      renderedDiagram = true;
    } catch (renderError) {
      // Mermaid failed - likely incomplete or invalid syntax

      // Clean up any error SVGs mermaid may have created
      const errorSvg = document.getElementById(uniqueId);
      if (errorSvg) errorSvg.remove();

      // Also clean up any floating error containers mermaid creates
      document.querySelectorAll('[id^="d"]').forEach((el) => {
        if (el.textContent?.includes('Syntax error') || el.querySelector('.error-icon')) {
          el.remove();
        }
      });

      // Create a friendly error message
      const errorMsg = renderError instanceof Error ? renderError.message : 'Unknown error';
      renderErrorMessage = errorMsg.length > 100 ? errorMsg.substring(0, 100) + '...' : errorMsg;
      svg = '';
    }

    let lightExportSvg: string | null = null;
    if (renderedDiagram && initializedMermaidTheme === 'dark') {
      const exportId = `${uniqueId}-export`;
      try {
        const exportResult = await mermaid.render(
          exportId,
          `${normalizedCode}\n${MERMAID_LIGHT_THEME_DIRECTIVE}`,
        );
        lightExportSvg =
          typeof exportResult === 'string' ? exportResult : (exportResult as { svg: string }).svg;
      } catch {
        document.getElementById(exportId)?.remove();
      }
    }

    // Rendering succeeded! Now create or update the UI
    let wrapper = codeBlockHost.parentElement;
    if (!wrapper?.classList.contains('gv-mermaid-wrapper')) {
      wrapper = document.createElement('div');
      wrapper.className = 'gv-mermaid-wrapper';
      codeBlockHost.parentElement?.insertBefore(wrapper, codeBlockHost);
      wrapper.appendChild(codeBlockHost);

      // Toggle buttons
      const toggleContainer = document.createElement('div');
      toggleContainer.className = 'gv-mermaid-toggle';

      // Try to find and move the native copy button to our toolbar
      // This prevents overlap/covering issues and keeps the UI clean
      // We look for .buttons container (newer Gemini) or .copy-button class
      const parentElement = wrapper?.parentElement || codeBlockHost.parentElement;
      const nativeCopyBtn =
        parentElement?.querySelector('.buttons') || parentElement?.querySelector('.copy-button');

      // Only move if it looks like the right button (close to the code block)
      if (nativeCopyBtn) {
        // Reset positioning that might conflict
        (nativeCopyBtn as HTMLElement).style.position = 'static';
        (nativeCopyBtn as HTMLElement).style.top = 'auto';
        (nativeCopyBtn as HTMLElement).style.right = 'auto';
        (nativeCopyBtn as HTMLElement).style.marginTop = '0';
        toggleContainer.appendChild(nativeCopyBtn);
      }

      const diagramBtn = document.createElement('button');
      diagramBtn.textContent = '📊 Diagram';
      diagramBtn.className = 'active';
      diagramBtn.dataset.view = 'diagram';

      const codeBtn = document.createElement('button');
      codeBtn.textContent = '</> Code';
      codeBtn.dataset.view = 'code';

      toggleContainer.appendChild(diagramBtn);
      toggleContainer.appendChild(codeBtn);
      wrapper.appendChild(toggleContainer);

      // Diagram container
      const diagramContainer = document.createElement('div');
      diagramContainer.className = 'gv-mermaid-diagram';
      wrapper.appendChild(diagramContainer);

      codeBlockHost.style.display = 'none';

      const updateView = (view: 'diagram' | 'code') => {
        if (view === 'diagram') {
          codeBlockHost.style.display = 'none';
          diagramContainer.style.display = 'block';
          diagramBtn.classList.add('active');
          codeBtn.classList.remove('active');
        } else {
          codeBlockHost.style.display = '';
          diagramContainer.style.display = 'none';
          diagramBtn.classList.remove('active');
          codeBtn.classList.add('active');
        }
      };

      diagramBtn.addEventListener('click', () => updateView('diagram'));
      codeBtn.addEventListener('click', () => updateView('code'));

      // Click diagram to fullscreen (only if it's a valid SVG, not error)
      diagramContainer.addEventListener('click', () => {
        const svgElement = diagramContainer.querySelector('svg');
        if (svgElement) {
          openFullscreen(diagramContainer.innerHTML);
        }
      });
    }

    if (initializedMermaidTheme) {
      wrapper.dataset.gvMermaidTheme = initializedMermaidTheme;
    }

    const existingLightExport = wrapper.querySelector<HTMLTemplateElement>(
      `template.${MERMAID_LIGHT_EXPORT_TEMPLATE_CLASS}`,
    );
    if (lightExportSvg) {
      const lightExport = existingLightExport ?? document.createElement('template');
      lightExport.className = MERMAID_LIGHT_EXPORT_TEMPLATE_CLASS;
      lightExport.innerHTML = await sanitizeMermaidSvg(lightExportSvg);
      if (!existingLightExport) wrapper.appendChild(lightExport);
    } else {
      existingLightExport?.remove();
    }

    const diagramContainer = wrapper.querySelector('.gv-mermaid-diagram') as HTMLElement;
    if (!diagramContainer) {
      codeBlock.dataset.mermaidProcessing = 'false';
      return;
    }

    if (renderErrorMessage !== null) {
      diagramContainer.replaceChildren(createMermaidErrorCard(renderErrorMessage));
    } else {
      diagramContainer.innerHTML = await sanitizeMermaidSvg(svg);
    }

    codeBlock.dataset.mermaidCode = normalizedCode;
    codeBlock.dataset.mermaidProcessing = 'false';
    console.log('[Gemini Voyager] Mermaid diagram rendered:', uniqueId);
  } catch {
    codeBlock.dataset.mermaidProcessing = 'false';

    const codeBlockHost = codeBlock.closest('code-block') as HTMLElement;
    if (codeBlockHost) {
      codeBlockHost.style.display = '';
    }
  }
};

/** @internal Exported for theme-marker testing. */
export const _renderMermaidForTest = renderMermaid;

/**
 * Get the language label from a code block's header decoration
 * Returns the language name (lowercase) or null if not found
 */
const getCodeBlockLanguage = (codeEl: Element): string | null => {
  // Navigate up to find the code-block container
  const codeBlock = codeEl.closest('.code-block, code-block');
  if (!codeBlock) return null;

  // Look for the language label in the header decoration
  // Gemini uses: <div class="code-block-decoration"><span>Language</span>...</div>
  const decoration = codeBlock.querySelector('.code-block-decoration');
  if (!decoration) return null;

  // The first span child typically contains the language name
  const langSpan = decoration.querySelector(':scope > span');
  if (!langSpan) return null;

  const language = langSpan.textContent?.trim().toLowerCase();
  return language || null;
};

/**
 * Find and process code blocks
 */
const processCodeBlocks = () => {
  const codeElements = document.querySelectorAll('code[data-test-id="code-content"]');

  codeElements.forEach((codeEl) => {
    const codeText = codeEl.textContent || '';

    // Check the language label from Gemini's code block header
    const language = getCodeBlockLanguage(codeEl);

    // Case 1: Language is explicitly "mermaid" - always render
    if (language === 'mermaid') {
      renderMermaid(codeEl as HTMLElement, codeText);
      return;
    }

    // Case 2: Language is a specific programming language (not generic) - skip rendering
    // This prevents false positives for MATLAB (%% comments), Python, etc.
    if (language && !isGenericLanguageLabel(language)) {
      return;
    }

    // Case 3: No language label or generic label - use content detection
    if (isMermaidCode(codeText)) {
      renderMermaid(codeEl as HTMLElement, codeText);
    }
  });
};

/**
 * Track whether Mermaid is enabled
 */
let mermaidEnabled = true;
let observer: MutationObserver | null = null;

/**
 * Start Mermaid feature
 */
export const startMermaid = () => {
  // Check if Mermaid rendering is enabled in settings
  chrome.storage?.sync?.get({ gvMermaidEnabled: true }, (result) => {
    mermaidEnabled = result?.gvMermaidEnabled !== false;

    if (mermaidEnabled) {
      initializeMermaid();
    } else {
      console.log('[Gemini Voyager] Mermaid rendering is disabled');
    }
  });

  // Listen for setting changes
  chrome.storage?.onChanged?.addListener((changes, areaName) => {
    if (areaName === 'sync' && changes.gvMermaidEnabled) {
      mermaidEnabled = changes.gvMermaidEnabled.newValue !== false;
      if (mermaidEnabled) {
        initializeMermaid();
        console.log('[Gemini Voyager] Mermaid rendering enabled');
      } else {
        // Stop observing when disabled
        if (observer) {
          observer.disconnect();
          observer = null;
        }
        console.log('[Gemini Voyager] Mermaid rendering disabled');
      }
    }
  });
};

/**
 * Initialize Mermaid rendering
 */
const initializeMermaid = async () => {
  createStyles();

  const loaded = await initMermaid();
  if (!loaded) {
    console.warn('[Gemini Voyager] Mermaid library failed to load, diagrams will show as code');
    return;
  }

  processCodeBlocks();

  // Only create observer if not already exists
  if (!observer) {
    let timeout: ReturnType<typeof setTimeout>;
    const debouncedProcess = () => {
      if (!mermaidEnabled) return;
      clearTimeout(timeout);
      timeout = setTimeout(processCodeBlocks, 1000);
    };

    observer = new MutationObserver(() => {
      debouncedProcess();
    });

    observer.observe(document.body, {
      childList: true,
      subtree: true,
      characterData: true,
    });
  }

  console.log('[Gemini Voyager] Mermaid integration started');
};
