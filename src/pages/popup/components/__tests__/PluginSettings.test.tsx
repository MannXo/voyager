import { act } from 'react';

import { describe, expect, it } from 'vitest';

import { BUILTIN_PLUGINS } from '@/features/plugins/builtin';
import deepseekTimeline from '@/features/plugins/catalog/sites/deepseek/plugins/timeline/plugin.json';
import { validateManifest } from '@/features/plugins/manifest/validate';

import {
  container,
  mockLanguage,
  renderSettings as render,
  compactTimelinePlugin,
  setPluginSetting,
  PLUGIN_ID,
  widthPlugin,
  pluginState,
} from './pluginManagerHarness';

const deepseek = validateManifest({
  ...deepseekTimeline,
  contributes: { ...deepseekTimeline.contributes, styles: [] },
});
if (!deepseek.success) throw new Error('invalid DeepSeek timeline');
const timelines = [
  ...BUILTIN_PLUGINS.filter((plugin) => plugin.id.endsWith('-timeline')),
  deepseek.data,
];

describe.each(timelines)('$name style setting', (plugin) => {
  it('lets a user choose the ruler timeline style', async () => {
    mockLanguage.current = 'zh';
    await render(plugin);
    const select = container.querySelector('select')!;
    expect(select.closest('label')?.textContent).toContain('时间线样式');
    expect(Array.from(select.options, (option) => option.textContent)).toEqual([
      '节点',
      '紧凑索引',
      '刻度',
    ]);
    expect(select.value).toBe('dots');
    act(() => {
      select.value = 'ruler';
      select.dispatchEvent(new Event('change', { bubbles: true }));
    });
    expect(select.value).toBe('ruler');
    expect(setPluginSetting).toHaveBeenCalledWith(plugin.id, 'timelineStyle', 'ruler');
  });

  it('keeps an existing compact setting until the user chooses a style', async () => {
    pluginState.current = {
      [plugin.id]: { enabled: true, installedAt: 0, settings: { compactView: true } },
    };
    await render(plugin);
    const select = container.querySelector('select')!;
    expect(select.value).toBe('compact');
    expect(setPluginSetting).not.toHaveBeenCalled();
    act(() => {
      select.value = 'dots';
      select.dispatchEvent(new Event('change', { bubbles: true }));
    });
    expect(select.value).toBe('dots');
    expect(setPluginSetting).toHaveBeenCalledWith(plugin.id, 'timelineStyle', 'dots');
  });
});

describe('PluginSettings select setting', () => {
  it('keeps English option labels when a translation is missing', async () => {
    mockLanguage.current = 'zh';
    await render({
      ...widthPlugin,
      i18n: { zh: { settings: { placement: { options: { right: '右侧' } } } } },
      contributes: {
        settings: {
          placement: {
            type: 'select',
            label: 'Placement',
            default: 'right',
            options: [
              { value: 'constructor', label: 'Left' },
              { value: 'right', label: 'Right' },
            ],
          },
        },
      },
    });
    const select = container.querySelector('select')!;
    expect(Array.from(select.options, (option) => option.textContent)).toEqual(['Left', '右侧']);
  });

  it('lets a user choose a declared option and persists it immediately', async () => {
    await render({
      ...widthPlugin,
      contributes: {
        settings: {
          placement: {
            type: 'select',
            label: 'Placement',
            default: 'right',
            options: [
              { value: 'left', label: 'Left' },
              { value: 'right', label: 'Right' },
            ],
          },
        },
      },
    });
    const select = container.querySelector('select')!;
    expect(select.closest('label')?.textContent).toContain('Placement');
    expect(Array.from(select.options, (option) => option.textContent)).toEqual(['Left', 'Right']);
    expect(select.value).toBe('right');

    act(() => {
      select.value = 'left';
      select.dispatchEvent(new Event('change', { bubbles: true }));
    });

    expect(select.value).toBe('left');
    expect(setPluginSetting).toHaveBeenCalledOnce();
    expect(setPluginSetting).toHaveBeenCalledWith(PLUGIN_ID, 'placement', 'left');
  });
});

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
