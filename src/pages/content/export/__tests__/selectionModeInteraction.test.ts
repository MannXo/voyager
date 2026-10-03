import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

describe('selection mode interaction', () => {
  it('pins selection bar to top and uses top-center compact progress toast styles', () => {
    const css = readFileSync(resolve(process.cwd(), 'public/contentStyle.css'), 'utf8');
    const overlayBlock = css.match(/\.gv-export-progress-overlay\s*{([\s\S]*?)}/)?.[1] ?? '';
    const cardBlock = css.match(/\.gv-export-progress-card\s*{([\s\S]*?)}/)?.[1] ?? '';

    expect(css).toMatch(/\.gv-export-select-bar\s*{[\s\S]*top:\s*12px;/);
    expect(overlayBlock).toContain('position: fixed;');
    expect(overlayBlock).toContain('left: 50%;');
    expect(overlayBlock).toContain('transform: translateX(-50%);');
    expect(overlayBlock).toContain('top: 12px;');
    expect(overlayBlock).toContain('pointer-events: none;');
    expect(cardBlock).toContain('border-radius: 999px;');
    expect(cardBlock).toContain('backdrop-filter: blur(10px);');
  });

  it('supports dark-theme selectors for export dialog and progress toast', () => {
    const css = readFileSync(resolve(process.cwd(), 'public/contentStyle.css'), 'utf8');

    expect(css).toContain("html[data-gv-scheme='dark'] .gv-export-dialog");
    expect(css).toContain("html[data-gv-scheme='dark'] .gv-export-progress-card");
  });

  it('styles the Markdown prompt heading switch for dark and RTL layouts', () => {
    const css = readFileSync(resolve(process.cwd(), 'public/contentStyle.css'), 'utf8');

    expect(css).toContain("html[data-gv-scheme='dark'] .gv-export-prompt-heading-section");
    expect(css).toContain('body.gv-rtl .gv-export-prompt-heading-switch .gv-coach-knob');
  });

  it('keeps logo wrapper from blocking top-bar button clicks', () => {
    const css = readFileSync(resolve(process.cwd(), 'public/contentStyle.css'), 'utf8');
    const wrapperBlock = css.match(/\.gv-logo-dropdown-wrapper\s*{([\s\S]*?)}/)?.[1] ?? '';
    const logoBlock =
      css
        .match(
          /\.gv-logo-dropdown-wrapper \[data-test-id='logo'\],\s*\.gv-logo-dropdown-wrapper \.logo\s*{([\s\S]*?)}/,
        )
        ?.at(1) ?? '';

    expect(wrapperBlock).toContain('pointer-events: none;');
    expect(wrapperBlock).toContain('width: fit-content;');
    expect(logoBlock).toContain('pointer-events: auto;');
  });

  it('wires Safari PDF success path to runtime toast guidance', () => {
    const notice = readFileSync(
      resolve(process.cwd(), 'src/features/export/ui/exportResultNotice.ts'),
      'utf8',
    );

    expect(notice).toContain("format === 'pdf'");
    expect(notice).toContain('isSafari()');
    expect(notice).toContain('showExportToast(');
    expect(notice).toContain("t('export_toast_safari_pdf_ready')");
  });

  it('applies horizontal scrolling to the export selection bar and prevents text wrapping', () => {
    const css = readFileSync(resolve(process.cwd(), 'public/contentStyle.css'), 'utf8');

    // Check for container scroll behaviors
    const barBlock = css.match(/\.gv-export-select-bar\s*{([\s\S]*?)}/)?.[1] ?? '';
    expect(barBlock).toContain('overflow-x: auto;');
    expect(barBlock).toContain('scrollbar-width: none;');

    // Check for nowrapping and no shrinking on buttons
    const btnBlock =
      css.match(
        /\.gv-export-select-all-toggle,\s*\.gv-export-select-role-btn\s*{([\s\S]*?)}/,
      )?.[1] ?? '';
    expect(btnBlock).toContain('white-space: nowrap;');
    expect(btnBlock).toContain('flex-shrink: 0;');
  });
});
