import { StorageKeys } from '../../../core/types/common';
import { watchRouteChanges } from '../utils/routeWatcher';
import { DefaultStars } from './defaultStars';
import { ModelPicker } from './modelPicker';
import { DefaultModelPreferences } from './preferences';
import type { DefaultModelSetting, DefaultThinkingLevel } from './preferences';
import './styles.css';

const MODE_ITEM_SELECTOR = '[role="menuitemradio"], [role="menuitem"]';

const CHAT_INPUT_SELECTORS = [
  'main rich-textarea [contenteditable="true"]',
  'rich-textarea [contenteditable="true"]',
  'main div[contenteditable="true"][role="textbox"]',
  'div[contenteditable="true"][role="textbox"]',
  'main .input-area textarea',
  '.input-area textarea',
  'main [contenteditable="true"]',
  'main textarea',
] as const;

const RECENT_COMPOSER_ACTIVITY_MS = 8000;

class DefaultModelManager {
  private readonly preferences = new DefaultModelPreferences();
  private readonly picker = new ModelPicker();
  private readonly stars = new DefaultStars(this.preferences, this.picker);
  private static instance: DefaultModelManager;
  private checkTimer: number | null = null;
  private isLocked = false;
  private started = false;
  private lastCheckedPath: string | null = null;
  private stopRouteWatcher: (() => void) | null = null;
  private sameRouteNewChatClickHandler: ((event: Event) => void) | null = null;
  // Track if we've already auto-selected for this navigation to prevent duplicates
  private autoSelectSessionId: string | null = null;
  // Track consecutive failures to stop retrying when model is unavailable
  private consecutiveFailures = 0;
  private readonly maxConsecutiveFailures = 3;
  // Once we hit `maxConsecutiveFailures`, show a one-time toast suggesting
  // the user pause the feature (until we ship a fix for the broken selector).
  // The flag only resets when the user flips the kill switch off-then-on,
  // so revisiting /app many times in a broken session does not spam toasts.
  private failureToastShown = false;
  // Tracks a model item we clicked on the previous tick. If the trigger pill is
  // still not on that model on the next tick, Gemini likely rejected the switch
  // (for example because that model's quota is exhausted), so we back off after
  // a few confirmations instead of reopening the menu forever (#761).
  private pendingModelSwitchKey: string | null = null;
  private consecutiveRejectedModelSwitches = 0;
  private pendingThinkingSwitchKey: string | null = null;
  private consecutiveRejectedThinkingSwitches = 0;
  private storageChangeListener:
    | ((changes: Record<string, chrome.storage.StorageChange>, area: string) => void)
    | null = null;
  private composerActivityHandler: ((event: Event) => void) | null = null;
  private lastComposerActivityPath: string | null = null;
  private lastComposerActivityAt = 0;

  private constructor() {}

  public static getInstance(): DefaultModelManager {
    if (!DefaultModelManager.instance) {
      DefaultModelManager.instance = new DefaultModelManager();
    }
    return DefaultModelManager.instance;
  }

  public async init() {
    if (this.started) return;
    this.started = true;

    await this.preferences.load();

    this.subscribeToAutoApplyChanges();
    this.subscribeToComposerActivity();

    this.stars.start();
    void this.checkAndLockModel();
    // One shared watcher covers browser history events and page-world SPA
    // navigations without stacking per-feature History API wrappers.
    this.stopRouteWatcher = watchRouteChanges(() => {
      const currentPath = window.location.pathname;
      if (currentPath !== this.lastCheckedPath && this.isNewConversation()) {
        this.lastCheckedPath = currentPath;
        void this.checkAndLockModelWithDelay();
      }
    });

    // A click on the already-active /app new-chat link does not change href, so
    // the shared watcher cannot observe it. Keep only this semantic exception;
    // all real URL changes go through watchRouteChanges.
    this.sameRouteNewChatClickHandler = (event) => {
      const target = event.target instanceof Element ? event.target : null;
      const link = target?.closest<HTMLAnchorElement>('a[href]');
      if (!link) return;
      try {
        const destination = new URL(link.href, window.location.href);
        if (destination.href === window.location.href && this.isNewConversation()) {
          void this.checkAndLockModelWithDelay();
        }
      } catch {
        // Ignore malformed host links.
      }
    };
    document.addEventListener('click', this.sameRouteNewChatClickHandler, true);
  }

  public destroy(): void {
    if (!this.started) return;
    this.started = false;

    this.stars.stop();

    if (this.checkTimer) {
      clearInterval(this.checkTimer);
      this.checkTimer = null;
    }

    this.stopRouteWatcher?.();
    this.stopRouteWatcher = null;

    if (this.sameRouteNewChatClickHandler) {
      document.removeEventListener('click', this.sameRouteNewChatClickHandler, true);
      this.sameRouteNewChatClickHandler = null;
    }

    if (this.storageChangeListener) {
      try {
        chrome.storage.onChanged.removeListener(this.storageChangeListener);
      } catch {
        // ignore — listener may already be gone if context invalidated
      }
      this.storageChangeListener = null;
    }

    this.unsubscribeFromComposerActivity();

    this.lastComposerActivityPath = null;
    this.lastComposerActivityAt = 0;
  }

  private maybeNotifyAutoApplyFailure() {
    if (this.consecutiveFailures < this.maxConsecutiveFailures) return;
    if (this.failureToastShown) return;
    this.failureToastShown = true;
    this.showAutoApplyFailureToast();
  }

  private showAutoApplyFailureToast() {
    // Drop any earlier instance so consecutive triggers (shouldn't happen
    // thanks to `failureToastShown`, but defensive) don't stack.
    document.querySelectorAll('.gv-default-model-fail-toast').forEach((n) => n.remove());

    const toast = document.createElement('div');
    toast.className = 'gv-default-model-fail-toast';
    toast.style.cssText = `
      position: fixed;
      bottom: 24px;
      left: 50%;
      transform: translateX(-50%);
      background: #323232;
      color: white;
      padding: 14px 18px;
      border-radius: 6px;
      font-size: 14px;
      line-height: 1.45;
      z-index: 10000;
      box-shadow: 0 4px 16px rgba(0,0,0,0.3);
      display: flex;
      gap: 14px;
      align-items: center;
      max-width: min(520px, calc(100vw - 48px));
      transition: opacity 0.3s;
    `;

    const text = document.createElement('span');
    text.style.cssText = 'flex: 1; min-width: 0;';
    text.textContent =
      chrome.i18n.getMessage('defaultModelAutoApplyFailed') ||
      'Default model auto-apply failed 3 times in a row. Gemini may have changed its menu layout.';

    const action = document.createElement('button');
    action.type = 'button';
    action.style.cssText = `
      flex: 0 0 auto;
      background: #1a73e8;
      color: white;
      border: none;
      padding: 8px 14px;
      border-radius: 4px;
      font-size: 13px;
      font-weight: 500;
      cursor: pointer;
      white-space: nowrap;
    `;
    action.textContent =
      chrome.i18n.getMessage('defaultModelAutoApplyFailedAction') || 'Pause in settings';

    const dismiss = () => {
      toast.style.opacity = '0';
      setTimeout(() => toast.remove(), 300);
    };

    action.addEventListener('click', () => {
      void this.requestOpenPopup().then((opened) => {
        if (opened) {
          dismiss();
          return;
        }
        // Firefox/Safari (or any host that refuses programmatic popup):
        // swap the text to the manual-fallback instruction and hide the
        // button — there's nothing useful left for it to do.
        text.textContent =
          chrome.i18n.getMessage('defaultModelAutoApplyFailedFallback') ||
          'Open the extension popup from your toolbar to pause this feature.';
        action.remove();
      });
    });

    toast.appendChild(text);
    toast.appendChild(action);
    document.body.appendChild(toast);

    // Stay visible long enough to read + act, but auto-dismiss eventually
    // so it isn't a permanent splash on the page.
    setTimeout(dismiss, 12000);
  }

  private async requestOpenPopup(): Promise<boolean> {
    try {
      const response = (await chrome.runtime.sendMessage({ type: 'gv.openPopup' })) as
        | { ok?: boolean }
        | undefined;
      return response?.ok === true;
    } catch {
      return false;
    }
  }

  // ==================== Auto Lock Logic ====================

  private subscribeToAutoApplyChanges() {
    if (this.storageChangeListener) return;
    this.storageChangeListener = (changes, area) => {
      if (area !== 'sync' && area !== 'local') return;
      const change = changes[StorageKeys.DEFAULT_MODEL_AUTO_APPLY];
      if (!change) return;
      const next = change.newValue !== false; // missing/true → enabled
      if (next === this.preferences.enabled) return;
      this.preferences.enabled = next;
      if (!next) {
        // Flipping off: abort any running lock loop so it doesn't keep
        // clicking after the user disabled the feature.
        if (this.checkTimer) {
          clearInterval(this.checkTimer);
          this.checkTimer = null;
        }
        this.autoSelectSessionId = null;
        // Sweep any star buttons already injected into open menus so the UI
        // matches the off-state immediately (next menu open will skip
        // injection too via the guards in `injectStarButtons`).
        this.stars.sweep();
      } else {
        // Flipping on: clear the once-per-session toast guard so a future
        // breakage during the re-enabled run can surface a fresh warning,
        // and reset the rejected-switch tracker so a prior quota-exhausted
        // session doesn't keep the loop suppressed on the next chat.
        this.failureToastShown = false;
        this.pendingModelSwitchKey = null;
        this.consecutiveRejectedModelSwitches = 0;
        this.pendingThinkingSwitchKey = null;
        this.consecutiveRejectedThinkingSwitches = 0;
        void this.checkAndLockModel();
      }
    };
    try {
      chrome.storage.onChanged.addListener(this.storageChangeListener);
    } catch {
      // chrome.storage may be unavailable in certain test contexts; safe to ignore.
    }
  }

  /**
   * Delayed version of checkAndLockModel for SPA navigation.
   * Adds a small delay to ensure the URL has actually changed.
   */
  private async checkAndLockModelWithDelay() {
    // Wait for SPA navigation to complete
    await new Promise<void>((resolve) => window.setTimeout(resolve, 150));
    void this.checkAndLockModel();
  }

  private async checkAndLockModel() {
    // Master kill switch — see `autoApplyEnabled`.
    if (!this.preferences.enabled) return;
    // Only lock on new conversation pages
    if (!this.isNewConversation()) return;

    // Update last checked path
    this.lastCheckedPath = window.location.pathname;

    await this.preferences.reloadDefaults();
    const targetModel = this.preferences.model;
    const targetThinking = this.preferences.thinking;
    // Keep the raw value for the in-menu star display, but never *enforce*
    // Standard: it is Gemini's built-in default thinking level, so locking to it
    // is always a no-op that can only make the picker flash open on an
    // already-correct chat. Treat a Standard target as "no thinking preference".
    this.preferences.thinking = targetThinking;
    const enforcedThinking = this.preferences.isPageDefaultThinkingLevel(targetThinking)
      ? null
      : targetThinking;

    if (!targetModel && !enforcedThinking) return;

    // Skip when the only target is the Flash/Fast model and there is no thinking
    // preference left to enforce — Gemini already defaults to Flash, so a no-op
    // lock loop just wastes ticks.
    if (targetModel && this.preferences.isFastModel(targetModel) && !enforcedThinking) {
      return;
    }

    // Nothing to do when the picker already shows the starred model + thinking
    // level. A one-line pill ("Pro") already means Pro + Standard — Gemini hides
    // the thinking line at Standard. Bail before starting the 1s lock loop so an
    // already-correct new chat never spins up (or briefly opens) the picker. The
    // `lines.length` guard keeps the startup case — pill not painted yet — on
    // the loop path.
    const pillLines = this.picker.readTriggerPillLines();
    if (pillLines.length) {
      const modelOk = !targetModel || this.preferences.modelMatchesLines(targetModel, pillLines);
      const thinkingOk =
        !enforcedThinking || this.preferences.thinkingMatchesLines(enforcedThinking, pillLines);
      if (modelOk && thinkingOk) return;
    }

    // Generate a unique session ID to prevent duplicate selections in the same navigation
    const sessionId = `${window.location.pathname}-${Date.now()}`;
    this.autoSelectSessionId = sessionId;
    // Reset failure counter for new session
    this.consecutiveFailures = 0;
    this.pendingModelSwitchKey = null;
    this.consecutiveRejectedModelSwitches = 0;
    this.pendingThinkingSwitchKey = null;
    this.consecutiveRejectedThinkingSwitches = 0;

    // Start checking loop
    let attempts = 0;
    const maxAttempts = 5;

    if (this.checkTimer) clearInterval(this.checkTimer);

    this.checkTimer = window.setInterval(async () => {
      // Abort if session changed (e.g., user navigated away and came back)
      if (this.autoSelectSessionId !== sessionId) {
        this.stopLockTimer();
        return;
      }

      attempts++;
      if (attempts > maxAttempts) {
        this.stopLockTimer();
        return;
      }

      await this.tickLock(targetModel, enforcedThinking);
    }, 1000);
  }

  /**
   * Single tick: cheap fast-path via trigger pill text, then targeted lock if needed.
   * Handles both model and thinking-level prefs.
   */
  private async tickLock(
    targetModel: DefaultModelSetting | null,
    targetThinking: DefaultThinkingLevel | null,
  ) {
    if (this.shouldYieldToUserComposerActivity()) {
      this.stopLockTimer();
      return;
    }

    const lines = this.picker.readTriggerPillLines();
    const modelOk = !targetModel || this.preferences.modelMatchesLines(targetModel, lines);
    const thinkingOk =
      !targetThinking || this.preferences.thinkingMatchesLines(targetThinking, lines);

    if (modelOk && thinkingOk) {
      this.stopLockTimer();
      this.consecutiveFailures = 0;
      this.pendingModelSwitchKey = null;
      this.consecutiveRejectedModelSwitches = 0;
      this.pendingThinkingSwitchKey = null;
      this.consecutiveRejectedThinkingSwitches = 0;
      return;
    }

    if (modelOk) {
      this.pendingModelSwitchKey = null;
      this.consecutiveRejectedModelSwitches = 0;
    }

    if (!modelOk && targetModel) {
      const switchKey = this.getModelSwitchKey(targetModel);
      if (this.pendingModelSwitchKey === switchKey) {
        this.consecutiveRejectedModelSwitches++;
        if (this.consecutiveRejectedModelSwitches >= this.maxConsecutiveFailures) {
          this.consecutiveFailures = this.maxConsecutiveFailures;
          this.maybeNotifyAutoApplyFailure();
          this.stopLockTimer();
          return;
        }
      }

      const result = await this.tryLockToModel(targetModel);
      if (result === 'switched') {
        this.pendingModelSwitchKey = switchKey;
      } else if (result === 'already-selected') {
        this.pendingModelSwitchKey = null;
        this.consecutiveRejectedModelSwitches = 0;
        if (!thinkingOk && targetThinking) {
          await this.tryLockToThinkingLevel(targetThinking);
        } else {
          this.stopLockTimer();
        }
      } else {
        this.pendingModelSwitchKey = null;
        this.consecutiveRejectedModelSwitches = 0;
      }
      return;
    }

    if (!thinkingOk && targetThinking) {
      const switchKey = this.getThinkingSwitchKey(targetThinking);
      if (this.pendingThinkingSwitchKey === switchKey) {
        this.consecutiveRejectedThinkingSwitches++;
        if (this.consecutiveRejectedThinkingSwitches >= this.maxConsecutiveFailures) {
          this.consecutiveFailures = this.maxConsecutiveFailures;
          this.maybeNotifyAutoApplyFailure();
          this.stopLockTimer();
          return;
        }
      }

      const clicked = await this.tryLockToThinkingLevel(targetThinking);
      if (clicked) {
        this.pendingThinkingSwitchKey = switchKey;
      } else {
        this.pendingThinkingSwitchKey = null;
        this.consecutiveRejectedThinkingSwitches = 0;
      }
    }
  }

  private isNewConversation() {
    const path = window.location.pathname;
    // Supports multi-profile paths like /u/0/app as well as /app.
    // Also supports Gem paths like /gem/xyz or /u/0/gem/xyz
    return /^\/(u\/\d+\/)?(app\/?|gem\/.*)$/.test(path);
  }

  private getModelSwitchKey(model: DefaultModelSetting): string {
    return model.kind === 'id' ? `id:${model.id}` : `name:${model.name.toLowerCase().trim()}`;
  }

  private getThinkingSwitchKey(thinking: DefaultThinkingLevel): string {
    return `thinking:${thinking.mode ?? 'legacy'}:${thinking.index}:${thinking.label.toLowerCase().trim()}`;
  }

  private stopLockTimer() {
    if (!this.checkTimer) return;
    clearInterval(this.checkTimer);
    this.checkTimer = null;
  }

  private async tryLockToModel(
    targetModel: DefaultModelSetting,
  ): Promise<'switched' | 'already-selected' | 'failed'> {
    // Ported from https://github.com/urzeye/tampermonkey-scripts (Gemini Helper)
    const normalize = (s: string) => s.toLowerCase().trim();
    const escapeRegExp = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const targetName = normalize(targetModel.name);
    const targetAsWholeWord = new RegExp(`(^|\\b)${escapeRegExp(targetName)}(\\b|$)`, 'i');

    // 1. Find selector button (shared helper keeps selectors in sync with the
    //    fast-path check in readTriggerPillLines — #756).
    const selectorBtn = this.picker.findSelectorButton();
    if (!selectorBtn) return 'failed';

    // 2. Early-return if already correct — using the SAME bidirectional match as
    //    the fast-path (`modelMatchesLines`). The trigger pill shows the short
    //    label ("Pro") while the stored default carries the long name ("3.1
    //    Pro"); a forward-only whole-word test misses that, so this method used
    //    to open the picker to "switch" to a model that was already selected —
    //    the momentary flash + leftover focus ring on load. Also bail when the
    //    pill isn't readable yet (page still painting) instead of opening the
    //    menu on a blind guess; the loop retries on the next tick.
    const currentLines = this.picker.readTriggerPillLines();
    if (!currentLines.length) return 'failed';
    if (this.preferences.modelMatchesLines(targetModel, currentLines)) {
      this.stopLockTimer();
      return 'already-selected';
    }

    // 3. Switch model
    // This part is tricky because we need to open the menu and click safely
    if (this.shouldYieldToUserComposerActivity()) {
      this.stopLockTimer();
      return 'failed';
    }
    if (this.isLocked) return 'failed'; // Prevent concurrent locks
    this.isLocked = true;

    try {
      (selectorBtn as HTMLElement).click();

      const menuPanel = await this.picker.waitForModeSwitchMenuPanel(1500);
      if (!menuPanel) {
        // Menu UI may have been restructured (e.g. Gemini redesign). Close any opened
        // menu and count this as a failure so we don't loop forever toggling the trigger.
        document.body.click();
        this.consecutiveFailures++;
        this.maybeNotifyAutoApplyFailure();
        if (this.consecutiveFailures >= this.maxConsecutiveFailures && this.checkTimer) {
          this.stopLockTimer();
        }
        return 'failed';
      }

      const items = Array.from(menuPanel.querySelectorAll<HTMLElement>(MODE_ITEM_SELECTOR)).filter(
        (item) => !this.picker.isInlineExtendedThinkingToggle(item),
      );
      let found = false;
      let switchedModel = false;
      let matchedItem: HTMLElement | null = null;

      const takeItem = (item: HTMLElement) => {
        found = true;
        matchedItem = item;
        if (!this.picker.isModelItemSelected(item)) {
          item.click();
          switchedModel = true;
          return;
        }
        // Already selected, close menu to avoid stuck UI
        document.body.click();
        this.stopLockTimer();
      };

      if (targetModel.kind === 'id') {
        const targetItem = items.find(
          (item) => this.picker.getModelIdFromItem(item) === targetModel.id,
        );

        if (targetItem instanceof HTMLElement) {
          takeItem(targetItem);
        }
      } else {
        for (const item of items) {
          const modelName = this.picker.getModelNameFromItem(item);
          if (normalize(modelName) === targetName) {
            takeItem(item);
            break;
          }
        }
      }

      if (!found) {
        // Fallback: whole-word match on the full text content (includes description).
        for (const item of items) {
          const text = item.textContent || '';
          if (targetAsWholeWord.test(normalize(text))) {
            takeItem(item);
            break;
          }
        }
      }

      if (switchedModel) {
        this.focusChatInputAfterAutoSwitch();
      }

      if (found && !switchedModel && matchedItem) {
        await this.preferences.rememberTriggerPillLabel(targetModel, {
          name: this.picker.getModelNameFromItem(matchedItem),
          id: this.picker.getModelIdFromItem(matchedItem),
          pill: this.picker.readTriggerPillLines()[0],
        });
      }

      if (!found) {
        // Close menu if not found to avoid stuck menu
        document.body.click();

        // Track consecutive failures - if model is consistently not found,
        // stop trying to avoid endless flashing (e.g., model not available for this account)
        this.consecutiveFailures++;
        this.maybeNotifyAutoApplyFailure();
        if (this.consecutiveFailures >= this.maxConsecutiveFailures) {
          if (this.checkTimer) {
            this.stopLockTimer();
          }
        }
        return 'failed';
      }

      return switchedModel ? 'switched' : 'already-selected';
    } catch (e) {
      console.error('Auto lock failed', e);
      return 'failed';
    } finally {
      this.isLocked = false;
    }
  }

  private async tryLockToThinkingLevel(target: DefaultThinkingLevel): Promise<boolean> {
    if (this.shouldYieldToUserComposerActivity()) {
      this.stopLockTimer();
      return false;
    }

    if (this.isLocked) return false;
    this.isLocked = true;

    try {
      const trigger = this.picker.findSelectorButton();
      if (!trigger) return false;

      // Open the model menu first.
      trigger.click();

      const modelPane = await this.picker.waitForModeSwitchMenuPanel(1500);
      if (!modelPane) {
        document.body.click();
        this.consecutiveFailures++;
        this.maybeNotifyAutoApplyFailure();
        if (this.consecutiveFailures >= this.maxConsecutiveFailures && this.checkTimer) {
          this.stopLockTimer();
        }
        return false;
      }

      // Current Gemini UI no longer exposes a Standard / Extended submenu.
      // Extended thinking is a single opt-in row in the model menu; Standard
      // is the implicit state when that row is not selected.
      const inlineToggle = this.picker.findInlineExtendedThinkingToggle(modelPane);
      if (inlineToggle) {
        const alreadySelected =
          inlineToggle.classList.contains('selected') ||
          inlineToggle.getAttribute('aria-checked') === 'true' ||
          inlineToggle.getAttribute('aria-selected') === 'true';

        if (!alreadySelected) {
          inlineToggle.click();
          document.body.click();
          this.focusChatInputAfterAutoSwitch();
          this.consecutiveFailures = 0;
          return true;
        }

        document.body.click();
        this.consecutiveFailures = 0;
        this.stopLockTimer();
        return false;
      }

      const thinkingRow = this.picker.findThinkingLevelTriggerRow();
      if (!thinkingRow) {
        // This model doesn't expose a Thinking level. Nothing to lock — stop trying.
        document.body.click();
        this.stopLockTimer();
        return false;
      }

      this.picker.openThinkingLevelSubmenu(thinkingRow);

      // Wait briefly for the submenu to mount.
      const submenu = await this.picker.waitForThinkingLevelSubmenu(1500);
      if (!submenu) {
        document.body.click();
        this.consecutiveFailures++;
        this.maybeNotifyAutoApplyFailure();
        if (this.consecutiveFailures >= this.maxConsecutiveFailures && this.checkTimer) {
          this.stopLockTimer();
        }
        return false;
      }

      const items = this.picker.getThinkingLevelItems();
      if (!items.length) {
        document.body.click();
        return false;
      }

      const targetLabel = target.label.toLowerCase().trim();
      const byLabel = items.find(
        (it) => this.picker.getThinkingLevelLabel(it).toLowerCase().trim() === targetLabel,
      );
      const byIndex = items[target.index] ?? null;
      const targetItem = byLabel ?? byIndex;

      if (!targetItem) {
        document.body.click();
        this.consecutiveFailures++;
        this.maybeNotifyAutoApplyFailure();
        if (this.consecutiveFailures >= this.maxConsecutiveFailures && this.checkTimer) {
          this.stopLockTimer();
        }
        return false;
      }

      const alreadySelected = targetItem.classList.contains('selected');
      if (!alreadySelected) {
        targetItem.click();
        // Auto-apply opened the picker programmatically. Close it (and the
        // thinking-level submenu overlay) so the user's next manual open starts
        // from a clean state — leaving it half-open left the Thinking level row
        // unresponsive until the menu was closed and reopened by hand.
        document.body.click();
        this.focusChatInputAfterAutoSwitch();
        this.consecutiveFailures = 0;
        return true;
      } else {
        document.body.click();
        this.consecutiveFailures = 0;
        this.stopLockTimer();
      }

      this.consecutiveFailures = 0;
      return false;
    } catch (e) {
      console.error('Auto thinking-level lock failed', e);
      return false;
    } finally {
      this.isLocked = false;
    }
  }

  private focusChatInputAfterAutoSwitch(): void {
    const focusDelayMs = 120;
    window.setTimeout(() => {
      const input = this.findChatInputElement();
      if (!input) return;

      try {
        input.focus({ preventScroll: true });
      } catch {
        input.focus();
      }
    }, focusDelayMs);
  }

  private findChatInputElement(): HTMLElement | null {
    for (const selector of CHAT_INPUT_SELECTORS) {
      const candidates = document.querySelectorAll<HTMLElement>(selector);
      for (const candidate of Array.from(candidates)) {
        if (!candidate.isConnected) continue;
        if (candidate instanceof HTMLTextAreaElement && candidate.disabled) continue;
        return candidate;
      }
    }
    return null;
  }

  private subscribeToComposerActivity(): void {
    if (this.composerActivityHandler) return;

    this.composerActivityHandler = (event) => {
      const target = event.target instanceof HTMLElement ? event.target : null;
      if (!this.isChatInputElement(target)) return;
      this.lastComposerActivityPath = window.location.pathname;
      this.lastComposerActivityAt = Date.now();
    };

    document.addEventListener('input', this.composerActivityHandler, { capture: true });
    document.addEventListener('keydown', this.composerActivityHandler, { capture: true });
  }

  private unsubscribeFromComposerActivity(): void {
    if (!this.composerActivityHandler) return;
    document.removeEventListener('input', this.composerActivityHandler, { capture: true });
    document.removeEventListener('keydown', this.composerActivityHandler, { capture: true });
    this.composerActivityHandler = null;
  }

  private isChatInputElement(element: HTMLElement | null): boolean {
    if (!element) return false;
    const input = this.findChatInputElement();
    return Boolean(input && (element === input || input.contains(element)));
  }

  private shouldYieldToUserComposerActivity(): boolean {
    const input = this.findChatInputElement();
    const text = input ? this.getChatInputText(input).trim() : '';
    if (text.length > 0) return true;

    return (
      this.lastComposerActivityPath === window.location.pathname &&
      Date.now() - this.lastComposerActivityAt < RECENT_COMPOSER_ACTIVITY_MS
    );
  }

  private getChatInputText(input: HTMLElement): string {
    if (input instanceof HTMLTextAreaElement) {
      return input.value;
    }
    return input.innerText ?? input.textContent ?? '';
  }
}

export default DefaultModelManager;
