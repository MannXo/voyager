import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createEChartsFullscreen } from '../echarts/fullscreen';
import { openFullscreen } from '../mermaid/fullscreen';
import { createWaveDromFullscreen } from '../wavedrom/fullscreen';

describe('chart fullscreen behavior', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    document.body.innerHTML = '';
    vi.spyOn(Element.prototype, 'scrollWidth', 'get').mockReturnValue(2000);
    vi.spyOn(Element.prototype, 'scrollHeight', 'get').mockReturnValue(1000);
  });
  afterEach(() => {
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    vi.runAllTimers();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('keeps Mermaid local zoom controls active during the fade without document panning', () => {
    openFullscreen('<svg/>');
    const modal = document.querySelector<HTMLElement>('.gv-mermaid-modal')!;
    const content = modal.querySelector<HTMLElement>('.gv-mermaid-modal-content')!;
    vi.advanceTimersToNextFrame();
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    const fit = Math.min((window.innerWidth - 160) / 2000, (window.innerHeight - 160) / 1000);
    const wheel = new WheelEvent('wheel', { deltaY: -1, cancelable: true });
    modal.dispatchEvent(wheel);
    expect(wheel.defaultPrevented).toBe(true);
    expect(content.style.transform).toBe(`translate(0px, 0px) scale(${fit * 1.1})`);
    content.dispatchEvent(new MouseEvent('mousedown', { clientX: 0, clientY: 0 }));
    document.dispatchEvent(new MouseEvent('mousemove', { clientX: 40, clientY: 50 }));
    expect(content.style.transform).toBe(`translate(0px, 0px) scale(${fit * 1.1})`);
    vi.advanceTimersByTime(299);
    expect(modal.isConnected).toBe(true);
    vi.advanceTimersByTime(1);
    expect(modal.isConnected).toBe(false);
  });

  it('zooms and pans WaveDrom relative to its fitted SVG and resets to 1×', () => {
    const fullscreen = createWaveDromFullscreen();
    fullscreen.open('<svg viewBox="0 0 800 200"/>', '#1a1a1a');
    const modal = document.querySelector<HTMLElement>('.gv-wavedrom-modal')!;
    const content = modal.querySelector<HTMLElement>('.gv-wavedrom-modal-content')!;
    const buttons = modal.querySelectorAll('button');
    expect(content.style.transform).toBe('translate(0px, 0px) scale(1)');
    buttons[0].click();
    expect(content.style.transform).toBe('translate(0px, 0px) scale(1.2)');
    buttons[1].click();
    expect(content.style.transform).toBe('translate(0px, 0px) scale(1)');
    modal.dispatchEvent(new WheelEvent('wheel', { deltaY: -1 }));
    content.dispatchEvent(new MouseEvent('mousedown', { clientX: 10, clientY: 20, button: 2 }));
    document.dispatchEvent(new MouseEvent('mousemove', { clientX: 50, clientY: 70 }));
    expect(content.style.transform).toBe('translate(40px, 50px) scale(1.1)');
    document.dispatchEvent(new MouseEvent('mouseup'));
    document.dispatchEvent(new MouseEvent('mousemove', { clientX: 90, clientY: 90 }));
    expect(content.style.transform).toBe('translate(40px, 50px) scale(1.1)');
    expect(content.classList.contains('dragging')).toBe(false);
    buttons[2].click();
    expect(content.style.transform).toBe('translate(0px, 0px) scale(1)');
    for (let i = 0; i < 100; i++) modal.dispatchEvent(new WheelEvent('wheel', { deltaY: -1 }));
    expect(content.style.transform).toBe('translate(0px, 0px) scale(10)');
    for (let i = 0; i < 100; i++) modal.dispatchEvent(new WheelEvent('wheel', { deltaY: 0 }));
    expect(content.style.transform).toBe('translate(0px, 0px) scale(0.1)');
    fullscreen.close();
  });

  it('stops every WaveDrom gesture immediately on close and waits 300ms before reopening', () => {
    const fullscreen = createWaveDromFullscreen();
    fullscreen.open('<svg viewBox="0 0 800 200"/>', '#f9fafb');
    const modal = document.querySelector<HTMLElement>('.gv-wavedrom-modal')!;
    const content = modal.querySelector<HTMLElement>('.gv-wavedrom-modal-content')!;
    content.dispatchEvent(new MouseEvent('mousedown', { clientX: 0, clientY: 0 }));
    modal.querySelectorAll('button')[3].click();
    modal.querySelectorAll('button')[0].click();
    const wheel = new WheelEvent('wheel', { deltaY: -1, cancelable: true });
    modal.dispatchEvent(wheel);
    document.dispatchEvent(new MouseEvent('mousemove', { clientX: 40, clientY: 50 }));
    expect(wheel.defaultPrevented).toBe(false);
    expect(content.style.transform).toBe('translate(0px, 0px) scale(1)');
    expect(content.classList.contains('dragging')).toBe(false);
    fullscreen.open('<svg/>', '#f9fafb');
    expect(document.querySelectorAll('.gv-wavedrom-modal')).toHaveLength(1);
    vi.advanceTimersByTime(300);
    fullscreen.open('<svg/>', '#f9fafb');
    expect(document.querySelector('.gv-wavedrom-modal')).not.toBe(modal);
    fullscreen.close();
  });

  it('keeps ECharts focus trapped during the fade and restores its live canvas and focus', () => {
    const trigger = document.createElement('button');
    const wrapper = document.createElement('div');
    wrapper.className = 'gv-echarts-wrapper';
    const chart = document.createElement('div');
    chart.className = 'gv-echarts-diagram';
    const canvas = document.createElement('canvas');
    chart.appendChild(canvas);
    wrapper.appendChild(chart);
    document.body.append(trigger, wrapper);
    trigger.focus();
    const fullscreen = createEChartsFullscreen((container) => {
      canvas.width = container.parentElement?.classList.contains('gv-echarts-modal-card')
        ? 800
        : 200;
    });
    fullscreen.open(chart);
    vi.advanceTimersToNextFrame();
    const modal = document.querySelector<HTMLElement>('.gv-echarts-modal')!;
    const closeButton = modal.querySelector('button')!;
    expect(canvas.width).toBe(800);
    expect(fullscreen.findContainer(wrapper)).toBe(chart);
    expect(fullscreen.ownerOf(chart)).toBe(wrapper);
    const wheel = new WheelEvent('wheel', { deltaY: -1, cancelable: true });
    modal.dispatchEvent(wheel);
    expect(wheel.defaultPrevented).toBe(false);
    expect(chart.style.transform).toBe('');
    modal.click();
    trigger.focus();
    expect(document.activeElement).toBe(closeButton);
    const tab = new KeyboardEvent('keydown', { key: 'Tab', shiftKey: true, cancelable: true });
    document.dispatchEvent(tab);
    expect(tab.defaultPrevented).toBe(true);
    vi.advanceTimersByTime(299);
    expect(chart.parentElement?.className).toBe('gv-echarts-modal-card');
    vi.advanceTimersByTime(1);
    expect(chart.parentElement).toBe(wrapper);
    expect(chart.firstChild).toBe(canvas);
    expect(canvas.width).toBe(200);
    expect(document.activeElement).toBe(trigger);
    const tabAfterClose = new KeyboardEvent('keydown', { key: 'Tab', cancelable: true });
    document.dispatchEvent(tabAfterClose);
    expect(tabAfterClose.defaultPrevented).toBe(false);
  });

  it('restores ECharts when closed before reveal without resizing a later modal from old work', () => {
    const firstWrapper = document.createElement('div');
    const first = document.createElement('div');
    firstWrapper.appendChild(first);
    document.body.appendChild(firstWrapper);
    const fullscreen = createEChartsFullscreen((container) => {
      container.textContent = container.parentElement === firstWrapper ? 'inline' : 'fullscreen';
    });
    fullscreen.open(first);
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    fullscreen.close();
    fullscreen.close();
    const second = document.createElement('div');
    fullscreen.open(second);
    vi.advanceTimersByTime(400);
    expect(first.parentElement).toBe(firstWrapper);
    expect(first.textContent).toBe('inline');
    expect(second.parentElement?.className).toBe('gv-echarts-modal-card');
    expect(second.textContent).toBe('fullscreen');
    fullscreen.close();
  });
});
