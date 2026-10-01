import { getTranslationSync } from '@/utils/i18n';
import type { TranslationKey } from '@/utils/translations';

import type { ChatGptCrawlOptions } from './adapter/chatgptCrawl';
import { hasRenderedThread } from './adapter/chatgptThread';
import { prepareChatGptExport } from './adapter/chatgptThreadExport';

/**
 * Progress for ChatGPT's thread crawl, which reads a long conversation for a
 * while (about 0.7s per turn live): a pill styled like the export progress
 * pill that counts the turns read, with a Cancel button.
 *
 * Cancel aborts only the crawl. The crawl restores the reader's scroll
 * position and rejects with an AbortError, which the export treats as a quiet
 * cancellation: no file, no warning.
 */

const PILL_CLASS = 'gv-export-crawl-progress';
const CANCEL_CLASS = 'gv-export-crawl-cancel';
/** The export's own progress pill, hidden while this one shows. */
const EXPORT_PROGRESS_SELECTOR = '.gv-export-progress-overlay';

type Translate = (key: TranslationKey) => string;

interface CrawlProgressPill {
  update(turns: number): void;
  dispose(): void;
}

function showCrawlProgress(t: Translate, onCancel: () => void): CrawlProgressPill {
  document.querySelectorAll(`.${PILL_CLASS}`).forEach((pill) => pill.remove());
  const covered = Array.from(document.querySelectorAll<HTMLElement>(EXPORT_PROGRESS_SELECTOR));
  covered.forEach((overlay) => (overlay.hidden = true));

  const pill = document.createElement('div');
  pill.className = PILL_CLASS;
  pill.setAttribute('role', 'status');

  const card = document.createElement('div');
  card.className = 'gv-export-progress-card';
  const spinner = document.createElement('div');
  spinner.className = 'gv-export-progress-spinner';
  const title = document.createElement('div');
  title.className = 'gv-export-progress-title';
  title.textContent = t('export_reading_conversation_title');
  const desc = document.createElement('div');
  desc.className = 'gv-export-progress-desc';
  const cancel = document.createElement('button');
  cancel.type = 'button';
  cancel.className = CANCEL_CLASS;
  cancel.textContent = t('pm_cancel');
  cancel.addEventListener('click', onCancel, { once: true });

  card.append(spinner, title, desc, cancel);
  pill.appendChild(card);
  document.body.appendChild(pill);

  const update = (turns: number) => {
    desc.textContent = t('export_reading_conversation_turns').replace('{count}', String(turns));
  };
  update(0);

  return {
    update,
    dispose() {
      pill.remove();
      covered.forEach((overlay) => (overlay.hidden = false));
    },
  };
}

/**
 * {@link prepareChatGptExport} with the progress pill. The earlier DOM has no
 * crawl, so it gets no pill.
 */
export async function prepareChatGptExportWithProgress(
  options: ChatGptCrawlOptions = {},
  t: Translate = getTranslationSync,
): Promise<boolean> {
  if (!hasRenderedThread()) return prepareChatGptExport(options);

  const crawl = new AbortController();
  const forward = () => crawl.abort();
  if (options.signal?.aborted) crawl.abort();
  options.signal?.addEventListener('abort', forward, { once: true });
  const pill = showCrawlProgress(t, () => crawl.abort());
  try {
    return await prepareChatGptExport({
      ...options,
      signal: crawl.signal,
      onProgress: (turns) => {
        pill.update(turns);
        options.onProgress?.(turns);
      },
    });
  } finally {
    pill.dispose();
    options.signal?.removeEventListener('abort', forward);
  }
}
