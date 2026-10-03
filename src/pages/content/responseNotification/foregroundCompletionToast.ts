const FOREGROUND_TOAST_ID = 'gv-response-complete-toast';
const FOREGROUND_TOAST_TEXT_KEY = 'responseCompleteForegroundToast';
const FOREGROUND_TOAST_TEXT_FALLBACK = 'New response completed';
const FOREGROUND_TOAST_TRANSFORM_HIDDEN = 'translate(-50%, 10px)';
const FOREGROUND_TOAST_TRANSFORM_VISIBLE = 'translate(-50%, 0)';
const FOREGROUND_TOAST_DEFAULT_BOTTOM_PX = 148;
const FOREGROUND_TOAST_MIN_EDGE_GAP_PX = 24;
const FOREGROUND_TOAST_BOTTOM_GAP_FROM_PROMPT_PX = 22;
const FOREGROUND_TOAST_MIN_BOTTOM_PX = 96;
const FOREGROUND_TOAST_Z_INDEX = '2147483647';
const FOREGROUND_TOAST_MIN_WIDTH_PX = 150;
const FOREGROUND_TOAST_MAX_WIDTH_PX = 280;
const FOREGROUND_TOAST_MAX_VIEWPORT_WIDTH_PERCENT = 78;
const FOREGROUND_TOAST_VISIBLE_MS = 3200;
const LATEST_RESPONSE_VISIBLE_MARGIN_PX = 96;
const BOTTOM_SCROLL_THRESHOLD_PX = 160;
const PROMPT_CONTAINER_MAX_PARENT_DEPTH = 10;
const PROMPT_CONTAINER_MIN_WIDTH_PX = 280;
const PROMPT_CONTAINER_MIN_HEIGHT_PX = 44;
const PROMPT_CONTAINER_MAX_HEIGHT_PX = 260;
const PROMPT_CONTAINER_VIEWPORT_BOTTOM_TOLERANCE_PX = 8;
const PROMPT_CONTAINER_BOTTOM_TARGET_OFFSET_PX = 72;
const PROMPT_CONTAINER_WIDTH_SCORE_LIMIT_PX = 900;
const PROMPT_CONTAINER_WIDTH_SCORE_DIVISOR = 10;
const PROMPT_CONTAINER_BORDER_RADIUS_SCORE_LIMIT_PX = 36;
const PROMPT_CONTAINER_BORDER_RADIUS_SCORE_MULTIPLIER = 4;
const PROMPT_CONTAINER_BOTTOM_SCORE_BASE = 220;
const PROMPT_CONTAINER_DEPTH_PENALTY_MULTIPLIER = 8;
const PROMPT_CONTAINER_FULL_WIDTH_RATIO = 0.95;
const PROMPT_CONTAINER_FULL_WIDTH_PENALTY = 180;

function getI18nMessage(key: string, fallback: string): string {
  try {
    return chrome.i18n?.getMessage?.(key) || fallback;
  } catch {
    return fallback;
  }
}

function getForegroundToastText(): string {
  return getI18nMessage(FOREGROUND_TOAST_TEXT_KEY, FOREGROUND_TOAST_TEXT_FALLBACK);
}

function getPromptContainerRect(promptSelector: string): DOMRect | null {
  const promptElements = Array.from(document.querySelectorAll<HTMLElement>(promptSelector));
  let bestRect: DOMRect | null = null;
  let bestScore = -Infinity;

  for (const promptElement of promptElements) {
    let current: HTMLElement | null = promptElement;

    for (let depth = 0; current && depth < PROMPT_CONTAINER_MAX_PARENT_DEPTH; depth += 1) {
      const rect = current.getBoundingClientRect();
      const isVisible =
        rect.width > PROMPT_CONTAINER_MIN_WIDTH_PX &&
        rect.height >= PROMPT_CONTAINER_MIN_HEIGHT_PX &&
        rect.height <= PROMPT_CONTAINER_MAX_HEIGHT_PX &&
        rect.top > 0 &&
        rect.bottom <= window.innerHeight + PROMPT_CONTAINER_VIEWPORT_BOTTOM_TOLERANCE_PX &&
        rect.right > 0 &&
        rect.left < window.innerWidth;

      if (isVisible) {
        const style = window.getComputedStyle(current);
        const borderRadius = Number.parseFloat(style.borderTopLeftRadius || '0');
        const distanceFromBottom = Math.abs(
          window.innerHeight - rect.bottom - PROMPT_CONTAINER_BOTTOM_TARGET_OFFSET_PX,
        );
        const widthScore =
          Math.min(rect.width, PROMPT_CONTAINER_WIDTH_SCORE_LIMIT_PX) /
          PROMPT_CONTAINER_WIDTH_SCORE_DIVISOR;
        const roundedScore =
          Math.min(borderRadius, PROMPT_CONTAINER_BORDER_RADIUS_SCORE_LIMIT_PX) *
          PROMPT_CONTAINER_BORDER_RADIUS_SCORE_MULTIPLIER;
        const bottomScore = Math.max(0, PROMPT_CONTAINER_BOTTOM_SCORE_BASE - distanceFromBottom);
        const depthPenalty = depth * PROMPT_CONTAINER_DEPTH_PENALTY_MULTIPLIER;
        const fullPagePenalty =
          rect.width > window.innerWidth * PROMPT_CONTAINER_FULL_WIDTH_RATIO
            ? PROMPT_CONTAINER_FULL_WIDTH_PENALTY
            : 0;
        const score = widthScore + roundedScore + bottomScore - depthPenalty - fullPagePenalty;

        if (score > bestScore) {
          bestScore = score;
          bestRect = rect;
        }
      }

      current = current.parentElement;
    }
  }

  return bestRect;
}

function getDocumentScrollRoot(): HTMLElement {
  return document.scrollingElement instanceof HTMLElement
    ? document.scrollingElement
    : document.documentElement;
}

function getScrollRoot(anchor: Element | null = null): HTMLElement {
  let current = anchor?.parentElement ?? null;

  while (current && current !== document.body) {
    const style = window.getComputedStyle(current);
    const hasScrollableOverflow = /auto|scroll|overlay/.test(style.overflowY);
    if (
      hasScrollableOverflow &&
      current.scrollHeight - current.clientHeight > BOTTOM_SCROLL_THRESHOLD_PX
    ) {
      return current;
    }
    current = current.parentElement;
  }

  return getDocumentScrollRoot();
}

function getRemainingScrollDistance(anchor: Element | null = null): number {
  const scrollRoot = getScrollRoot(anchor);
  return Math.max(0, scrollRoot.scrollHeight - scrollRoot.scrollTop - scrollRoot.clientHeight);
}

function isLatestResponseVisible(response: HTMLElement): boolean {
  const rect = response.getBoundingClientRect();
  if (rect.height <= 0 || rect.width <= 0) return false;

  return (
    rect.bottom >= LATEST_RESPONSE_VISIBLE_MARGIN_PX &&
    rect.top <= window.innerHeight - LATEST_RESPONSE_VISIBLE_MARGIN_PX
  );
}

function shouldShowForegroundCompletionToast(response: HTMLElement | null): boolean {
  if (!response) return false;
  if (isLatestResponseVisible(response)) return false;
  return getRemainingScrollDistance(response) > BOTTOM_SCROLL_THRESHOLD_PX;
}

export function createForegroundCompletionToast({
  promptSelector,
  getScrollTarget,
}: {
  promptSelector: string;
  getScrollTarget: () => HTMLElement | null;
}) {
  let toastHideTimer: number | null = null;

  function scrollToLatestResponse(): void {
    const target = getScrollTarget();

    if (target) {
      target.scrollIntoView({
        block: 'end',
        behavior: 'smooth',
      });
      hideForegroundCompletionToast();
      return;
    }

    const scrollRoot = getScrollRoot();
    scrollRoot.scrollTo({
      top: scrollRoot.scrollHeight,
      behavior: 'smooth',
    });
    hideForegroundCompletionToast();
  }

  function ensureForegroundToast(): HTMLDivElement {
    const existing = document.getElementById(FOREGROUND_TOAST_ID);
    if (existing instanceof HTMLDivElement) return existing;

    const toast = document.createElement('div');
    toast.id = FOREGROUND_TOAST_ID;
    toast.textContent = getForegroundToastText();
    toast.setAttribute('role', 'button');
    toast.setAttribute('aria-live', 'polite');
    toast.tabIndex = 0;
    toast.addEventListener('click', scrollToLatestResponse);
    toast.addEventListener('keydown', (event) => {
      if (event.key !== 'Enter' && event.key !== ' ') return;
      event.preventDefault();
      scrollToLatestResponse();
    });
    Object.assign(toast.style, {
      position: 'fixed',
      left: '50%',
      bottom: `${FOREGROUND_TOAST_DEFAULT_BOTTOM_PX}px`,
      transform: FOREGROUND_TOAST_TRANSFORM_HIDDEN,
      zIndex: FOREGROUND_TOAST_Z_INDEX,
      minWidth: `${FOREGROUND_TOAST_MIN_WIDTH_PX}px`,
      maxWidth: `min(${FOREGROUND_TOAST_MAX_VIEWPORT_WIDTH_PERCENT}vw, ${FOREGROUND_TOAST_MAX_WIDTH_PX}px)`,
      boxSizing: 'border-box',
      padding: '10px 24px',
      borderRadius: '999px',
      background: 'rgba(232, 240, 254, 0.96)',
      color: '#1f1f1f',
      fontSize: '16px',
      lineHeight: '22px',
      fontWeight: '400',
      textAlign: 'center',
      boxShadow: '0 18px 48px rgba(60, 64, 67, 0.18)',
      opacity: '0',
      cursor: 'pointer',
      pointerEvents: 'auto',
      transition: 'opacity 180ms ease, transform 180ms ease',
      userSelect: 'none',
    } satisfies Partial<CSSStyleDeclaration>);

    document.body.appendChild(toast);
    return toast;
  }

  function hideForegroundCompletionToast(): void {
    const toast = document.getElementById(FOREGROUND_TOAST_ID);
    if (!(toast instanceof HTMLDivElement)) return;

    toast.style.opacity = '0';
    toast.style.transform = FOREGROUND_TOAST_TRANSFORM_HIDDEN;
  }

  function showForegroundCompletionToast(): void {
    const toast = ensureForegroundToast();
    const promptRect = getPromptContainerRect(promptSelector);
    if (promptRect !== null) {
      const centerX = Math.min(
        window.innerWidth - FOREGROUND_TOAST_MIN_EDGE_GAP_PX,
        Math.max(FOREGROUND_TOAST_MIN_EDGE_GAP_PX, promptRect.left + promptRect.width / 2),
      );
      const bottom = Math.max(
        FOREGROUND_TOAST_MIN_BOTTOM_PX,
        window.innerHeight - promptRect.top + FOREGROUND_TOAST_BOTTOM_GAP_FROM_PROMPT_PX,
      );
      toast.style.left = `${centerX}px`;
      toast.style.bottom = `${bottom}px`;
    } else {
      toast.style.left = '50%';
      toast.style.bottom = `${FOREGROUND_TOAST_DEFAULT_BOTTOM_PX}px`;
    }

    const toastText = getForegroundToastText();
    toast.textContent = toastText;
    toast.setAttribute('aria-label', toastText);
    toast.style.opacity = '1';
    toast.style.transform = FOREGROUND_TOAST_TRANSFORM_VISIBLE;

    if (toastHideTimer !== null) {
      clearTimeout(toastHideTimer);
    }
    toastHideTimer = window.setTimeout(() => {
      toastHideTimer = null;
      hideForegroundCompletionToast();
    }, FOREGROUND_TOAST_VISIBLE_MS);
  }

  return {
    showIfNeeded(response: HTMLElement | null): void {
      if (shouldShowForegroundCompletionToast(response)) showForegroundCompletionToast();
    },
    stop(): void {
      if (toastHideTimer !== null) {
        clearTimeout(toastHideTimer);
        toastHideTimer = null;
      }
      hideForegroundCompletionToast();
    },
  };
}
