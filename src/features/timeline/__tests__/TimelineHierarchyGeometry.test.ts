import { describe, expect, it } from 'vitest';

import { TimelineHierarchyGeometry } from '../TimelineHierarchyGeometry';
import type { MarkerLevel, TimelineMarker } from '../types';

function marker(id: string, baseN: number): TimelineMarker {
  return {
    id,
    baseN,
    element: document.createElement('div'),
    summary: id,
    assistantSummary: '',
    starred: false,
  };
}

describe('shared hierarchy geometry', () => {
  it('hides nested descendants up to the next sibling and redistributes their weighted length', () => {
    const markers = [
      marker('parent', 0.1),
      marker('child', 0.4),
      marker('grandchild', 0.8),
      marker('sibling', 1),
    ];
    const levels: Record<string, MarkerLevel> = { parent: 1, child: 2, grandchild: 3, sibling: 1 };
    const geometry = new TimelineHierarchyGeometry(
      () => markers,
      (id) => levels[id],
      (id) => id === 'parent',
    );
    expect(geometry.getHiddenMarkerIndices()).toEqual(new Set());
    geometry.markerLevelEnabled = true;
    const hidden = geometry.getHiddenMarkerIndices();
    expect(hidden).toEqual(new Set([1, 2]));
    expect(geometry.canCollapseMarker('parent')).toBe(true);
    expect(geometry.canCollapseMarker('sibling')).toBe(false);
    const positions = geometry.calculateCollapsedPositions(hidden, 10, 100);
    expect(positions.desiredY).toEqual([10, -1, -1, 110]);
    expect(positions.effectiveBaseNs[0]).toBeCloseTo(0.35);
  });
});
