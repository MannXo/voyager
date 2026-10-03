import { afterEach, describe, expect, it, vi } from 'vitest';

import { ExportFormat } from '../../types/export';
import { reportFinishedExport } from '../exportResultNotice';

const SAFARI_UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15';
const CHROME_UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36';

function useBrowser(userAgent: string, vendor: string): void {
  vi.spyOn(navigator, 'userAgent', 'get').mockReturnValue(userAgent);
  vi.spyOn(navigator, 'vendor', 'get').mockReturnValue(vendor);
}

const translate = (key: string) =>
  key === 'export_toast_safari_pdf_ready' ? 'Choose Save as PDF in the print dialog' : key;

afterEach(() => {
  vi.restoreAllMocks();
  document.body.innerHTML = '';
});

describe('reportFinishedExport', () => {
  it('tells the user how many images stayed as links', () => {
    reportFinishedExport({ omittedImageCount: 3 }, ExportFormat.MARKDOWN, (key) =>
      key === 'export_toast_images_omitted' ? '{count} images stayed as links' : key,
    );

    expect(document.querySelector('.gv-export-toast')?.textContent).toBe(
      '3 images stayed as links',
    );
  });

  it('guides Safari users through saving the finished PDF', () => {
    useBrowser(SAFARI_UA, 'Apple Computer, Inc.');

    reportFinishedExport({}, ExportFormat.PDF, translate);

    expect(document.querySelector('.gv-export-toast')?.textContent).toBe(
      'Choose Save as PDF in the print dialog',
    );
  });

  it('shows no PDF guidance outside Safari', () => {
    useBrowser(CHROME_UA, 'Google Inc.');

    reportFinishedExport({}, ExportFormat.PDF, translate);

    expect(document.querySelector('.gv-export-toast')).toBeNull();
  });
});
