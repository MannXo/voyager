import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createForegroundCompletionToast } from '../foregroundCompletionToast';

function setScrollMetrics(element: HTMLElement, scrollTop = 0): void {
  Object.defineProperties(element, {
    scrollHeight: { value: 2200, configurable: true },
    clientHeight: { value: 500, configurable: true },
    scrollTop: { value: scrollTop, configurable: true },
  });
}

function setRect(element: HTMLElement, rect: DOMRect): void {
  vi.spyOn(element, 'getBoundingClientRect').mockReturnValue(rect);
}

function toastNode(): HTMLElement | null {
  return document.getElementById('gv-response-complete-toast');
}

beforeEach(() => {
  vi.useFakeTimers();
  document.body.innerHTML = '<article>Completed response</article>';
  setScrollMetrics(document.documentElement);
});

afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.restoreAllMocks();
  document.body.innerHTML = '';
});

describe('foreground completion toast', () => {
  it('only shows for an off-screen response with enough remaining scroll distance', () => {
    const response = document.querySelector('article')!;
    const toast = createForegroundCompletionToast({
      promptSelector: 'textarea',
      getScrollTarget: () => response,
    });

    toast.showIfNeeded(null);
    setRect(response, new DOMRect(0, 100, 500, 100));
    toast.showIfNeeded(response);
    expect(toastNode()).toBeNull();

    setRect(response, new DOMRect(0, window.innerHeight + 100, 500, 100));
    setScrollMetrics(document.documentElement, 1540);
    toast.showIfNeeded(response);
    expect(toastNode()).toBeNull();

    setScrollMetrics(document.documentElement, 1539);
    toast.showIfNeeded(response);
    expect(toastNode()?.style.opacity).toBe('1');
    expect(toastNode()?.style.left).toBe('50%');
    expect(toastNode()?.style.bottom).toBe('148px');
  });

  it('positions above the rounded composer ancestor and reads a nested response scroll root', () => {
    document.body.innerHTML =
      '<section style="overflow-y: auto"><article>Answer</article></section>' +
      '<div style="border-radius: 20px"><textarea></textarea></div>';
    const response = document.querySelector('article')!;
    const scrollRoot = document.querySelector('section')!;
    const prompt = document.querySelector('textarea')!;
    setScrollMetrics(document.documentElement, 1700);
    setScrollMetrics(scrollRoot);
    setRect(response, new DOMRect(0, window.innerHeight + 100, 500, 100));
    setRect(prompt, new DOMRect(120, window.innerHeight - 148, 560, 45));
    setRect(prompt.parentElement!, new DOMRect(100, window.innerHeight - 168, 600, 80));

    createForegroundCompletionToast({
      promptSelector: 'textarea',
      getScrollTarget: () => response,
    }).showIfNeeded(response);

    expect(toastNode()?.style.left).toBe('400px');
    expect(toastNode()?.style.bottom).toBe('190px');
    expect(toastNode()?.getAttribute('role')).toBe('button');
    expect(toastNode()?.getAttribute('aria-live')).toBe('polite');
    expect(toastNode()?.tabIndex).toBe(0);
  });

  it.each(['click', 'Enter', ' '])('scrolls to the current target on %s and hides', (action) => {
    const completed = document.querySelector('article')!;
    setRect(completed, new DOMRect(0, window.innerHeight + 100, 500, 100));
    let target = completed;
    const toast = createForegroundCompletionToast({
      promptSelector: 'textarea',
      getScrollTarget: () => target,
    });
    toast.showIfNeeded(completed);
    target = document.createElement('article');
    const scroll = vi.fn();
    target.scrollIntoView = scroll;

    if (action === 'click') toastNode()?.click();
    else toastNode()?.dispatchEvent(new KeyboardEvent('keydown', { key: action }));

    expect(scroll).toHaveBeenCalledWith({ block: 'end', behavior: 'smooth' });
    expect(toastNode()?.style.opacity).toBe('0');
  });

  it('scrolls the document to the end when the target is no longer available', () => {
    const response = document.querySelector('article')!;
    setRect(response, new DOMRect(0, window.innerHeight + 100, 500, 100));
    const scroll = vi.fn();
    document.documentElement.scrollTo = scroll;
    createForegroundCompletionToast({
      promptSelector: 'textarea',
      getScrollTarget: () => null,
    }).showIfNeeded(response);

    toastNode()?.click();

    expect(scroll).toHaveBeenCalledWith({ top: 2200, behavior: 'smooth' });
    expect(toastNode()?.style.opacity).toBe('0');
  });

  it('extends the hide deadline on another completion and stops without removing the node', () => {
    const response = document.querySelector('article')!;
    setRect(response, new DOMRect(0, window.innerHeight + 100, 500, 100));
    const toast = createForegroundCompletionToast({
      promptSelector: 'textarea',
      getScrollTarget: () => response,
    });
    toast.showIfNeeded(response);
    const node = toastNode();
    vi.advanceTimersByTime(3000);
    toast.showIfNeeded(response);
    vi.advanceTimersByTime(200);
    expect(node?.style.opacity).toBe('1');
    vi.advanceTimersByTime(3000);
    expect(node?.style.opacity).toBe('0');

    toast.showIfNeeded(response);
    toast.stop();
    expect(node?.style.opacity).toBe('0');
    expect(toastNode()).toBe(node);
    expect(vi.getTimerCount()).toBe(0);
    toast.showIfNeeded(response);
    expect(toastNode()).toBe(node);
    expect(node?.style.opacity).toBe('1');
  });
});
