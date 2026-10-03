import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { expect, it } from 'vitest';

it('keeps Safari rich-text export code free of unsupported RegExp lookbehind after minification', () => {
  const code = execFileSync(
    resolve('node_modules/.bin/esbuild'),
    ['--loader=ts', '--target=safari14', '--minify'],
    {
      input: readFileSync(resolve('src/features/export/services/exportRichText.ts')),
      encoding: 'utf8',
    },
  );
  expect(code).not.toMatch(/\(\?<[=!]/);
});
