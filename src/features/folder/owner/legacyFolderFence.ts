import browser from 'webextension-polyfill';

import { getTranslationSync } from '@/utils/i18n';

import { AUTHORITY_FENCE_KEY } from './authorityFence';
import { siteOfFolderKey } from './folderOwnerPolicy';

type FenceState = 'legacy' | 'unreadable' | 'reload_required';
const AUTHORITY_READ_TIMEOUT_MS = 1000;
const RETRY_DELAYS = [1000, 2000, 4000, 8000, 16000, 30000] as const;

export class LegacyFolderWriteRefusedError extends Error {
  constructor() {
    super('Legacy folder storage is fenced');
    this.name = 'LegacyFolderWriteRefusedError';
  }
}

/** Owns write authority, bounded availability checks and the terminal reload notice. */
export class LegacyFolderFence {
  private readonly site;
  private state: FenceState = 'legacy';
  private notice: HTMLElement | null = null;
  private destroyed = false;
  private closing = false;
  private generation = 0;
  private readSequence = 0;
  private settledRead = 0;
  private retry: ReturnType<typeof setTimeout> | null = null;
  private retryAttempt = 0;

  constructor(
    key: string,
    private readonly onChange: () => void,
    private readonly retryUnavailable = true,
  ) {
    this.site = siteOfFolderKey(key);
  }

  get canWrite(): boolean {
    return !this.destroyed && this.state === 'legacy';
  }

  get reloadRequired(): boolean {
    return this.state === 'reload_required';
  }

  async check(): Promise<boolean> {
    if (this.destroyed || this.reloadRequired) return false;
    const generation = this.generation;
    const sequence = ++this.readSequence;
    let deadline: ReturnType<typeof setTimeout> | undefined;
    try {
      // A hung extension call must not leave editing enabled or block a save forever.
      const stored = await Promise.race([
        browser.storage.local.get(AUTHORITY_FENCE_KEY),
        new Promise<never>((_, reject) => {
          deadline = setTimeout(
            () => reject(new Error('Folder authority read timed out')),
            AUTHORITY_READ_TIMEOUT_MS,
          );
        }),
      ]);
      if (generation !== this.generation || this.destroyed) return false;
      if (sequence < this.settledRead) return this.canWrite;
      this.settledRead = sequence;
      const sites = (
        stored?.[AUTHORITY_FENCE_KEY] as { sites?: Record<string, unknown> } | undefined
      )?.sites;
      this.setState(this.site && sites?.[this.site] === 'owner' ? 'reload_required' : 'legacy');
    } catch {
      if (generation === this.generation && sequence >= this.settledRead && !this.destroyed) {
        this.settledRead = sequence;
        this.setState('unreadable');
      }
    } finally {
      clearTimeout(deadline);
    }
    return generation === this.generation && this.canWrite;
  }

  /** Check immediately before issuing a physical mutation; there is no await between them. */
  async write<T>(operation: () => T | Promise<T>): Promise<T> {
    if (!(await this.check()) || !this.canWrite) throw new LegacyFolderWriteRefusedError();
    return operation();
  }

  observe(value: unknown): void {
    this.generation += 1;
    const sites = (value as { sites?: Record<string, unknown> } | null)?.sites;
    this.setState(this.site && sites?.[this.site] === 'owner' ? 'reload_required' : 'legacy');
  }

  private setState(state: FenceState): void {
    // A late legacy read must not reopen an old tab after it saw the owner fence.
    if (this.destroyed || this.reloadRequired) return;
    if (state === 'unreadable' && this.retryUnavailable && !this.closing) this.scheduleRetry();
    else {
      if (this.retry !== null) clearTimeout(this.retry);
      this.retry = null;
      this.retryAttempt = 0;
    }
    if (state === this.state) return;
    this.state = state;
    if (this.reloadRequired && !this.closing) {
      this.notice = document.createElement('div');
      this.notice.className = 'gv-notification gv-notification-error show';
      this.notice.setAttribute('role', 'alert');
      this.notice.textContent = getTranslationSync('folder_reload_required');
      document.body.appendChild(this.notice);
    }
    this.onChange();
  }

  private scheduleRetry(): void {
    if (this.retry !== null) return;
    const delay = RETRY_DELAYS[Math.min(this.retryAttempt++, RETRY_DELAYS.length - 1)];
    this.retry = setTimeout(() => {
      this.retry = null;
      void this.check();
    }, delay);
  }

  /** Stop background work while already accepted writes finish their fresh checks. */
  close(): void {
    this.closing = true;
    if (this.retry !== null) clearTimeout(this.retry);
    this.retry = null;
    this.notice?.remove();
  }

  destroy(): void {
    this.close();
    this.destroyed = true;
    this.generation += 1;
    if (this.retry !== null) clearTimeout(this.retry);
    this.retry = null;
    this.notice?.remove();
  }
}
