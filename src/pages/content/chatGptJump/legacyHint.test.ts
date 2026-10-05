// @vitest-environment-options { "url": "https://chatgpt.com/c/example#gv-turn-turn-one" }
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { initI18n } from '@/utils/i18n';

import { startChatGptJump } from './index';
import { startChatGptLegacyJumpHint } from './legacyHint';

vi.mock('webextension-polyfill', () => ({
  default: {
    storage: {
      sync: { get: vi.fn(async () => ({})) },
      local: { get: vi.fn(async () => ({})) },
      onChanged: { addListener: vi.fn() },
    },
    i18n: { getUILanguage: vi.fn(() => 'en') },
  },
}));

let stop: (() => void) | undefined;
function toasts(): NodeListOf<Element> | undefined {
  return document
    .querySelector('[data-gv-layer="toast"]')
    ?.shadowRoot?.querySelectorAll('.gv-toast');
}
async function settle(): Promise<void> {
  await vi.advanceTimersByTimeAsync(200);
  await Promise.resolve();
}

beforeAll(async () => {
  await initI18n();
});
beforeEach(() => {
  vi.useFakeTimers();
  document.body.innerHTML = '';
  history.replaceState(null, '', '/c/example#gv-turn-turn-one');
});
afterEach(() => {
  stop?.();
  stop = undefined;
  vi.useRealTimers();
  document.body.innerHTML = '';
});

describe('legacy ChatGPT star failure hint', () => {
  it('an inaccessible legacy star shows the manual-switch hint once after redirect home', async () => {
    stop = startChatGptLegacyJumpHint();
    document.body.innerHTML =
      '<div role="alert">Unable to load conversation. Make sure you are using the correct account.</div>';
    await settle();
    history.replaceState(null, '', '/');
    document.body.innerHTML = '<main>Home</main>';
    await settle();
    expect(toasts()).toHaveLength(1);
    expect(toasts()?.[0]?.textContent).toContain('Switch');
    document.body.append(document.createElement('div'));
    await settle();
    expect(toasts()).toHaveLength(1);
    stop();
    expect(document.querySelector('[data-gv-layer="toast"]')).toBeNull();
  });

  it('a removed not-found alert still explains the failed star after the home screen replaces it', async () => {
    stop = startChatGptLegacyJumpHint();
    const alert = document.createElement('div');
    alert.setAttribute('role', 'alert');
    alert.textContent = 'Conversation not found';
    document.body.append(alert);
    history.replaceState(null, '', '/');
    alert.remove();
    await settle();
    expect(toasts()).toHaveLength(1);
  });

  it('normal navigation home and unrelated errors never show an account hint', async () => {
    stop = startChatGptLegacyJumpHint();
    document.body.innerHTML = '<div role="alert">Network connection lost</div>';
    history.replaceState(null, '', '/');
    await settle();
    expect(toasts()).toBeUndefined();
  });

  it('a direct conversation without a saved-turn link does not show the hint', async () => {
    history.replaceState(null, '', '/c/example');
    stop = startChatGptLegacyJumpHint();
    document.body.innerHTML = '<div role="alert">Conversation not found</div>';
    history.replaceState(null, '', '/');
    await settle();
    expect(toasts()).toBeUndefined();
  });

  it('an unrelated later home navigation cannot reuse an expired failed jump', async () => {
    stop = startChatGptLegacyJumpHint();
    document.body.innerHTML = '<div role="alert">Conversation not found</div>';
    await settle();
    await vi.advanceTimersByTimeAsync(30000);
    history.replaceState(null, '', '/');
    await settle();
    expect(toasts()).toBeUndefined();
  });

  it('page teardown releases the account listener and redirect observers on ChatGPT', async () => {
    stop = startChatGptJump();
    window.dispatchEvent(new Event('pagehide'));
    await settle();
    expect(chrome.runtime.onMessage.removeListener).toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
    expect(document.querySelector('[data-gv-layer="toast"]')).toBeNull();
  });
});
