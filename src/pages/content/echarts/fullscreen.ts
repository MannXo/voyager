import { PANEL_BG } from './renderer';

const t = (key: string, fallback: string): string => {
  try {
    return chrome.i18n?.getMessage(key) || fallback;
  } catch {
    return fallback;
  }
};

export function createEChartsFullscreen(resize: (container: HTMLElement) => void) {
  let currentModal: HTMLElement | null = null;
  let closeActiveModal: (() => void) | null = null;
  let fullscreenWrapper: HTMLElement | null = null;
  /**
   * Open the chart fullscreen: the chart container is *moved* into the modal
   * card (an ECharts canvas renders wherever its DOM element lives — cloning
   * would lose the live instance), resized to the card, and moved back — and
   * resized again — on close.
   */
  const openFullscreen = (chartContainer: HTMLElement) => {
    if (currentModal) return;
    const previousFocus =
      document.activeElement instanceof HTMLElement ? document.activeElement : null;

    const modal = document.createElement('div');
    modal.className = 'gv-echarts-modal';
    modal.setAttribute('role', 'dialog');
    modal.setAttribute('aria-modal', 'true');
    modal.setAttribute('aria-label', t('echartsFullscreenButton', 'Fullscreen'));

    const toolbar = document.createElement('div');
    toolbar.className = 'gv-echarts-modal-toolbar';

    const closeBtn = document.createElement('button');
    closeBtn.type = 'button';
    closeBtn.innerHTML = '✕';
    const closeLabel = t('echartsCloseFullscreen', 'Close (ESC)');
    closeBtn.title = closeLabel;
    closeBtn.setAttribute('aria-label', closeLabel);

    toolbar.appendChild(closeBtn);

    const card = document.createElement('div');
    card.className = 'gv-echarts-modal-card';
    card.style.background = `var(--gv-echarts-panel-bg, ${PANEL_BG.light})`;
    card.style.setProperty(
      '--gv-echarts-panel-bg',
      chartContainer.style.getPropertyValue('--gv-echarts-panel-bg') || PANEL_BG.light,
    );

    const wrapper = chartContainer.parentElement as HTMLElement | null;
    card.appendChild(chartContainer);
    fullscreenWrapper = wrapper;

    const hint = document.createElement('div');
    hint.className = 'gv-echarts-modal-hint';
    hint.textContent = t('echartsFullscreenHint', 'Press ESC to close');

    modal.append(toolbar, card, hint);
    document.body.appendChild(modal);
    currentModal = modal;

    let closing = false;
    let closeTimer: ReturnType<typeof setTimeout> | null = null;
    let revealFrame: number | null = null;

    // Single registration point: every listener (including the document-level
    // keydown) is removed together on close, so no listener outlives the modal
    // even when it is torn down externally.
    const cleanupFns: Array<() => void> = [];
    const on = <K extends keyof DocumentEventMap>(
      target: EventTarget,
      type: K,
      handler: (e: DocumentEventMap[K]) => void,
    ) => {
      const listener = handler as EventListener;
      target.addEventListener(type, listener);
      cleanupFns.push(() => target.removeEventListener(type, listener));
    };
    const removeListeners = () => {
      cleanupFns.splice(0).forEach((remove) => remove());
    };

    const destroyModal = () => {
      if (closeTimer !== null) {
        clearTimeout(closeTimer);
        closeTimer = null;
      }
      if (revealFrame !== null) {
        cancelAnimationFrame(revealFrame);
        revealFrame = null;
      }
      removeListeners();
      modal.remove();
      if (currentModal === modal) currentModal = null;
      if (closeActiveModal === destroyModal) closeActiveModal = null;

      // Move the container back to its wrapper and let the canvas follow.
      if (fullscreenWrapper) {
        fullscreenWrapper.appendChild(chartContainer);
        fullscreenWrapper = null;
      }
      resize(chartContainer);
      if (previousFocus?.isConnected) previousFocus.focus({ preventScroll: true });
    };
    const closeModal = () => {
      if (closing) return;
      closing = true;
      modal.classList.remove('visible');
      closeTimer = setTimeout(destroyModal, 300);
    };
    closeActiveModal = destroyModal;

    on(closeBtn, 'click', closeModal);
    on(modal, 'click', (e) => {
      if (e.target === modal) closeModal();
    });
    on(document, 'keydown', (e) => {
      if (e.key === 'Escape') closeModal();
      if (e.key === 'Tab') {
        e.preventDefault();
        closeBtn.focus({ preventScroll: true });
      }
    });
    on(document, 'focusin', (e) => {
      if (!modal.contains(e.target as Node)) closeBtn.focus({ preventScroll: true });
    });

    closeBtn.focus({ preventScroll: true });

    // Size the canvas against the card, then fade in.
    revealFrame = requestAnimationFrame(() => {
      revealFrame = null;
      resize(chartContainer);
      modal.classList.add('visible');
    });
  };

  return {
    open: openFullscreen,
    close() {
      closeActiveModal?.();
      closeActiveModal = null;
    },
    findContainer(wrapper: HTMLElement): HTMLElement | null {
      return (
        wrapper.querySelector<HTMLElement>('.gv-echarts-diagram') ??
        (fullscreenWrapper === wrapper
          ? (currentModal?.querySelector<HTMLElement>('.gv-echarts-diagram') ?? null)
          : null)
      );
    },
    ownerOf(container: HTMLElement): HTMLElement | null {
      return (
        container.closest<HTMLElement>('.gv-echarts-wrapper') ??
        (currentModal?.contains(container) ? fullscreenWrapper : null)
      );
    },
    closeForWrapper(wrapper: HTMLElement) {
      if (fullscreenWrapper === wrapper) closeActiveModal?.();
    },
    closeDetached() {
      if (fullscreenWrapper && !fullscreenWrapper.isConnected) closeActiveModal?.();
    },
  };
}
