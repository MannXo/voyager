/**
 * Fullscreen viewer state
 */
let currentModal: HTMLElement | null = null;

/**
 * Open fullscreen viewer for SVG
 */
export const openFullscreen = (svgHtml: string) => {
  if (currentModal) return;

  let scale = 1;
  let translateX = 0;
  let translateY = 0;
  let isDragging = false;
  let startX = 0;
  let startY = 0;

  // Create modal
  const modal = document.createElement('div');
  modal.className = 'gv-mermaid-modal';

  // Toolbar
  const toolbar = document.createElement('div');
  toolbar.className = 'gv-mermaid-modal-toolbar';

  const zoomInBtn = document.createElement('button');
  zoomInBtn.innerHTML = '+';
  zoomInBtn.title = 'Zoom In';

  const zoomOutBtn = document.createElement('button');
  zoomOutBtn.innerHTML = '−';
  zoomOutBtn.title = 'Zoom Out';

  const resetBtn = document.createElement('button');
  resetBtn.innerHTML = '⊙';
  resetBtn.title = 'Reset';

  const closeBtn = document.createElement('button');
  closeBtn.innerHTML = '✕';
  closeBtn.title = 'Close (ESC)';

  toolbar.appendChild(zoomInBtn);
  toolbar.appendChild(zoomOutBtn);
  toolbar.appendChild(resetBtn);
  toolbar.appendChild(closeBtn);

  // Content container
  const content = document.createElement('div');
  content.className = 'gv-mermaid-modal-content';
  content.innerHTML = svgHtml;

  // Hint
  const hint = document.createElement('div');
  hint.className = 'gv-mermaid-modal-hint';
  hint.textContent = 'Scroll to zoom • Drag to pan • ESC to close';

  modal.appendChild(toolbar);
  modal.appendChild(content);
  modal.appendChild(hint);
  document.body.appendChild(modal);
  currentModal = modal;

  // Initial fit scale (updated after auto-fit calculation)
  let initialScale = 1;

  // Apply transform
  const applyTransform = () => {
    content.style.transform = `translate(${translateX}px, ${translateY}px) scale(${scale})`;
  };

  // Zoom functions
  const zoomIn = () => {
    scale = Math.min(scale * 1.2, 10);
    applyTransform();
  };

  const zoomOut = () => {
    scale = Math.max(scale / 1.2, 0.1);
    applyTransform();
  };

  const resetView = () => {
    scale = initialScale;
    translateX = 0;
    translateY = 0;
    applyTransform();
  };

  let closing = false;
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
  const handleKeyDown = (e: KeyboardEvent) => {
    if (e.key === 'Escape') closeModal();
  };
  const removeDocumentListeners = () => {
    document.removeEventListener('keydown', handleKeyDown);
    document.removeEventListener('mousemove', handleMouseMove);
    document.removeEventListener('mouseup', handleMouseUp);
  };
  const closeModal = () => {
    if (closing) return;
    closing = true;
    removeDocumentListeners();
    handleMouseUp();
    modal.classList.remove('visible');
    setTimeout(() => {
      modal.remove();
      currentModal = null;
    }, 300);
  };

  // Event listeners
  zoomInBtn.addEventListener('click', zoomIn);
  zoomOutBtn.addEventListener('click', zoomOut);
  resetBtn.addEventListener('click', resetView);
  closeBtn.addEventListener('click', closeModal);

  // Click backdrop to close
  modal.addEventListener('click', (e) => {
    if (e.target === modal) closeModal();
  });

  // ESC to close
  document.addEventListener('keydown', handleKeyDown);

  // Mouse wheel zoom
  modal.addEventListener(
    'wheel',
    (e) => {
      e.preventDefault();
      if (e.deltaY < 0) {
        scale = Math.min(scale * 1.1, 10);
      } else {
        scale = Math.max(scale / 1.1, 0.1);
      }
      applyTransform();
    },
    { passive: false },
  );

  // Drag to pan
  content.addEventListener('mousedown', (e) => {
    isDragging = true;
    startX = e.clientX - translateX;
    startY = e.clientY - translateY;
    content.classList.add('dragging');
  });

  document.addEventListener('mousemove', handleMouseMove);
  document.addEventListener('mouseup', handleMouseUp);

  // Auto-fit SVG to viewport
  const svgElement = content.querySelector('svg');
  if (svgElement) {
    const padding = 80; // px padding from viewport edges
    const viewportWidth = window.innerWidth - padding * 2;
    const viewportHeight = window.innerHeight - padding * 2;
    const svgWidth = svgElement.scrollWidth || svgElement.clientWidth;
    const svgHeight = svgElement.scrollHeight || svgElement.clientHeight;

    if (svgWidth > 0 && svgHeight > 0) {
      const fitScale = Math.min(viewportWidth / svgWidth, viewportHeight / svgHeight);
      // Scale to fit viewport: scale down if too large, scale up if too small
      scale = Math.min(Math.max(fitScale, 0.1), 10);
      initialScale = scale;
      applyTransform();
    }
  }

  // Show modal with animation
  requestAnimationFrame(() => {
    modal.classList.add('visible');
  });
};
