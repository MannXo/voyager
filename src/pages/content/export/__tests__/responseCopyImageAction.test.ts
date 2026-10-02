import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { ExportDictionaries } from '../exportLocale';

const mocks = vi.hoisted(() => ({
  isSafari: vi.fn(() => false),
  showExportToast: vi.fn(),
  renderResponseImageBlob: vi.fn(),
  copyImageBlobToClipboard: vi.fn(),
  copyImageBlobViaSafariNativePasteboard: vi.fn(),
  downloadImageBlob: vi.fn(),
}));

vi.mock('@/core/utils/browser', () => ({ isSafari: mocks.isSafari }));
vi.mock('../../../../features/export/ui/ExportToast', () => ({
  showExportToast: mocks.showExportToast,
}));
vi.mock('../responseImageCopy', () => ({
  renderResponseImageBlob: mocks.renderResponseImageBlob,
  copyImageBlobToClipboard: mocks.copyImageBlobToClipboard,
  copyImageBlobViaSafariNativePasteboard: mocks.copyImageBlobViaSafariNativePasteboard,
  downloadImageBlob: mocks.downloadImageBlob,
}));

const { resolveExportAdapter } = await import('../adapter/platformAdapters');
const { createConversationCollector } = await import('../conversationCollector');
const { startResponseCopyImageActions } = await import('../responseCopyImageAction');

const emptyDict = {
  en: {},
  zh: {},
  zh_TW: {},
  ja: {},
  fr: {},
  es: {},
  pt: {},
  ar: {},
  ru: {},
  ko: {},
} as ExportDictionaries;

function actionButton(testId: string, iconName: string, ariaLabel: string): HTMLButtonElement {
  const button = document.createElement('button');
  button.className = 'mdc-icon-button mat-mdc-icon-button';
  button.type = 'button';
  button.setAttribute('data-test-id', testId);
  button.setAttribute('aria-label', ariaLabel);
  const icon = document.createElement('mat-icon');
  icon.setAttribute('fonticon', iconName);
  icon.textContent = iconName;
  button.appendChild(icon);
  return button;
}

function renderResponse(): void {
  document.body.innerHTML = `
    <main>
      <div class="user-query-container">prompt</div>
      <model-response>
        <div class="response-container">
          <message-content>answer</message-content>
          <message-actions><div class="actions-container-v2"><div class="buttons-container-v2"></div></div></message-actions>
        </div>
      </model-response>
    </main>
  `;
  const bar = document.querySelector('.buttons-container-v2')!;
  bar.append(
    actionButton('copy-button', 'content_copy', 'Copy response'),
    actionButton('more-menu-button', 'more_vert', 'Show more options'),
  );
}

async function copyFirstResponseAsImage(): Promise<void> {
  const adapter = resolveExportAdapter();
  startResponseCopyImageActions({
    dict: emptyDict,
    language: () => 'en',
    collector: createConversationCollector(adapter),
    adapter,
  });
  const button = document.querySelector<HTMLElement>('[data-test-id="gv-copy-image-button"]');
  expect(button).not.toBeNull();
  button!.click();
  document.querySelector<HTMLElement>('.gv-response-image-menu-item')!.click();
  await vi.waitFor(() => expect(mocks.showExportToast).toHaveBeenCalled());
}

describe('startResponseCopyImageActions', () => {
  const blob = new Blob(['png'], { type: 'image/png' });

  beforeEach(() => {
    renderResponse();
    mocks.renderResponseImageBlob.mockResolvedValue(blob);
  });

  afterEach(() => {
    vi.clearAllMocks();
    mocks.isSafari.mockReturnValue(false);
    document.body.innerHTML = '';
  });

  it('renders only the clicked response and copies it', async () => {
    mocks.copyImageBlobToClipboard.mockResolvedValue(undefined);

    await copyFirstResponseAsImage();

    const [turns] = mocks.renderResponseImageBlob.mock.calls[0];
    expect(turns).toHaveLength(1);
    expect(turns[0].assistant).toBe('answer');
    expect(turns[0].user).toBe('');
    expect(mocks.copyImageBlobToClipboard).toHaveBeenCalledWith(blob);
    expect(mocks.showExportToast).toHaveBeenCalledWith('Response image copied');
  });

  it('downloads the image on Safari when neither clipboard path works', async () => {
    mocks.isSafari.mockReturnValue(true);
    mocks.copyImageBlobToClipboard.mockRejectedValue(new Error('NotAllowedError'));
    mocks.copyImageBlobViaSafariNativePasteboard.mockResolvedValue(false);

    await copyFirstResponseAsImage();

    expect(mocks.downloadImageBlob).toHaveBeenCalledWith(
      blob,
      expect.stringMatching(/^gemini-response-.*\.png$/),
    );
    expect(mocks.showExportToast).toHaveBeenCalledWith(
      'Downloaded response image (Safari clipboard limitation)',
      { autoDismissMs: 3200 },
    );
  });

  it('uses the Safari native pasteboard before falling back to a download', async () => {
    mocks.isSafari.mockReturnValue(true);
    mocks.copyImageBlobToClipboard.mockRejectedValue(new Error('NotAllowedError'));
    mocks.copyImageBlobViaSafariNativePasteboard.mockResolvedValue(true);

    await copyFirstResponseAsImage();

    expect(mocks.downloadImageBlob).not.toHaveBeenCalled();
    expect(mocks.showExportToast).toHaveBeenCalledWith('Response image copied');
  });

  it('reports an unsupported clipboard outside Safari', async () => {
    mocks.copyImageBlobToClipboard.mockRejectedValue(
      new DOMException('Write blocked', 'NotAllowedError'),
    );

    await copyFirstResponseAsImage();

    expect(mocks.downloadImageBlob).not.toHaveBeenCalled();
    expect(mocks.showExportToast).toHaveBeenCalledWith(
      'Clipboard image copy is not supported in this browser',
      { autoDismissMs: 3200 },
    );
  });
});
