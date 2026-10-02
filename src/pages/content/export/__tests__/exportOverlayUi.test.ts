import { afterEach, describe, expect, it, vi } from 'vitest';

import type { ExportTranslate } from '../exportLocale';
import {
  type ConversationAnchors,
  alignToConversationCenter,
  removeExportProgressOverlays,
  showExportProgressOverlay,
} from '../exportOverlayUi';

const noAnchors: ConversationAnchors = {
  topUserElement: () => null,
  conversationRoot: () => document.body,
};

const t: ExportTranslate = (key) => `[${key}]`;

function placeAt(el: HTMLElement, left: number, width: number, top = 0, height = 600): void {
  el.getBoundingClientRect = () =>
    ({
      left,
      width,
      top,
      height,
      right: left + width,
      bottom: top + height,
      x: left,
      y: top,
      toJSON: () => ({}),
    }) as DOMRect;
}

function mount(html: string): void {
  document.body.innerHTML = html;
}

describe('alignToConversationCenter', () => {
  afterEach(() => {
    document.body.innerHTML = '';
    vi.useRealTimers();
  });

  it('centres on the visible chat canvas rather than the window', () => {
    mount('<div id="chat-history"></div><div class="bar"></div>');
    placeAt(document.querySelector<HTMLElement>('#chat-history')!, 300, 600);
    const bar = document.querySelector<HTMLElement>('.bar')!;

    const stop = alignToConversationCenter(bar, noAnchors);

    expect(bar.style.left).toBe('600px');
    expect(bar.style.transform).toBe('translateX(-50%)');
    stop();
  });

  it('ignores a chat-history candidate that lives in the sidebar', () => {
    mount(`
      <nav><div class="chat-history-scroll-container"></div></nav>
      <div id="chat-history"></div>
      <div class="bar"></div>
    `);
    placeAt(document.querySelector<HTMLElement>('nav .chat-history-scroll-container')!, 0, 900);
    placeAt(document.querySelector<HTMLElement>('#chat-history')!, 400, 500);
    const bar = document.querySelector<HTMLElement>('.bar')!;

    const stop = alignToConversationCenter(bar, noAnchors);

    expect(bar.style.left).toBe('650px');
    stop();
  });

  it('falls back to the top user turn when no canvas or composer is visible', () => {
    mount('<div class="turn"></div><div class="bar"></div>');
    const turn = document.querySelector<HTMLElement>('.turn')!;
    placeAt(turn, 500, 400, 0, 40);
    const bar = document.querySelector<HTMLElement>('.bar')!;

    const stop = alignToConversationCenter(bar, {
      topUserElement: () => turn,
      conversationRoot: () => document.body,
    });

    expect(bar.style.left).toBe('700px');
    stop();
  });

  it('stops following resizes after cleanup', () => {
    mount('<div id="chat-history"></div><div class="bar"></div>');
    const canvas = document.querySelector<HTMLElement>('#chat-history')!;
    placeAt(canvas, 300, 600);
    const bar = document.querySelector<HTMLElement>('.bar')!;
    const stop = alignToConversationCenter(bar, noAnchors);

    placeAt(canvas, 100, 600);
    window.dispatchEvent(new Event('resize'));
    expect(bar.style.left).toBe('400px');

    stop();
    placeAt(canvas, 300, 600);
    window.dispatchEvent(new Event('resize'));
    expect(bar.style.left).toBe('400px');
  });
});

describe('showExportProgressOverlay', () => {
  afterEach(() => {
    document.body.innerHTML = '';
  });

  it('shows one pill at a time and removes it when hidden', () => {
    const hideFirst = showExportProgressOverlay(noAnchors, t);
    const hideSecond = showExportProgressOverlay(noAnchors, t, {
      title: 'Collecting',
      desc: 'Scrolling',
    });

    const overlays = document.querySelectorAll('.gv-export-progress-overlay');
    expect(overlays).toHaveLength(1);
    expect(overlays[0].querySelector('.gv-export-progress-title')?.textContent).toBe('Collecting');
    expect(overlays[0].querySelector('.gv-export-progress-desc')?.textContent).toBe('Scrolling');

    hideFirst();
    hideSecond();
    expect(document.querySelector('.gv-export-progress-overlay')).toBeNull();
  });

  it('uses the export and loading texts by default', () => {
    showExportProgressOverlay(noAnchors, t);

    expect(document.querySelector('.gv-export-progress-title')?.textContent).toBe('[pm_export]...');
    expect(document.querySelector('.gv-export-progress-desc')?.textContent).toBe('[loading]');

    removeExportProgressOverlays();
    expect(document.querySelector('.gv-export-progress-overlay')).toBeNull();
  });
});
