import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { toastDriver } from '@/tests/toastDriver';

import { ExportFormat } from '../../types/export';
import { reportFinishedExport, showExportFailure, showExportNotice } from '../exportToasts';

const SAFARI_UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15';
const CHROME_UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36';

function useBrowser(userAgent: string, vendor: string): void {
  vi.spyOn(navigator, 'userAgent', 'get').mockReturnValue(userAgent);
  vi.spyOn(navigator, 'vendor', 'get').mockReturnValue(vendor);
}

const translate = (key: string) =>
  ({
    export_toast_safari_pdf_ready: 'Choose Save as PDF in the print dialog',
    export_toast_images_omitted: '{count} images stayed as links',
  })[key] ?? key;

beforeEach(() => {
  vi.useFakeTimers();
  document.body.innerHTML = '';
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  document.body.innerHTML = '';
});

describe('export outcome toasts', () => {
  it('replaces the previous outcome in place and closes after its duration', () => {
    showExportNotice('Copied');
    showExportNotice('Copied again', { tone: 'success' });

    expect(toastDriver.all()).toMatchObject([{ message: 'Copied again', tone: 'success' }]);
    vi.advanceTimersByTime(2199);
    expect(toastDriver.messages()).toEqual(['Copied again']);
    vi.advanceTimersByTime(1);
    expect(toastDriver.all()).toEqual([]);
  });

  it('announces a failure as an alert and keeps it up long enough to read', () => {
    showExportFailure('Export failed: boom');

    expect(toastDriver.all()).toMatchObject([
      { message: 'Export failed: boom', tone: 'error', role: 'alert' },
    ]);
    vi.advanceTimersByTime(9999);
    expect(toastDriver.messages()).toEqual(['Export failed: boom']);
    vi.advanceTimersByTime(1);
    expect(toastDriver.all()).toEqual([]);
  });
});

describe('reportFinishedExport', () => {
  it('tells the user how many images stayed as links', () => {
    reportFinishedExport({ omittedImageCount: 3 }, ExportFormat.MARKDOWN, translate);

    expect(toastDriver.all()).toMatchObject([
      { message: '3 images stayed as links', tone: 'warning' },
    ]);
  });

  it('guides Safari users through saving the finished PDF', () => {
    useBrowser(SAFARI_UA, 'Apple Computer, Inc.');

    reportFinishedExport({}, ExportFormat.PDF, translate);

    expect(toastDriver.messages()).toEqual(['Choose Save as PDF in the print dialog']);
  });

  it('keeps the Safari PDF guidance up beside the omitted-images notice', () => {
    useBrowser(SAFARI_UA, 'Apple Computer, Inc.');

    reportFinishedExport({ omittedImageCount: 2 }, ExportFormat.PDF, translate);

    expect(toastDriver.messages()).toEqual([
      'Choose Save as PDF in the print dialog',
      '2 images stayed as links',
    ]);
    vi.advanceTimersByTime(5000);
    expect(toastDriver.messages()).toEqual(['2 images stayed as links']);
    vi.advanceTimersByTime(3000);
    expect(toastDriver.all()).toEqual([]);
  });

  it('shows no PDF guidance outside Safari', () => {
    useBrowser(CHROME_UA, 'Google Inc.');

    reportFinishedExport({}, ExportFormat.PDF, translate);

    expect(toastDriver.all()).toEqual([]);
  });
});
