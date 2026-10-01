import { describe, expect, it } from 'vitest';

import type { PluginManifest } from '../types';
import { authoringSites } from './pluginAuthoringPrompt';
import { previewPlugin } from './pluginPreview';
import { validateLocalManifest } from './validateLocalManifest';

function gated(raw: Record<string, unknown>): PluginManifest {
  const result = validateLocalManifest(raw);
  if (!result.success) throw new Error(JSON.stringify(result.error));
  return result.data.manifest;
}

const base = {
  id: 'me.tidy',
  name: 'Tidy Claude',
  version: '1.0.0',
  description: 'Narrower messages, no sidebar',
  author: 'me',
  category: 'layout',
  license: 'MIT',
  engine: '>=1.0.0',
  tier: 'declarative',
  matches: ['https://claude.ai/*', 'https://*.frame.claudeusercontent.com/*'],
};

const site = (id: string) => authoringSites().find((candidate) => candidate.id === id) ?? null;

describe('plain-language plugin preview', () => {
  it('lists the site once and every change in order, with nothing to warn about', () => {
    const preview = previewPlugin(
      gated({
        ...base,
        contributes: {
          styles: [{ css: '.gv-plugin-narrow{max-width:720px}' }, { css: '.gv-plugin-x{}' }],
          domOps: [
            {
              op: 'addClass',
              target: { kind: 'semantic', key: 'userTurn' },
              className: 'gv-plugin-narrow',
            },
            {
              op: 'setStyle',
              target: { kind: 'semantic', key: 'composer' },
              styles: { 'max-width': '720px', margin: '0 auto' },
            },
          ],
        },
      }),
      { targetSite: site('claude') },
    );
    expect(preview.name).toBe('Tidy Claude');
    expect(preview.sites).toEqual(['Claude']);
    expect(preview.changes).toEqual([
      { kind: 'css', chars: 48 },
      {
        kind: 'addClass',
        target: { kind: 'semantic', key: 'userTurn' },
        className: 'gv-plugin-narrow',
      },
      {
        kind: 'setStyle',
        target: { kind: 'semantic', key: 'composer' },
        styles: 'max-width: 720px; margin: 0 auto',
      },
    ]);
    expect(preview.warnings).toEqual([]);
  });

  it('warns about hiding, raw selectors, the wrong site and a replaced version', () => {
    const preview = previewPlugin(
      gated({
        ...base,
        contributes: { domOps: [{ op: 'hide', target: 'nav[aria-label]' }] },
      }),
      { targetSite: site('chatgpt'), previousVersion: '0.9.0' },
    );
    expect(preview.changes).toEqual([
      { kind: 'hide', target: { kind: 'css', selector: 'nav[aria-label]' } },
    ]);
    expect(preview.warnings).toEqual([
      { kind: 'replaces', version: '0.9.0' },
      { kind: 'not-on-site', site: 'ChatGPT' },
      { kind: 'hides' },
      { kind: 'raw-selector' },
    ]);
  });

  it('flags a theme or native op the prompt asked the AI to leave out', () => {
    const preview = previewPlugin(
      gated({
        ...base,
        engine: '>=1.4.0',
        theme: { brand: '#112233' },
        requires: { handlers: ['formulaCopy'] },
        contributes: { domOps: [{ op: 'native', handler: 'formulaCopy', params: {} }] },
      }),
    );
    expect(preview.changes).toEqual([
      { kind: 'native', handler: 'formulaCopy' },
      { kind: 'theme', brand: '#112233' },
    ]);
    expect(preview.warnings).toEqual([{ kind: 'theme' }, { kind: 'native' }]);
  });
});
