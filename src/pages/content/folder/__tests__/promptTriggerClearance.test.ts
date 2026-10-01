import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  type Box,
  PROMPT_TRIGGER_DEFAULT_INSET,
  PROMPT_TRIGGER_ELEMENT_ID,
  PROMPT_TRIGGER_SIZE,
} from '../../prompt/triggerClearance';
import { mountFloatingFab, unmountFloatingFab } from '../floatingModeFab';
import { destroyMountedPanels, mountPanel, setWindowSize } from './floatingPanelHarness';

vi.mock('@/utils/i18n', () => ({
  getTranslationSyncUnsafe: (key: string) => key,
}));

vi.mock('@/core/utils/browser', () => ({
  isSafari: () => false,
}));

const originalWidth = window.innerWidth;
const originalHeight = window.innerHeight;

/** The ball where `.gv-pm-trigger` puts it: 46px, 18px in from the bottom-right corner. */
function cornerBall(): Box {
  return {
    x: window.innerWidth - 18 - 46,
    y: window.innerHeight - 18 - 46,
    w: 46,
    h: 46,
  };
}

function rtlBall(): Box {
  return { x: 18, y: window.innerHeight - 18 - 46, w: 46, h: 46 };
}

/** A ball on screen, as Prompt Manager mounts it, at `box`. */
function placeBall(box: Box): void {
  const ball = document.createElement('button');
  ball.id = PROMPT_TRIGGER_ELEMENT_ID;
  ball.getBoundingClientRect = () => new DOMRect(box.x, box.y, box.w, box.h);
  document.body.appendChild(ball);
}

function overlaps(a: Box, b: Box): boolean {
  return a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
}

function insideViewport(box: Box): boolean {
  return (
    box.x >= 0 &&
    box.y >= 0 &&
    box.x + box.w <= window.innerWidth &&
    box.y + box.h <= window.innerHeight
  );
}

function mountFab(storedPos: { x: number; y: number } | null = null): HTMLElement {
  const fab = mountFloatingFab({ onClick: vi.fn(), storedPos });
  expect(fab).not.toBeNull();
  return fab!;
}

/** The drawn button: `.gv-floating-fab` is 44px square. */
function fabBox(fab: HTMLElement): Box {
  return { x: parseFloat(fab.style.left), y: parseFloat(fab.style.top), w: 44, h: 44 };
}

function panelBox(panel: HTMLElement): Box {
  return {
    x: parseFloat(panel.style.left),
    y: parseFloat(panel.style.top),
    w: parseFloat(panel.style.width),
    h: parseFloat(panel.style.height),
  };
}

afterEach(() => {
  unmountFloatingFab();
  destroyMountedPanels();
  document.body.innerHTML = '';
  document.body.className = '';
  setWindowSize(originalWidth, originalHeight);
  vi.restoreAllMocks();
});

describe('floating folder surfaces stay off the Prompt Manager ball', () => {
  it.each([
    [967, 800],
    [1440, 900],
    [500, 400],
  ])('puts the folder button beside the ball in a %ix%i window', (width, height) => {
    setWindowSize(width, height);

    const fab = fabBox(mountFab());

    expect(overlaps(fab, cornerBall())).toBe(false);
    expect(insideViewport(fab)).toBe(true);
    // Still in the corner's row rather than somewhere up the page.
    expect(fab.y + fab.h).toBeGreaterThan(cornerBall().y);
  });

  it('avoids the ball where it actually is once Prompt Manager has mounted it', () => {
    setWindowSize(1200, 800);
    // The user dragged the ball onto the folder button's corner.
    const ball = { x: 1200 - 76, y: 800 - 76, w: 46, h: 46 };
    placeBall(ball);

    const fab = fabBox(mountFab());

    expect(overlaps(fab, ball)).toBe(false);
  });

  it('keeps a folder button position the user saved, even on the ball', () => {
    setWindowSize(967, 800);
    const saved = { x: cornerBall().x, y: cornerBall().y };

    const fab = mountFab(saved);
    Object.defineProperty(fab, 'offsetLeft', { get: () => parseFloat(fab.style.left) });
    Object.defineProperty(fab, 'offsetTop', { get: () => parseFloat(fab.style.top) });
    expect([fab.style.left, fab.style.top]).toEqual([`${saved.x}px`, `${saved.y}px`]);

    setWindowSize(1440, 900);
    window.dispatchEvent(new Event('resize'));
    expect([fab.style.left, fab.style.top]).toEqual([`${saved.x}px`, `${saved.y}px`]);
  });

  it('moves a default folder button with the corner when the window shrinks', () => {
    setWindowSize(1440, 900);
    const fab = mountFab();
    // jsdom has no layout: report the offsets the inline position gives.
    Object.defineProperty(fab, 'offsetLeft', { get: () => parseFloat(fab.style.left) });
    Object.defineProperty(fab, 'offsetTop', { get: () => parseFloat(fab.style.top) });

    setWindowSize(967, 700);
    window.dispatchEvent(new Event('resize'));

    expect(overlaps(fabBox(fab), cornerBall())).toBe(false);
    expect(insideViewport(fabBox(fab))).toBe(true);
  });

  it('keeps the folder button in its corner when RTL mirrors the ball to the left', () => {
    setWindowSize(967, 800);
    document.body.classList.add('gv-rtl');

    const fab = fabBox(mountFab());

    expect(overlaps(fab, rtlBall())).toBe(false);
    expect(fab.x).toBe(967 - 52 - 24);
  });

  it('moves a folder button away from a ball dragged under it in RTL', () => {
    setWindowSize(967, 800);
    document.body.classList.add('gv-rtl');
    const ball = { x: 967 - 70, y: 800 - 70, w: 46, h: 46 };
    placeBall(ball);

    const fab = fabBox(mountFab());

    expect(overlaps(fab, ball)).toBe(false);
    expect(insideViewport(fab)).toBe(true);
  });

  it.each([
    [967, 800],
    [1440, 900],
    [400, 800],
  ])('opens the folder panel clear of the ball in a %ix%i window', (width, height) => {
    setWindowSize(width, height);

    const panel = panelBox(mountPanel().element);

    expect(overlaps(panel, cornerBall())).toBe(false);
    expect(insideViewport(panel)).toBe(true);
  });

  it('keeps a folder panel position the user saved', () => {
    setWindowSize(967, 800);

    const panel = mountPanel({ storedPos: { x: 600, y: 360 } }).element;

    expect([panel.style.left, panel.style.top]).toEqual(['600px', '360px']);
  });

  it('describes the ball slot that the stylesheet draws', () => {
    const css = readFileSync(resolve(process.cwd(), 'public/contentStyle.css'), 'utf8');
    const trigger = css.match(/\n\.gv-pm-trigger \{([^}]*)\}/)?.[1] ?? '';
    const rtl = css.match(/body\.gv-rtl \.gv-pm-trigger \{([^}]*)\}/)?.[1] ?? '';
    const inset = `${PROMPT_TRIGGER_DEFAULT_INSET}px`;
    const size = `${PROMPT_TRIGGER_SIZE}px`;

    expect(trigger).toContain(`right: ${inset};`);
    expect(trigger).toContain(`bottom: ${inset};`);
    expect(trigger).toContain(`width: ${size};`);
    expect(trigger).toContain(`height: ${size};`);
    expect(rtl).toContain(`left: ${inset};`);
  });
});
