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
  it('lists the site once, every change in order, and its CSS in full', () => {
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
    // CSS can do anything, so it is shown in full and never summarized away.
    expect(preview.css).toEqual(['.gv-plugin-narrow{max-width:720px}', '.gv-plugin-x{}']);
    expect(preview.warnings).toEqual([{ kind: 'css' }]);
  });

  it('says plainly that CSS is not summarized, even when it hides the page', () => {
    const preview = previewPlugin(
      gated({ ...base, contributes: { styles: [{ css: 'main{display:none!important}' }] } }),
    );
    expect(preview.css).toEqual(['main{display:none!important}']);
    expect(preview.warnings).toEqual([{ kind: 'css' }]);
  });

  it('warns about hiding through setStyle and the hidden or style attribute', () => {
    const hiding = (domOp: Record<string, unknown>) =>
      previewPlugin(gated({ ...base, contributes: { domOps: [domOp] } })).warnings;
    const composer = { kind: 'semantic', key: 'composer' };
    for (const styles of [
      { display: 'none' },
      { DISPLAY: ' None !important' },
      { visibility: 'hidden' },
      { visibility: 'collapse' },
      { opacity: '0' },
      { opacity: '0.0%' },
      { 'content-visibility': 'hidden' },
      { display: 'var(--gv-x)' },
    ]) {
      expect(hiding({ op: 'setStyle', target: composer, styles }), JSON.stringify(styles)).toEqual([
        { kind: 'hides' },
      ]);
    }
    expect(hiding({ op: 'setAttribute', target: composer, name: 'hidden', value: '' })).toEqual([
      { kind: 'hides' },
    ]);
    expect(
      hiding({
        op: 'setAttribute',
        target: composer,
        name: 'style',
        value: 'color:red; display : none',
      }),
    ).toEqual([{ kind: 'hides' }]);
    for (const styles of [{ display: 'flex' }, { opacity: '0.8' }, { visibility: 'visible' }]) {
      expect(hiding({ op: 'setStyle', target: composer, styles }), JSON.stringify(styles)).toEqual(
        [],
      );
    }
    expect(
      hiding({ op: 'setAttribute', target: composer, name: 'aria-hidden', value: 'true' }),
    ).toEqual([]);
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
    expect(preview.css).toEqual([]);
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
