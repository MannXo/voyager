import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

// The vitest config swallows `?raw` CSS outside the plugin catalog, so read the file.
const panelCss = readFileSync(resolve(__dirname, '../floatingPanel.css'), 'utf8');

// jsdom has no cascade across shadow boundaries, so this guards the stylesheet
// contract directly: a page rule that matches the host (`* {}`, `div {}`, a CSS
// reset) beats any normal `:host` declaration, whatever its specificity. Only
// `!important` host declarations win, and Chrome confirmed the page rules won
// before they were marked.
const HOST_ONLY = /^:host(\(\[[^\]]+\]\))?$/;

function hostOnlyDeclarations(css: string): string[] {
  const declarations: string[] = [];
  const withoutComments = css.replace(/\/\*[\s\S]*?\*\//g, '');
  for (const match of withoutComments.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    const selectors = match[1].split(',').map((part) => part.trim());
    if (!selectors.every((selector) => HOST_ONLY.test(selector))) continue;
    for (const declaration of match[2].split(';')) {
      const text = declaration.trim();
      if (text && !text.startsWith('--')) declarations.push(text.replace(/\s+/g, ' '));
    }
  }
  return declarations;
}

describe('floating panel host stylesheet', () => {
  it('marks every host declaration important so page rules cannot restyle the panel', () => {
    const declarations = hostOnlyDeclarations(panelCss);

    expect(declarations.length).toBeGreaterThan(0);
    expect(declarations.filter((text) => !text.endsWith('!important'))).toEqual([]);
  });
});
