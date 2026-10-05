/**
 * Static timeline replica shown by the timeline-style coachmarks while the live
 * rail is hidden. Markers carry both layouts (full-height dots and centred
 * ticks) so CSS can morph between styles by toggling one class.
 */

const PREVIEW_MARKER_COUNT = 14;
/** Same spacing rule as TimelineDotLayer's dense (compact/ruler) layout. */
const DENSE_MAX_GAP_PX = 8;
const DENSE_MAX_SPAN_PX = 160;

export const TIMELINE_STYLE_PREVIEW_ACTIVE_INDEX = Math.floor(PREVIEW_MARKER_COUNT / 2);

function createTimelineStylePreview(
  styleClass: string,
  decorateMarker?: (marker: HTMLElement, index: number) => void,
): HTMLElement {
  const preview = document.createElement('div');
  preview.className = `gv-timeline-style-preview ${styleClass}`;
  preview.setAttribute('aria-hidden', 'true');

  const last = PREVIEW_MARKER_COUNT - 1;
  const gap = Math.min(DENSE_MAX_GAP_PX, DENSE_MAX_SPAN_PX / last);
  for (let index = 0; index < PREVIEW_MARKER_COUNT; index += 1) {
    const marker = document.createElement('span');
    marker.style.setProperty('--gv-coach-n', String(index / last));
    marker.style.setProperty('--gv-coach-offset', `${(index - last / 2) * gap}px`);
    if (index === TIMELINE_STYLE_PREVIEW_ACTIVE_INDEX) marker.className = 'active';
    decorateMarker?.(marker, index);
    preview.appendChild(marker);
  }

  return preview;
}

/**
 * Pin the replica to the live rail's box, width and side so the guide previews
 * the rail where the user placed it. Without a laid-out live rail the CSS
 * defaults (the rail's own default placement) apply.
 */
function matchLiveTimelineGeometry(preview: HTMLElement, liveBar: HTMLElement | null): void {
  if (liveBar) {
    const barWidth = liveBar.style.getPropertyValue('--timeline-bar-width');
    if (barWidth) preview.style.setProperty('--timeline-bar-width', barWidth);
    preview.classList.toggle('gv-no-rail', liveBar.classList.contains('timeline-no-container'));
  }

  const rect = liveBar?.getBoundingClientRect();
  if (!rect || rect.width <= 0 || rect.height <= 0) return;
  preview.style.top = `${rect.top}px`;
  preview.style.left = `${rect.left}px`;
  preview.style.right = 'auto';
  preview.style.bottom = 'auto';
  preview.style.height = `${rect.height}px`;
}

/** Ticks grow toward the page content, like TimelineRailPlacement anchors the live rail. */
function pointTicksInward(preview: HTMLElement): void {
  const rect = preview.getBoundingClientRect();
  if (rect.width <= 0) return;
  const center = rect.left + rect.width / 2;
  preview.classList.toggle('gv-inward-right', center < window.innerWidth / 2);
}

export function mountTimelineStylePreview(
  styleClass: string,
  liveBar: HTMLElement | null,
  decorateMarker?: (marker: HTMLElement, index: number) => void,
): HTMLElement {
  const preview = createTimelineStylePreview(styleClass, decorateMarker);
  matchLiveTimelineGeometry(preview, liveBar);
  document.body.appendChild(preview);
  pointTicksInward(preview);
  return preview;
}
