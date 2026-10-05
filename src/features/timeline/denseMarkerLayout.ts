const DENSE_MAX_GAP_PX = 8;
const DENSE_MAX_SPAN_PX = 160;

/**
 * Vertical offsets (px from the rail's middle) for markers stacked by the dense
 * compact and ruler styles: an even gap that shrinks so long lists fit the span.
 */
export function denseMarkerOffsets(count: number): number[] {
  const gap = count > 1 ? Math.min(DENSE_MAX_GAP_PX, DENSE_MAX_SPAN_PX / (count - 1)) : 0;
  const center = (count - 1) / 2;
  return Array.from({ length: count }, (_, rank) => (rank - center) * gap);
}
