import { describe, expect, it } from 'vitest';

import { inspectPlugin } from './inspectPlugin';
import { validateLocalManifest } from './validateLocalManifest';

describe('inspectPlugin', () => {
  it('lists sites, CSS size, page changes, primitives and settings', () => {
    const result = validateLocalManifest({
      id: 'me.vim',
      name: 'Vim',
      version: '1.2.0',
      description: 'd',
      author: 'Me',
      category: 'input',
      license: 'MIT',
      engine: '>=1.4.0',
      tier: 'declarative',
      matches: ['https://claude.ai/*'],
      contributes: {
        settings: { wide: { type: 'boolean', label: 'Wide', default: true } },
        styles: [{ css: '.gv-a{color:red}' }, { css: '.gv-b{}' }],
        domOps: [
          { op: 'addClass', target: 'body', className: 'gv-vim' },
          { op: 'native', target: 'body', handler: 'vimInput', params: { composer: '#p' } },
        ],
      },
    });
    expect(result.success).toBe(true);
    if (!result.success) return;

    const inspection = inspectPlugin(result.data.manifest);
    expect(inspection.id).toBe('local.me.vim');
    expect(inspection.sites).toEqual([
      { pattern: 'https://claude.ai/*', site: expect.any(String) },
    ]);
    expect(inspection.styleSheets).toBe(2);
    expect(inspection.cssChars).toBe('.gv-a{color:red}'.length + '.gv-b{}'.length);
    expect(inspection.domOps).toEqual(['addClass gv-vim → body']);
    expect(inspection.primitives).toEqual([{ handler: 'vimInput', params: '{"composer":"#p"}' }]);
    expect(inspection.settings).toEqual([
      { key: 'wide', type: 'boolean', label: 'Wide', defaultValue: 'true' },
    ]);
  });
});
