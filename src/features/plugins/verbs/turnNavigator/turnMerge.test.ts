/**
 * Marker stitching without a host key, as Claude and DeepSeek use it: turns
 * are told apart only by text and remembered position.
 */
import { describe, expect, it } from 'vitest';

import { type Marker, mergeMountedTurns } from './turnMerge';

interface Mounted {
  readonly element: HTMLElement;
  readonly summary: string;
}

const centers = new WeakMap<HTMLElement, number>();

/** Fresh elements, as a virtualized host renders them after a remount. */
function render(turns: ReadonlyArray<readonly [string, number]>): Mounted[] {
  return turns.map(([summary, center]) => {
    const element = document.createElement('div');
    element.textContent = summary;
    centers.set(element, center);
    return { element, summary };
  });
}

function merge(known: Marker[], turns: ReadonlyArray<readonly [string, number]>): Marker[] {
  return mergeMountedTurns(known, render(turns), (element) => centers.get(element) ?? 0);
}

describe('mergeMountedTurns without a turn key', () => {
  it('re-matches repeated prompts after a remount shifted every turn', () => {
    const known = merge(
      [],
      [
        ['continue', 100],
        ['continue', 200],
        ['anchor', 300],
      ],
    );
    const ids = known.map((marker) => marker.id);

    // The host re-measured the region: every centre moved down by 100px.
    const next = merge(known, [
      ['continue', 200],
      ['continue', 300],
      ['anchor', 400],
    ]);

    expect(next.map((marker) => marker.id)).toEqual(ids);
  });

  it('files a lone remounted repeat under the nearest remembered turn', () => {
    const known = merge(
      [],
      [
        ['hi', 100],
        ['x', 200],
        ['hi', 300],
      ],
    );
    const third = known[2].id;

    const [mounted] = render([['hi', 300]]);
    mergeMountedTurns(known, [mounted], () => 300);

    expect(mounted.element.getAttribute('data-gv-turn-id')).toBe(third);
  });

  it('keeps a genuinely new repeat as a new turn after its twin', () => {
    const known = merge([], [['continue', 100]]);

    const next = merge(known, [
      ['continue', 100],
      ['continue', 500],
    ]);

    expect(next).toHaveLength(2);
    expect(next[0].id).toBe(known[0].id);
  });
});
