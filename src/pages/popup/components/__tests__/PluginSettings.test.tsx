import { act } from 'react';

import { describe, expect, it } from 'vitest';

import {
  container,
  mockLanguage,
  renderSettings as render,
  compactTimelinePlugin,
  setPluginSetting,
  PLUGIN_ID,
} from './pluginManagerHarness';

describe('PluginSettings setting slider', () => {
  it('renders localized range labels from the plugin i18n map', async () => {
    mockLanguage.current = 'zh';
    await render();

    expect(container.textContent).toContain('阅读宽度（px）');
    expect(container.textContent).toContain('768');
    expect(container.textContent).toContain('更窄');
    expect(container.textContent).toContain('更宽');
    expect(container.textContent).not.toContain('Reading width (px)');
  });
});
describe('PluginSettings boolean setting', () => {
  it('renders a localized switch and persists changes immediately', async () => {
    mockLanguage.current = 'zh';
    await render(compactTimelinePlugin);

    const input = container.querySelector('input[aria-label="使用紧凑索引"]') as HTMLInputElement;
    expect(input).toBeTruthy();
    expect(input.checked).toBe(false);

    act(() => input.click());

    expect(input.checked).toBe(true);
    expect(setPluginSetting).toHaveBeenCalledOnce();
    expect(setPluginSetting).toHaveBeenCalledWith(PLUGIN_ID, 'compactView', true);
  });
});
