/**
 * Floating export UI (progress pill, selection bar) centred over the conversation.
 *
 * Gemini's conversation column is offset by the sidebar, so a plain
 * `left: 50%` would centre these elements over the whole window. Alignment
 * finds the visible conversation canvas instead and keeps tracking resizes
 * until the returned cleanup runs.
 */
import type { ExportTranslate } from './exportLocale';

export const EXPORT_PROGRESS_OVERLAY_CLASS = 'gv-export-progress-overlay';

/** Conversation landmarks used when no chat canvas or composer is visible. */
export interface ConversationAnchors {
  topUserElement(): HTMLElement | null;
  conversationRoot(): HTMLElement;
}

function isElementVisibleForAlignment(el: HTMLElement): boolean {
  const rect = el.getBoundingClientRect();
  if (rect.width < 24 || rect.height < 12) return false;

  const style = window.getComputedStyle(el);
  if (style.display === 'none' || style.visibility === 'hidden') return false;
  const opacity = Number.parseFloat(style.opacity || '1');
  if (Number.isFinite(opacity) && opacity <= 0.01) return false;

  return true;
}

function isLikelySidebarElement(el: HTMLElement): boolean {
  if (
    el.closest(
      [
        '[data-test-id="side-nav"]',
        'side-navigation',
        'mat-sidenav',
        'aside',
        'nav',
        '.side-nav',
        '.sidenav',
        '.chat-history-nav',
      ].join(','),
    )
  ) {
    return true;
  }

  const rect = el.getBoundingClientRect();
  const isNarrow = rect.width > 0 && rect.width <= Math.max(380, window.innerWidth * 0.45);
  const isLeftRail = rect.left <= Math.max(40, window.innerWidth * 0.18);
  const isTall = rect.height >= window.innerHeight * 0.35;
  return isNarrow && isLeftRail && isTall;
}

function pickBestVisibleAlignmentTarget(
  selectors: string[],
  options?: {
    minWidth?: number;
    minHeight?: number;
    allowSidebar?: boolean;
  },
): HTMLElement | null {
  const candidates = Array.from(document.querySelectorAll<HTMLElement>(selectors.join(',')));
  let best: { el: HTMLElement; score: number } | null = null;
  const minWidth = options?.minWidth ?? 220;
  const minHeight = options?.minHeight ?? 24;
  const viewportCenter = window.innerWidth / 2;

  for (const candidate of candidates) {
    if (!candidate.isConnected) continue;
    if (!isElementVisibleForAlignment(candidate)) continue;
    if (!options?.allowSidebar && isLikelySidebarElement(candidate)) continue;

    const rect = candidate.getBoundingClientRect();
    if (rect.width < minWidth || rect.height < minHeight) continue;
    if (rect.bottom < -16 || rect.top > window.innerHeight + 16) continue;

    const center = rect.left + rect.width / 2;
    const area = rect.width * rect.height;
    const distancePenalty = Math.abs(center - viewportCenter) * 120;
    const score = area - distancePenalty;

    if (!best || score > best.score) {
      best = { el: candidate, score };
    }
  }

  return best?.el || null;
}

function resolveConversationCanvasCenterX(anchors: ConversationAnchors): number {
  const viewportCenter = window.innerWidth / 2;

  const canvasTarget = pickBestVisibleAlignmentTarget(
    [
      '#chat-history',
      'infinite-scroller.chat-history',
      '.chat-history-scroll-container',
      'chat-window-content',
      'main chat-window-content',
    ],
    {
      minWidth: Math.min(420, Math.max(280, window.innerWidth * 0.42)),
      minHeight: 80,
    },
  );
  if (canvasTarget) {
    const rect = canvasTarget.getBoundingClientRect();
    return rect.left + rect.width / 2;
  }

  const composerTarget = pickBestVisibleAlignmentTarget(
    [
      'rich-textarea',
      '[aria-label*="Enter a prompt"]',
      '[aria-label*="prompt"]',
      '[aria-label*="Gemini"]',
      '[contenteditable="true"][aria-label]',
    ],
    {
      minWidth: Math.min(460, Math.max(240, window.innerWidth * 0.28)),
      minHeight: 28,
    },
  );
  if (composerTarget) {
    const rect = composerTarget.getBoundingClientRect();
    return rect.left + rect.width / 2;
  }

  const topUser = anchors.topUserElement();
  if (topUser && !isLikelySidebarElement(topUser)) {
    const rect = topUser.getBoundingClientRect();
    if (rect.width > 24) return rect.left + rect.width / 2;
  }

  const root = anchors.conversationRoot();
  if (root && !isLikelySidebarElement(root)) {
    const rect = root.getBoundingClientRect();
    if (rect.width > Math.max(300, window.innerWidth * 0.42)) return rect.left + rect.width / 2;
  }

  const main = document.querySelector<HTMLElement>('main');
  if (main && !isLikelySidebarElement(main)) {
    const rect = main.getBoundingClientRect();
    if (rect.width > 24) return rect.left + rect.width / 2;
  }

  return viewportCenter;
}

/**
 * Centre a fixed-position element over the conversation canvas (never over
 * the sidebar), re-aligning on resize and once more after layout settles.
 * At 640 px or narrower the inline position is removed so CSS takes over.
 * Returns a cleanup that stops tracking.
 */
export function alignToConversationCenter(
  element: HTMLElement,
  anchors: ConversationAnchors,
): () => void {
  const apply = () => {
    if (window.innerWidth <= 640) {
      element.style.removeProperty('left');
      element.style.removeProperty('transform');
      return;
    }

    const rawCenter = resolveConversationCanvasCenterX(anchors);
    const safeMargin = 24;
    const clampedCenter = Math.round(
      Math.max(safeMargin, Math.min(window.innerWidth - safeMargin, rawCenter)),
    );
    element.style.left = `${clampedCenter}px`;
    element.style.transform = 'translateX(-50%)';
  };

  apply();
  const resizeHandler = () => apply();
  window.addEventListener('resize', resizeHandler);
  const timeoutId = window.setTimeout(apply, 220);

  return () => {
    window.removeEventListener('resize', resizeHandler);
    window.clearTimeout(timeoutId);
  };
}

/** Remove every export progress pill currently on the page. */
export function removeExportProgressOverlays(): void {
  document
    .querySelectorAll<HTMLElement>(`.${EXPORT_PROGRESS_OVERLAY_CLASS}`)
    .forEach((overlay) => overlay.remove());
}

/**
 * Show the progress pill, replacing any pill already shown (they never stack).
 * Defaults to "Export..." / "Loading". Returns a function that hides it.
 */
export function showExportProgressOverlay(
  anchors: ConversationAnchors,
  t: ExportTranslate,
  options?: { title?: string; desc?: string },
): () => void {
  // Never stack duplicate progress pills (e.g. export dialog progress followed
  // by the scroll-collection banner) on top of each other.
  removeExportProgressOverlays();

  const overlay = document.createElement('div');
  overlay.className = EXPORT_PROGRESS_OVERLAY_CLASS;

  const card = document.createElement('div');
  card.className = 'gv-export-progress-card';

  const spinner = document.createElement('div');
  spinner.className = 'gv-export-progress-spinner';

  const title = document.createElement('div');
  title.className = 'gv-export-progress-title';
  title.textContent = options?.title ?? `${t('pm_export')}...`;

  const desc = document.createElement('div');
  desc.className = 'gv-export-progress-desc';
  desc.textContent = options?.desc ?? t('loading');

  card.appendChild(spinner);
  card.appendChild(title);
  card.appendChild(desc);
  overlay.appendChild(card);
  document.body.appendChild(overlay);
  const unbindAlignment = alignToConversationCenter(overlay, anchors);

  return () => {
    unbindAlignment();
    try {
      overlay.remove();
    } catch {}
  };
}
