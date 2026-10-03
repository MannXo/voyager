import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { TimelineRailPlacement } from '../TimelineRailPlacement';

const placements: TimelineRailPlacement[] = [];

function fixture() {
  const bar = document.createElement('div');
  document.body.appendChild(bar);
  Object.defineProperty(bar, 'setPointerCapture', { value: vi.fn() });
  vi.spyOn(bar, 'getBoundingClientRect').mockReturnValue(new DOMRect(100, 50, 24, 400));
  const onWidthChange = vi.fn();
  const owner = new TimelineRailPlacement({ getStyle: () => 'dots', onWidthChange });
  placements.push(owner);
  owner.mount(bar);
  owner.toggleDraggable(true);
  return { owner, bar, onWidthChange };
}

function pointer(type: string, clientX = 0, clientY = 0) {
  return new MouseEvent(type, { bubbles: true, clientX, clientY });
}

beforeEach(() => {
  vi.clearAllMocks();
});

afterEach(() => {
  placements.splice(0).forEach((placement) => placement.destroy());
  document.body.innerHTML = '';
  vi.restoreAllMocks();
});

describe('TimelineRailPlacement teardown', () => {
  it.each([
    { gesture: 'resize', startX: 110 },
    { gesture: 'position drag', startX: 101 },
  ])('abandons an active $gesture without saving or handling late pointer events', ({ startX }) => {
    const { owner, bar, onWidthChange } = fixture();
    bar.dispatchEvent(pointer('pointerdown', startX, 50));
    window.dispatchEvent(pointer('pointermove', 122, 80));
    if (startX === 110) expect(onWidthChange).toHaveBeenCalledOnce();
    else expect(bar.style.left).toBe('121px');
    const width = owner.barWidth;
    const style = bar.style.cssText;
    const widthChanges = onWidthChange.mock.calls.length;

    owner.destroy();
    window.dispatchEvent(pointer('pointermove', 200, 150));
    window.dispatchEvent(pointer('pointerup'));
    window.dispatchEvent(pointer('pointercancel'));
    bar.dispatchEvent(pointer('pointerdown', startX, 50));
    window.dispatchEvent(pointer('pointermove', 300, 180));
    window.dispatchEvent(pointer('pointerup'));

    expect(owner.barWidth).toBe(width);
    expect(bar.style.cssText).toBe(style);
    expect(onWidthChange).toHaveBeenCalledTimes(widthChanges);
    expect(chrome.storage.sync.set).not.toHaveBeenCalled();
    expect(bar.isConnected).toBe(true);
  });
});
