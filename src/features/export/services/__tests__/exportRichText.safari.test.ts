import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { expect, it } from 'vitest';

it('keeps Safari rich-text export code free of unsupported RegExp lookbehind', () => {
  const code = readFileSync(resolve('src/features/export/services/exportRichText.ts'), 'utf8');
  expect(code).not.toMatch(/\(\?<[=!]/);
});
