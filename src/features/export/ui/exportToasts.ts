/**
 * Export's toasts. One page-lifetime toaster serves every export surface (export
 * runs, Deep Research reports, copy as image, Canvas copy) on every site, so
 * they share the bottom-end stack with the rest of Voyager.
 */
import { createToaster } from '@/core/ui/toast/toaster';
import type { ToastTone } from '@/core/ui/toast/types';
import { isSafari } from '@/core/utils/browser';
import type { TranslationKey } from '@/utils/translations';

import type { ExportFormat, ExportResult } from '../types/export';

const exportToaster = createToaster();

/** Outcomes replace one another in place: a newer one makes the older moot. */
const OUTCOME_CHANNEL = 'export';
// Their own channels, so the Safari PDF guidance and the omitted-images notice both stay up.
const SAFARI_PDF_CHANNEL = 'export-safari-pdf';
const OMITTED_IMAGES_CHANNEL = 'export-images-omitted';

const NOTICE_MS = 2200;
const SAFARI_PDF_MS = 5000;
const OMITTED_IMAGES_MS = 8000;
/** A failure used to be an alert the user had to close; it stays long enough to read. */
const FAILURE_MS = 10_000;

export function showExportNotice(
  message: string,
  options: { tone?: ToastTone; durationMs?: number } = {},
): void {
  exportToaster.show({
    channel: OUTCOME_CHANNEL,
    message,
    tone: options.tone,
    durationMs: options.durationMs ?? NOTICE_MS,
  });
}

export function showExportFailure(message: string): void {
  showExportNotice(message, { tone: 'error', durationMs: FAILURE_MS });
}

/** What a finished export still needs to tell the user, if anything. */
export function reportFinishedExport(
  result: Pick<ExportResult, 'omittedImageCount'>,
  format: ExportFormat,
  t: (key: TranslationKey) => string,
): void {
  if (format === 'pdf' && isSafari()) {
    exportToaster.show({
      channel: SAFARI_PDF_CHANNEL,
      message: t('export_toast_safari_pdf_ready'),
      durationMs: SAFARI_PDF_MS,
    });
  }
  const omitted = result.omittedImageCount ?? 0;
  if (omitted <= 0) return;
  exportToaster.show({
    channel: OMITTED_IMAGES_CHANNEL,
    message: t('export_toast_images_omitted').replace('{count}', String(omitted)),
    tone: 'warning',
    durationMs: OMITTED_IMAGES_MS,
  });
}
