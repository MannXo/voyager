import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { StorageKeys } from '@/core/types/common';

import { hasUnreadChangelog, showChangelogModalDirect } from '../../changelog/index';
import { writePromptPref } from '../promptPrefs';
import { type PromptTrigger, mountPromptTrigger } from '../promptTrigger';

vi.mock('webextension-polyfill', () => ({ default: globalThis.chrome }));
vi.mock('../../changelog/index', () => ({
  hasUnreadChangelog: vi.fn(async () => false),
  showChangelogModalDirect: vi.fn(async () => true),
}));
vi.mock('../promptPrefs', () => ({
  readPromptPref: vi.fn(async (_key: string, fallback: unknown) => fallback),
  writePromptPref: vi.fn(async () => {}),
}));

let trigger: PromptTrigger | undefined;

async function mount(options: { hiddenByUser?: boolean; attention?: boolean } = {}) {
  const onAttentionChange = vi.fn();
  trigger = await mountPromptTrigger({
    mascotLogo: false,
    hiddenByUser: options.hiddenByUser ?? false,
    attention: options.attention ?? false,
    onAttentionChange,
  });
  return { ball: trigger.element, onAttentionChange };
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

beforeEach(() => {
  vi.clearAllMocks();
  document.body.innerHTML = '';
});

afterEach(() => {
  trigger?.destroy();
  trigger = undefined;
});

describe('prompt trigger visibility', () => {
  it('stays visible while it announces release notes, even when the user hid it', async () => {
    const { ball } = await mount({ hiddenByUser: true, attention: true });

    expect(ball.style.display).toBe('');
    expect(ball.classList.contains('gv-pm-trigger-new')).toBe(true);
  });

  it('hides once the hidden ball has shown its release notes', async () => {
    const { ball, onAttentionChange } = await mount({ hiddenByUser: true, attention: true });

    await expect(trigger!.consumeAttention()).resolves.toBe(true);

    expect(showChangelogModalDirect).toHaveBeenCalledTimes(1);
    expect(onAttentionChange).toHaveBeenCalledWith(false);
    expect(trigger!.hasAttention).toBe(false);
    expect(ball.style.display).toBe('none');
  });

  it('reports whether hiding the Prompt Manager actually hid the ball', async () => {
    const { ball } = await mount({ attention: true });

    expect(trigger!.setHiddenByUser(true)).toBe(false);
    expect(ball.style.display).toBe('');

    await trigger!.consumeAttention();
    expect(trigger!.setHiddenByUser(true)).toBe(true);
    expect(ball.style.display).toBe('none');

    expect(trigger!.setHiddenByUser(false)).toBe(false);
    expect(ball.style.display).toBe('');
  });

  it('starts announcing when release notes become unread in badge mode', async () => {
    vi.mocked(chrome.storage.local.get).mockResolvedValue({
      [StorageKeys.CHANGELOG_NOTIFY_MODE]: 'badge',
    } as never);
    vi.mocked(hasUnreadChangelog).mockResolvedValue(true);
    const { ball, onAttentionChange } = await mount({ hiddenByUser: true });
    expect(ball.style.display).toBe('none');

    trigger!.applyStorageChange('local', {
      [StorageKeys.CHANGELOG_DISMISSED_VERSION]: { newValue: undefined },
    });
    await flush();

    expect(onAttentionChange).toHaveBeenCalledWith(true);
    expect(ball.style.display).toBe('');
  });
});

describe('prompt trigger activation', () => {
  it('ignores clicks until enabled', async () => {
    const { ball } = await mount();
    const onActivate = vi.fn();

    ball.click();
    trigger!.enable(onActivate);
    ball.click();

    expect(onActivate).toHaveBeenCalledTimes(1);
  });

  it('opens the announced release notes instead of the panel', async () => {
    const { ball } = await mount({ attention: true });
    const onActivate = vi.fn();
    trigger!.enable(onActivate);

    ball.click();
    await flush();

    expect(showChangelogModalDirect).toHaveBeenCalledTimes(1);
    expect(onActivate).not.toHaveBeenCalled();
    ball.click();
    expect(onActivate).toHaveBeenCalledTimes(1);
  });

  it('treats a press that moved as a drag: saves the position and swallows the click', async () => {
    const { ball } = await mount();
    const onActivate = vi.fn();
    trigger!.enable(onActivate);

    ball.dispatchEvent(
      new MouseEvent('pointerdown', { button: 0, clientX: 100, clientY: 100, bubbles: true }),
    );
    window.dispatchEvent(new MouseEvent('pointermove', { clientX: 60, clientY: 40 }));
    window.dispatchEvent(new MouseEvent('pointerup', { clientX: 60, clientY: 40 }));
    await flush();
    ball.click();

    expect(writePromptPref).toHaveBeenCalledWith(
      StorageKeys.PROMPT_TRIGGER_POSITION,
      expect.objectContaining({ right: expect.any(Number), bottom: expect.any(Number) }),
    );
    expect(onActivate).not.toHaveBeenCalled();
    ball.click();
    expect(onActivate).toHaveBeenCalledTimes(1);
  });
});
