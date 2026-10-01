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

  it('re-matches a long run of repeats after a shift, past the alignment budget', () => {
    const turns: Array<readonly [string, number]> = [
      ['start', 0],
      ...Array.from({ length: 5_000 }, (_, index) => ['continue', 100 * (index + 1)] as const),
      ['end', 100 * 5_001],
    ];
    const known = merge([], turns);
    const ids = known.map((marker) => marker.id);

    const next = merge(
      known,
      turns.map(([summary, center]) => [summary, center + 100] as const),
    );

    expect(next.map((marker) => marker.id)).toEqual(ids);
  });

  it('keeps every turn of a long identical run after a uniform shift with no anchor', () => {
    const turns = Array.from(
      { length: 500 },
      (_, index) => ['continue', 100 * (index + 1)] as const,
    );
    const known = merge([], turns);
    const ids = known.map((marker) => marker.id);

    const next = merge(
      known,
      turns.map(([summary, center]) => [summary, center + 100] as const),
    );

    expect(next.map((marker) => marker.id)).toEqual(ids);
  });

  it.each([5_000, 4_999, 3_000])(
    'reads a bounded number of remembered positions for %i identical turns against 5000',
    (mountedCount) => {
      const known = merge(
        [],
        Array.from({ length: 5_000 }, () => ['continue', 0] as const),
      );
      let reads = 0;
      for (const marker of known) {
        let center = marker.center;
        Object.defineProperty(marker, 'center', {
          configurable: true,
          get: () => {
            reads += 1;
            return center;
          },
          set: (value: number) => {
            center = value;
          },
        });
      }

      const next = merge(
        known,
        Array.from({ length: mountedCount }, () => ['continue', 100] as const),
      );

      expect(reads).toBeLessThan(50 * known.length);
      // Every mounted turn is one of the remembered ones.
      expect(next).toHaveLength(known.length);
    },
  );

  it('files a window mounted deep in a long identical run by position', () => {
    const known = merge(
      [],
      Array.from({ length: 700 }, (_, index) => ['continue', 100 * (index + 1)] as const),
    );
    const ids = known.map((marker) => marker.id);
    const window = render(
      Array.from({ length: 400 }, (_, r) => ['continue', 100 * (300 + r + 1)] as const),
    );

    const next = mergeMountedTurns(known, window, (element) => centers.get(element) ?? 0);

    expect(next.map((marker) => marker.id)).toEqual(ids);
    expect(window.map((turn) => turn.element.getAttribute('data-gv-turn-id'))).toEqual(
      ids.slice(300),
    );
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
