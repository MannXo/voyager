import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { toastDriver } from '@/tests/toastDriver';
import { setCachedLanguage } from '@/utils/i18n';

import { startWatermarkRemover, stopWatermarkRemover } from '../index';

async function settle(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

beforeEach(() => {
  vi.useFakeTimers();
  document.head.replaceChildren();
  document.body.replaceChildren();
  document.getElementById('gv-watermark-bridge')?.remove();
  setCachedLanguage('en');
  vi.mocked(chrome.storage.sync.get).mockImplementation(async () => ({
    gvWatermarkDownloadEnabled: true,
    gvWatermarkPreviewEnabled: false,
  }));
});

afterEach(() => {
  stopWatermarkRemover();
  vi.useRealTimers();
});

async function startDownload(): Promise<HTMLElement> {
  // The real caller starts feedback before the watermark assets finish loading.
  void startWatermarkRemover();
  await settle();
  const image = document.createElement('generated-image');
  const button = document.createElement('button');
  button.dataset.testId = 'download-generated-image-button';
  image.append(button);
  document.body.append(image);
  button.click();
  const bridge = document.getElementById('gv-watermark-bridge');
  expect(bridge?.dataset.downloadIntentToken).toBeTruthy();
  return bridge!;
}

async function status(bridge: HTMLElement, type: string): Promise<void> {
  bridge.dataset.status = JSON.stringify({
    type,
    message: 'temporary failure',
    intentToken: bridge.dataset.downloadIntentToken,
  });
  await settle();
}

describe('watermark download notice dismissal', () => {
  it.each([
    { notice: 'initial download', elapsed: 0, statusType: null, tone: 'info', pending: true },
    { notice: 'processing fallback', elapsed: 3000, statusType: null, tone: 'info', pending: true },
    {
      notice: 'large-file warning',
      elapsed: 0,
      statusType: 'DOWNLOADING_LARGE',
      tone: 'warning',
      pending: false,
    },
    {
      notice: 'final success before processing',
      elapsed: 0,
      statusType: 'SUCCESS',
      tone: 'success',
      pending: false,
    },
    {
      notice: 'final success after processing',
      elapsed: 3000,
      statusType: 'SUCCESS',
      tone: 'success',
      pending: false,
    },
    { notice: 'final error', elapsed: 3000, statusType: 'ERROR', tone: 'error', pending: false },
    {
      notice: 'final corruption warning',
      elapsed: 3000,
      statusType: 'GOOGLE_IMAGE_CORRUPTED',
      tone: 'warning',
      pending: false,
    },
  ])(
    'the $notice remains manually dismissible through the download caller',
    async ({ elapsed, statusType, tone, pending }) => {
      const bridge = await startDownload();
      if (elapsed) vi.advanceTimersByTime(elapsed);
      if (statusType) await status(bridge, statusType);
      const notice = toastDriver
        .all()
        .find((toast) => toast.tone === tone && toast.pending === pending);
      expect(notice).toBeDefined();
      expect(toastDriver.labels(notice!)).toContain('Close');
      const before = toastDriver.all().length;
      toastDriver.press(notice!, 'Close');
      expect(notice!.element.isConnected).toBe(false);
      expect(toastDriver.all()).toHaveLength(before - 1);
      expect(bridge.dataset.downloadIntentToken).toBeTruthy();
    },
  );

  it('uses the localized close button while downloading', async () => {
    setCachedLanguage('zh');
    await startDownload();
    const [notice] = toastDriver.all();
    expect(toastDriver.labels(notice)).toContain('关闭');
    toastDriver.press(notice, '关闭');
    expect(toastDriver.all()).toEqual([]);
  });
});
