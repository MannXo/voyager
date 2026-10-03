import { logger } from '@/core/services/LoggerService';
import { getTranslationSync } from '@/utils/i18n';
import type { TranslationKey } from '@/utils/translations';

import { findNativeDownloadButton } from './downloadButton';
import type { ImageHealthFingerprint } from './imageHealthDetector';
import type { StatusToastManager } from './statusToast';

/** Correlate intents and status tokens so an older download cannot finish newer feedback. */
export function createDownloadFeedback({
  getBridge,
  capturePreview,
  createToastManager,
  isRemovalEnabled,
}: {
  getBridge: () => HTMLElement;
  capturePreview: (button: HTMLButtonElement) => Promise<ImageHealthFingerprint | null>;
  createToastManager: () => StatusToastManager;
  isRemovalEnabled: () => boolean;
}) {
  let statusObserver: MutationObserver | null = null;
  const previewFingerprintsByIntent = new Map<string, Promise<ImageHealthFingerprint | null>>();
  let statusToastManager: StatusToastManager | null = null;
  let downloadTrackingReady = false;
  let downloadCaptureHandler: ((event: Event) => void) | null = null;
  let lastImmediateToastAt = 0;
  let sequenceCounter = 0;

  const LARGE_WARNING_AUTO_DISMISS_MS = 8000;
  const PROCESSING_FALLBACK_AUTO_DISMISS_MS = 35000;
  // Gemini can spend more than 10s walking the download chain on slow networks
  // before the final rd-gg/rd-gg-dl image request appears.
  const DOWNLOAD_INTENT_TTL_MS = 60000;

  type DownloadToastSequence = {
    id: number;
    token: string;
    downloadToastId: string | null;
    warningToastId: string | null;
    processingToastId: string | null;
    processingTimer: ReturnType<typeof setTimeout> | null;
  };

  let activeSequence: DownloadToastSequence | null = null;

  function clearActiveDownloadSequence(): void {
    if (!activeSequence) return;

    previewFingerprintsByIntent.delete(activeSequence.token);

    if (activeSequence.processingTimer) {
      clearTimeout(activeSequence.processingTimer);
    }

    if (statusToastManager) {
      for (const toastId of [
        activeSequence.downloadToastId,
        activeSequence.warningToastId,
        activeSequence.processingToastId,
      ]) {
        if (toastId) statusToastManager.removeToast(toastId);
      }
    }

    activeSequence = null;
  }

  const getStatusToastManager = (): StatusToastManager => {
    if (!statusToastManager) {
      statusToastManager = createToastManager();
    }
    return statusToastManager;
  };

  const t = (key: TranslationKey, fallback: string): string => {
    const value = getTranslationSync(key);
    return value === key ? fallback : value;
  };

  function markDownloadIntent(token: string): void {
    const bridge = getBridge();
    bridge.dataset.downloadIntentExpiresAt = String(Date.now() + DOWNLOAD_INTENT_TTL_MS);
    bridge.dataset.downloadIntentToken = token;
  }

  function beginDownloadSequence(button: HTMLButtonElement): void {
    const now = Date.now();
    if (now - lastImmediateToastAt < 300 && activeSequence) {
      markDownloadIntent(activeSequence.token);
      return;
    }
    lastImmediateToastAt = now;

    if (activeSequence?.processingTimer) {
      clearTimeout(activeSequence.processingTimer);
    }
    if (activeSequence) previewFingerprintsByIntent.delete(activeSequence.token);

    const sequenceId = ++sequenceCounter;
    const token = `gv_download_${now}_${sequenceId}`;
    previewFingerprintsByIntent.set(token, capturePreview(button));
    markDownloadIntent(token);
    const manager = getStatusToastManager();
    manager.setAnchorElement(button);
    let downloadToastId: string | null = null;
    let processingTimer: ReturnType<typeof setTimeout> | null = null;

    if (isRemovalEnabled()) {
      const downloadMessage = t('downloadingOriginal', '正在下载原始图片');
      const processingMessage = t('downloadProcessing', '正在处理水印中');
      downloadToastId = manager.addToast(downloadMessage, 'info', {
        pending: true,
        autoDismissMs: 3000,
      });

      processingTimer = setTimeout(() => {
        if (!activeSequence || activeSequence.id !== sequenceId) return;
        if (activeSequence.downloadToastId) {
          manager.removeToast(activeSequence.downloadToastId);
          activeSequence.downloadToastId = null;
        }
        if (!activeSequence.processingToastId) {
          activeSequence.processingToastId = manager.addToast(processingMessage, 'info', {
            pending: true,
            autoDismissMs: PROCESSING_FALLBACK_AUTO_DISMISS_MS,
          });
        }
      }, 3000);
    }

    activeSequence = {
      id: sequenceId,
      token,
      downloadToastId,
      warningToastId: null,
      processingToastId: null,
      processingTimer,
    };
  }

  function setupDownloadButtonTracking(): void {
    if (downloadTrackingReady) return;
    downloadTrackingReady = true;

    downloadCaptureHandler = (event: Event): void => {
      const button = findNativeDownloadButton(event.target);
      if (!button) return;

      beginDownloadSequence(button);
    };

    document.addEventListener('pointerdown', downloadCaptureHandler, true);
    document.addEventListener('click', downloadCaptureHandler, true);
  }

  const finalizeSequence = (
    manager: StatusToastManager,
    level: 'success' | 'warning' | 'error',
    message: string,
  ): void => {
    const autoDismissMs = level === 'success' ? 2500 : level === 'warning' ? 10000 : 4000;
    if (activeSequence?.processingTimer) {
      clearTimeout(activeSequence.processingTimer);
      activeSequence.processingTimer = null;
    }
    if (activeSequence?.warningToastId) {
      manager.removeToast(activeSequence.warningToastId);
      activeSequence.warningToastId = null;
    }
    if (activeSequence?.downloadToastId) {
      manager.removeToast(activeSequence.downloadToastId);
      activeSequence.downloadToastId = null;
    }

    if (
      activeSequence?.processingToastId &&
      manager.updateToast(activeSequence.processingToastId, message, level, {
        autoDismissMs,
        markFinal: true,
      })
    ) {
      return;
    }

    if (
      !manager.updateLatestPending(message, level, {
        autoDismissMs,
        markFinal: true,
      })
    ) {
      manager.addToast(message, level, {
        autoDismissMs,
      });
    }
  };

  function showDownloading(
    sequence: DownloadToastSequence,
    manager: StatusToastManager,
    message: string,
  ): void {
    if (sequence.warningToastId) {
      manager.removeToast(sequence.warningToastId);
      sequence.warningToastId = null;
    }
    if (!sequence.downloadToastId) {
      sequence.downloadToastId = manager.addToast(message, 'info', {
        pending: true,
        autoDismissMs: 3000,
      });
    }
  }

  function showLargeDownload(
    sequence: DownloadToastSequence,
    manager: StatusToastManager,
    message: string,
    warning: string,
  ): void {
    if (!sequence.downloadToastId) {
      sequence.downloadToastId = manager.addToast(message, 'info', {
        pending: true,
        autoDismissMs: 3000,
      });
    } else {
      manager.updateToast(sequence.downloadToastId, message, 'info');
    }
    if (!sequence.warningToastId) {
      sequence.warningToastId = manager.addToast(warning, 'warning', {
        autoDismissMs: LARGE_WARNING_AUTO_DISMISS_MS,
      });
    }
  }

  function showProcessing(
    sequence: DownloadToastSequence,
    manager: StatusToastManager,
    message: string,
  ): void {
    if (sequence.processingToastId) {
      manager.updateToast(sequence.processingToastId, message, 'info');
      return;
    }
    if (!sequence.processingTimer) {
      const processingToastId = manager.addToast(message, 'info', {
        pending: true,
        autoDismissMs: PROCESSING_FALLBACK_AUTO_DISMISS_MS,
      });
      sequence.processingToastId = processingToastId;
    }
  }

  /**
   * Setup listener for status events from fetchInterceptor
   */
  function setupStatusListener(): void {
    if (statusObserver) return;
    const bridge = getBridge();
    const manager = getStatusToastManager();
    const downloadMessage = t('downloadingOriginal', '正在下载原始图片');
    const downloadLargeMessage = t('downloadingOriginalLarge', '正在下载原始图片（大文件）');
    const warningMessage = t('downloadLargeWarning', '大文件警告');
    const processingMessage = t('downloadProcessing', '正在处理水印中');
    const successMessage = t('downloadSuccess', '正在下载');
    const errorPrefix = t('downloadError', '失败');
    const corruptedMessage = t(
      'googleImageCorrupted',
      'Google 返回的原图已损坏（并非 Voyager 导致）；下载结果可能模糊或内容缺失',
    );

    const handleStatus = (statusData: string): void => {
      logger.debug('Watermark status received', { statusData });
      if (!statusData) return;

      try {
        const { type, message, intentToken } = JSON.parse(statusData);
        bridge.removeAttribute('data-status');
        if (!activeSequence || intentToken !== activeSequence.token) return;

        switch (type) {
          case 'DOWNLOADING':
            showDownloading(activeSequence, manager, downloadMessage);
            break;
          case 'DOWNLOADING_LARGE':
            showLargeDownload(activeSequence, manager, downloadLargeMessage, warningMessage);
            break;
          case 'PROCESSING':
            showProcessing(activeSequence, manager, processingMessage);
            break;
          case 'SUCCESS':
            // Step 3: Done, auto-dismiss after 2s
            finalizeSequence(manager, 'success', successMessage);
            break;
          case 'ERROR':
            finalizeSequence(manager, 'error', `${errorPrefix}: ${message}`);
            break;
          case 'GOOGLE_IMAGE_CORRUPTED':
            finalizeSequence(manager, 'warning', corruptedMessage);
            break;
        }
      } catch (e) {
        console.error('[Gemini Voyager] Failed to parse status:', e);
      }
    };

    statusObserver = new MutationObserver(() => {
      const statusData = bridge.dataset.status;
      if (!statusData) return;
      handleStatus(statusData);
    });

    statusObserver.observe(bridge, { attributes: true, attributeFilter: ['data-status'] });
    if (bridge.dataset.status) {
      handleStatus(bridge.dataset.status);
    }
  }

  const start = (): void => {
    setupStatusListener();
    setupDownloadButtonTracking();
  };

  const stop = (): void => {
    statusObserver?.disconnect();
    statusObserver = null;
    clearActiveDownloadSequence();
    if (downloadCaptureHandler) {
      document.removeEventListener('pointerdown', downloadCaptureHandler, true);
      document.removeEventListener('click', downloadCaptureHandler, true);
      downloadCaptureHandler = null;
    }
    downloadTrackingReady = false;
  };

  const takePreview = (token: string) => {
    const fingerprint = previewFingerprintsByIntent.get(token);
    previewFingerprintsByIntent.delete(token);
    return fingerprint;
  };

  return { start, stop, takePreview };
}
