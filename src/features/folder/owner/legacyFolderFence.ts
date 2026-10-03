import browser from 'webextension-polyfill';

import { getTranslationSync } from '@/utils/i18n';

import { AUTHORITY_FENCE_KEY } from './authorityFence';
import { siteOfFolderKey } from './folderOwnerPolicy';

type FenceState = 'legacy' | 'unreadable' | 'reload_required';

/** An old repository stays read-only once a newer build owns its folder key. */
export class LegacyFolderFence {
  private readonly site;
  private state: FenceState = 'legacy';
  private notice: HTMLElement | null = null;
  private destroyed = false;

  constructor(
    key: string,
    private readonly onChange: () => void,
  ) {
    this.site = siteOfFolderKey(key);
  }

  get canWrite(): boolean {
    return this.state === 'legacy';
  }

  get reloadRequired(): boolean {
    return this.state === 'reload_required';
  }

  async check(): Promise<boolean> {
    if (this.reloadRequired) return false;
    try {
      const stored = await browser.storage.local.get(AUTHORITY_FENCE_KEY);
      this.observe(stored?.[AUTHORITY_FENCE_KEY]);
    } catch {
      this.setState('unreadable');
    }
    return this.canWrite;
  }

  observe(value: unknown): void {
    const sites = (value as { sites?: Record<string, unknown> } | null)?.sites;
    this.setState(this.site && sites?.[this.site] === 'owner' ? 'reload_required' : 'legacy');
  }

  private setState(state: FenceState): void {
    // A late legacy read must not reopen an old tab after it saw the owner fence.
    if (this.reloadRequired || state === this.state) return;
    this.state = state;
    if (this.destroyed) return;
    if (this.reloadRequired) {
      this.notice = document.createElement('div');
      this.notice.className = 'gv-notification gv-notification-error show';
      this.notice.setAttribute('role', 'alert');
      this.notice.textContent = getTranslationSync('folder_reload_required');
      document.body.appendChild(this.notice);
    }
    this.onChange();
  }

  destroy(): void {
    this.destroyed = true;
    this.notice?.remove();
  }
}
