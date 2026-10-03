const t = (key: string, fallback: string): string => {
  try {
    return chrome.i18n?.getMessage(key) || fallback;
  } catch {
    return fallback;
  }
};

/**
 * Read the intrinsic diagram size from the SVG `viewBox`.
 * The rendered width/height are forced to 100% by the overlay, so scrollWidth
 * reflects the container, not the diagram — only the viewBox carries the real
 * aspect/size needed for auto-fitting.
 */
export const parseViewBoxSize = (svgEl: SVGSVGElement): { w: number; h: number } | null => {
  const vb = svgEl.getAttribute('viewBox')?.trim().split(/\s+/).map(Number);
  if (!vb || vb.length !== 4 || !(vb[2] > 0) || !(vb[3] > 0)) return null;
  return { w: vb[2], h: vb[3] };
};

/**
 * Scale factor that fits an intrinsic diagram size into a viewport, clamped to
 * the 0.1–10 zoom range (1 when the inputs are unusable).
 */
export const computeAutoFitScale = (
  intrinsicW: number,
  intrinsicH: number,
  viewportW: number,
  viewportH: number,
): number => {
  if (intrinsicW <= 0 || intrinsicH <= 0 || viewportW <= 0 || viewportH <= 0) return 1;
  return Math.min(Math.max(Math.min(viewportW / intrinsicW, viewportH / intrinsicH), 0.1), 10);
};

const mountModal = (svgHtml: string, panelBg: string) => {
  const modal = document.createElement('div');
  modal.className = 'gv-wavedrom-modal';

  const toolbar = document.createElement('div');
  toolbar.className = 'gv-wavedrom-modal-toolbar';

  const zoomInBtn = document.createElement('button');
  zoomInBtn.innerHTML = '+';
  zoomInBtn.title = t('wavedromZoomIn', 'Zoom In');

  const zoomOutBtn = document.createElement('button');
  zoomOutBtn.innerHTML = '−';
  zoomOutBtn.title = t('wavedromZoomOut', 'Zoom Out');

  const resetBtn = document.createElement('button');
  resetBtn.innerHTML = '⊙';
  resetBtn.title = t('wavedromResetView', 'Reset');

  const closeBtn = document.createElement('button');
  closeBtn.innerHTML = '✕';
  closeBtn.title = t('wavedromCloseFullscreen', 'Close (ESC)');

  toolbar.append(zoomInBtn, zoomOutBtn, resetBtn, closeBtn);

  // Card with explicit backdrop so the skin's white strokes are always visible.
  const card = document.createElement('div');
  card.dataset.testid = 'wavedrom-zoom-card';
  card.style.background = panelBg;
  card.style.borderRadius = '8px';
  card.style.padding = '12px';
  card.style.flexShrink = '0';

  const content = document.createElement('div');
  content.className = 'gv-wavedrom-modal-content';
  // The markup was sanitised with DOMPurify before it was inserted into the
  // diagram container, so this innerHTML only re-inserts already-safe markup.
  content.innerHTML = svgHtml;

  // Ensure the SVG fills the card (fix: remove fixed pixel w/h if viewBox present).
  const svgEl = content.querySelector('svg');
  if (svgEl?.hasAttribute('viewBox')) {
    svgEl.setAttribute('width', '100%');
    svgEl.setAttribute('height', '100%');
  }

  card.appendChild(content);

  const hint = document.createElement('div');
  hint.className = 'gv-wavedrom-modal-hint';
  hint.textContent = t('wavedromFullscreenHint', 'Scroll to zoom • Drag to pan • ESC to close');

  modal.append(toolbar, card, hint);
  document.body.appendChild(modal);
  return { modal, content, svgEl, zoomInBtn, zoomOutBtn, resetBtn, closeBtn };
};

const createViewport = (content: HTMLElement) => {
  let scale = 1;
  let translateX = 0;
  let translateY = 0;
  let isDragging = false;
  let startX = 0;
  let startY = 0;

  const applyTransform = () => {
    content.style.transform = `translate(${translateX}px, ${translateY}px) scale(${scale})`;
  };

  const zoomIn = () => {
    scale = Math.min(scale * 1.2, 10);
    applyTransform();
  };
  const zoomOut = () => {
    scale = Math.max(scale / 1.2, 0.1);
    applyTransform();
  };
  const resetView = () => {
    scale = 1;
    translateX = 0;
    translateY = 0;
    applyTransform();
  };

  const handleMouseMove = (e: MouseEvent) => {
    if (!isDragging) return;
    translateX = e.clientX - startX;
    translateY = e.clientY - startY;
    applyTransform();
  };
  const handleMouseUp = () => {
    isDragging = false;
    content.classList.remove('dragging');
  };
  const handleWheel = (e: WheelEvent) => {
    e.preventDefault();
    scale = e.deltaY < 0 ? Math.min(scale * 1.1, 10) : Math.max(scale / 1.1, 0.1);
    applyTransform();
  };
  const handleMouseDown = (e: MouseEvent) => {
    isDragging = true;
    startX = e.clientX - translateX;
    startY = e.clientY - translateY;
    content.classList.add('dragging');
  };
  return {
    zoomIn,
    zoomOut,
    resetView,
    handleWheel,
    handleMouseDown,
    handleMouseMove,
    handleMouseUp,
    applyTransform,
  };
};

const fitSvg = (svgEl: SVGSVGElement | null): boolean => {
  // Auto-fit the SVG to the viewport from its intrinsic viewBox size.
  if (svgEl) {
    const padding = 80;
    const vw = window.innerWidth - padding * 2;
    const vh = window.innerHeight - padding * 2;
    const intrinsic = parseViewBoxSize(svgEl);
    const w = intrinsic?.w ?? (svgEl.scrollWidth || svgEl.clientWidth);
    const h = intrinsic?.h ?? (svgEl.scrollHeight || svgEl.clientHeight);
    if (w > 0 && h > 0) {
      const fitScale = computeAutoFitScale(w, h, vw, vh);
      // Give the SVG a definite pixel box before zooming: the overlay forces
      // width/height to 100%, which resolves against an auto-sized flex item,
      // so the browser would otherwise fall back to the default
      // replaced-element viewport (300×150) while the scale is computed from
      // the viewBox.
      svgEl.style.width = `${w * fitScale}px`;
      svgEl.style.height = `${h * fitScale}px`;
      return true;
    }
  }

  return false;
};

/** Owns one cloned-SVG modal and all of its listeners, animation frames and close timers. */
export const createWaveDromFullscreen = () => {
  let currentModal: HTMLElement | null = null;
  let closeActiveModal: (() => void) | null = null;

  const open = (svgHtml: string, panelBg: string) => {
    if (currentModal) return;

    const { modal, content, svgEl, zoomInBtn, zoomOutBtn, resetBtn, closeBtn } = mountModal(
      svgHtml,
      panelBg,
    );
    currentModal = modal;

    const viewport = createViewport(content);
    let closing = false;
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') closeModal();
    };
    let closeTimer: ReturnType<typeof setTimeout> | null = null;
    let revealFrame: number | null = null;

    // Single registration point: every listener (including the document-level
    // keydown/mousemove/mouseup) is removed together on close, so no listener
    // outlives the modal even when it is torn down externally.
    const cleanupFns: Array<() => void> = [];
    const on = <K extends keyof DocumentEventMap>(
      target: EventTarget,
      type: K,
      handler: (e: DocumentEventMap[K]) => void,
      opts?: AddEventListenerOptions,
    ) => {
      const listener = handler as EventListener;
      target.addEventListener(type, listener, opts);
      cleanupFns.push(() => target.removeEventListener(type, listener, opts));
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
      viewport.handleMouseUp();
      modal.remove();
      if (currentModal === modal) currentModal = null;
      if (closeActiveModal === destroyModal) closeActiveModal = null;
    };
    const closeModal = () => {
      if (closing) return;
      closing = true;
      removeListeners();
      viewport.handleMouseUp();
      modal.classList.remove('visible');
      closeTimer = setTimeout(destroyModal, 300);
    };
    closeActiveModal = destroyModal;

    on(zoomInBtn, 'click', viewport.zoomIn);
    on(zoomOutBtn, 'click', viewport.zoomOut);
    on(resetBtn, 'click', viewport.resetView);
    on(closeBtn, 'click', closeModal);
    on(modal, 'click', (e) => {
      if (e.target === modal) closeModal();
    });
    on(document, 'keydown', handleKeyDown);
    on(modal, 'wheel', viewport.handleWheel, { passive: false });
    on(content, 'mousedown', viewport.handleMouseDown);
    on(document, 'mousemove', viewport.handleMouseMove);
    on(document, 'mouseup', viewport.handleMouseUp);

    if (fitSvg(svgEl)) viewport.applyTransform();

    revealFrame = requestAnimationFrame(() => {
      revealFrame = null;
      modal.classList.add('visible');
    });
  };

  return {
    open,
    close() {
      closeActiveModal?.();
      closeActiveModal = null;
    },
  };
};

export type WaveDromFullscreen = ReturnType<typeof createWaveDromFullscreen>;
