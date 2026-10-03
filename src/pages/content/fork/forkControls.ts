import { getTranslationSync } from '../../../utils/i18n';
import { collectForkChatPairs } from './chatPairs';

const STYLE_ID = 'gemini-voyager-fork-style';
const FORK_BTN_CLASS = 'gv-fork-btn';
const FORK_CONFIRM_CLASS = 'gv-fork-confirm';
const FORK_ICON = `<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="18" r="3"/><circle cx="6" cy="6" r="3"/><circle cx="18" cy="6" r="3"/><path d="M18 9v2c0 .6-.4 1-1 1H7c-.6 0-1-.4-1-1V9"/><path d="M12 12v3"/></svg>`;

function injectStyles(): void {
  if (document.getElementById(STYLE_ID)) return;
  const style = document.createElement('style');
  style.id = STYLE_ID;
  style.textContent = `
.gv-fork-btn {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 4px 8px;
  background: transparent;
  color: var(--gv-fork-btn-color, #5f6368);
  border: none;
  border-radius: 4px;
  cursor: pointer;
  font-size: 12px;
  font-family: 'Google Sans', Roboto, Arial, sans-serif;
  opacity: 0;
  visibility: hidden;
  pointer-events: none;
  transition:
    opacity 0.15s,
    transform 0.15s,
    background-color 0.15s;
  position: absolute;
  top: 9px;
  right: calc(100% + 8px);
  z-index: 1;
  white-space: nowrap;
  height: 22px;
  box-sizing: border-box;
}
.gv-fork-btn:hover {
  opacity: 1;
  background-color: var(--gv-fork-btn-hover-bg, rgba(0, 0, 0, 0.06));
}
.gv-fork-btn svg {
  width: 14px;
  height: 14px;
  flex-shrink: 0;
}

/* Reveal on hover/focus without affecting message layout */
.user-query-bubble-with-background:hover .gv-fork-btn,
.user-query-container:hover .gv-fork-btn,
user-query:hover .gv-fork-btn,
user-query-content:hover .gv-fork-btn,
.user-query-bubble-with-background:focus-within .gv-fork-btn,
.user-query-container:focus-within .gv-fork-btn,
user-query:focus-within .gv-fork-btn,
user-query-content:focus-within .gv-fork-btn,
.gv-fork-btn:hover,
.gv-fork-btn:focus-visible {
  opacity: 1;
  visibility: visible;
  pointer-events: auto;
}

html[dir='rtl'] .gv-fork-btn,
body[dir='rtl'] .gv-fork-btn,
body.gv-rtl .gv-fork-btn {
  right: auto;
  left: calc(100% + 8px);
}

/* Confirmation dialog */
.gv-fork-confirm {
  z-index: 9999;
  background: var(--gv-fork-confirm-bg, #fff);
  color: var(--gv-fork-confirm-color, #202124);
  border: 1px solid var(--gv-fork-confirm-border, rgba(0, 0, 0, 0.12));
  border-radius: 8px;
  padding: 12px;
  box-shadow: 0 4px 16px rgba(0, 0, 0, 0.12);
  white-space: nowrap;
  font-size: 13px;
  font-family: 'Google Sans', Roboto, Arial, sans-serif;
}
.gv-fork-confirm p {
  margin: 0 0 8px 0;
}
.gv-fork-confirm .gv-fork-actions {
  display: flex;
  gap: 8px;
  justify-content: flex-end;
}
.gv-fork-confirm button {
  padding: 4px 12px;
  border-radius: 4px;
  border: 1px solid var(--gv-fork-confirm-border, rgba(0, 0, 0, 0.12));
  cursor: pointer;
  font-size: 12px;
  font-family: 'Google Sans', Roboto, Arial, sans-serif;
  background: transparent;
  color: inherit;
}
.gv-fork-confirm button.gv-fork-primary {
  background: var(--gv-fork-primary-bg, #1a73e8);
  color: #fff;
  border-color: transparent;
}
.gv-fork-confirm button.gv-fork-primary:hover {
  background: var(--gv-fork-primary-hover-bg, #1765cc);
}
.gv-fork-confirm button.gv-fork-secondary {
  background: var(--gv-fork-secondary-bg, rgba(26, 115, 232, 0.08));
  color: var(--gv-fork-secondary-color, #1a73e8);
  border-color: var(--gv-fork-secondary-border, rgba(26, 115, 232, 0.22));
}
.gv-fork-confirm button.gv-fork-secondary:hover {
  background: var(--gv-fork-secondary-hover-bg, rgba(26, 115, 232, 0.14));
}

.gv-fork-manual-upload-hint {
  position: fixed;
  right: 20px;
  bottom: 20px;
  z-index: 9999;
  display: flex;
  align-items: flex-start;
  gap: 10px;
  max-width: 340px;
  padding: 12px 14px;
  border: 1px solid var(--gv-fork-confirm-border, rgba(0, 0, 0, 0.12));
  border-radius: 8px;
  background: var(--gv-fork-confirm-bg, #fff);
  color: var(--gv-fork-confirm-color, #202124);
  box-shadow: 0 4px 16px rgba(0, 0, 0, 0.14);
  font-size: 13px;
  line-height: 1.4;
  font-family: 'Google Sans', Roboto, Arial, sans-serif;
}
.gv-fork-manual-upload-hint span {
  flex: 1;
  min-width: 0;
}
.gv-fork-manual-upload-timer {
  display: block;
  margin-top: 6px;
  color: var(--gv-fork-secondary-color, #1a73e8);
  font-size: 14px;
  font-weight: 600;
  font-variant-numeric: tabular-nums;
  letter-spacing: 0;
}
.gv-fork-manual-upload-hint button {
  flex: 0 0 auto;
  width: 20px;
  height: 20px;
  padding: 0;
  border: none;
  border-radius: 50%;
  background: transparent;
  color: inherit;
  cursor: pointer;
  font-size: 16px;
  line-height: 20px;
}

/* Fork branch indicator group */
.gv-fork-indicator-group {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  margin-left: 8px;
  vertical-align: middle;
}
.gv-fork-indicator-item {
  position: relative;
  display: inline-flex;
  align-items: center;
  justify-content: center;
}

.gv-fork-indicator {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  min-width: 22px;
  height: 22px;
  padding: 0 6px;
  background: var(--gv-fork-indicator-bg, rgba(26, 115, 232, 0.06));
  color: var(--gv-fork-indicator-color, #1a73e8);
  border-radius: 4px;
  cursor: pointer;
  font-size: 12px;
  font-weight: 600;
  font-family: 'Google Sans', Roboto, Arial, sans-serif;
  border: 1px solid var(--gv-fork-indicator-border, rgba(26, 115, 232, 0.28));
  transition:
    background-color 0.15s,
    color 0.15s,
    border-color 0.15s;
}
.gv-fork-indicator:hover {
  background: var(--gv-fork-indicator-hover-bg, rgba(26, 115, 232, 0.16));
}
.gv-fork-indicator.gv-current {
  background: var(--gv-fork-indicator-current-bg, #1a73e8);
  color: var(--gv-fork-indicator-current-color, #fff);
  border-color: var(--gv-fork-indicator-current-bg, #1a73e8);
  cursor: default;
}
.gv-fork-indicator-delete {
  position: absolute;
  top: -5px;
  right: -5px;
  display: flex;
  align-items: center;
  justify-content: center;
  width: 14px;
  height: 14px;
  padding: 0;
  border-radius: 50%;
  border: 1px solid transparent;
  background: #ea4335;
  color: #fff;
  cursor: pointer;
  font-size: 10px;
  font-weight: 700;
  line-height: 1;
  font-family: 'Google Sans', Roboto, Arial, sans-serif;
  opacity: 0;
  pointer-events: none;
  transform: scale(0.8);
  transition:
    opacity 0.15s,
    transform 0.15s;
}
.gv-fork-indicator-item:hover .gv-fork-indicator-delete,
.gv-fork-indicator-item:focus-within .gv-fork-indicator-delete {
  opacity: 1;
  pointer-events: auto;
  transform: scale(1);
}
.gv-fork-indicator-delete:disabled {
  opacity: 0.6;
  cursor: default;
  pointer-events: none;
}

/* Dark mode */
html[dark] .gv-fork-btn,
body.dark-theme .gv-fork-btn {
  --gv-fork-btn-color: #9aa0a6;
  --gv-fork-btn-hover-bg: rgba(255, 255, 255, 0.08);
}
html[dark] .gv-fork-confirm,
body.dark-theme .gv-fork-confirm,
html[dark] .gv-fork-manual-upload-hint,
body.dark-theme .gv-fork-manual-upload-hint {
  --gv-fork-confirm-bg: #292a2d;
  --gv-fork-confirm-color: #e8eaed;
  --gv-fork-confirm-border: rgba(255, 255, 255, 0.12);
}
html[dark] .gv-fork-confirm button.gv-fork-primary,
body.dark-theme .gv-fork-confirm button.gv-fork-primary {
  --gv-fork-primary-bg: #8ab4f8;
  color: #202124;
}
html[dark] .gv-fork-confirm button.gv-fork-primary:hover,
body.dark-theme .gv-fork-confirm button.gv-fork-primary:hover {
  --gv-fork-primary-hover-bg: #aecbfa;
}
html[dark] .gv-fork-confirm button.gv-fork-secondary,
body.dark-theme .gv-fork-confirm button.gv-fork-secondary {
  --gv-fork-secondary-bg: rgba(138, 180, 248, 0.12);
  --gv-fork-secondary-color: #8ab4f8;
  --gv-fork-secondary-border: rgba(138, 180, 248, 0.28);
  --gv-fork-secondary-hover-bg: rgba(138, 180, 248, 0.2);
}
html[dark] .gv-fork-indicator,
body.dark-theme .gv-fork-indicator {
  --gv-fork-indicator-bg: rgba(138, 180, 248, 0.12);
  --gv-fork-indicator-color: #8ab4f8;
  --gv-fork-indicator-border: rgba(138, 180, 248, 0.28);
  --gv-fork-indicator-hover-bg: rgba(138, 180, 248, 0.2);
  --gv-fork-indicator-current-bg: #8ab4f8;
  --gv-fork-indicator-current-color: #202124;
}
html[dark] .gv-fork-indicator-delete,
body.dark-theme .gv-fork-indicator-delete {
  background: #f28b82;
  color: #202124;
}
`;
  document.head.appendChild(style);
}

function findUserCopyButtonAnchor(userEl: HTMLElement): HTMLElement | null {
  const copyButton =
    userEl.querySelector<HTMLElement>('button[data-test-id="copy-button"]') ||
    userEl
      .querySelector<HTMLElement>(
        'button mat-icon[fonticon="content_copy"], button mat-icon[data-mat-icon-name="content_copy"]',
      )
      ?.closest<HTMLElement>('button');

  if (!copyButton) return null;
  return copyButton.parentElement || copyButton;
}

export function createForkControls({
  ensureTurnId,
  resolveUserMessageHost,
  onFork,
}: {
  ensureTurnId: (element: HTMLElement, index: number) => string;
  resolveUserMessageHost: (element: HTMLElement) => HTMLElement;
  onFork: (element: HTMLElement, index: number, mode: 'paste' | 'fileUpload') => Promise<void>;
}) {
  function resolveForkButtonHost(userEl: HTMLElement): HTMLElement {
    return findUserCopyButtonAnchor(userEl) || resolveUserMessageHost(userEl);
  }

  let activeConfirm: HTMLElement | null = null;
  injectStyles();
  document.addEventListener('click', onDocumentClick);

  function dismissConfirm(): void {
    if (activeConfirm) {
      activeConfirm.remove();
      activeConfirm = null;
    }
  }

  function onDocumentClick(e: MouseEvent): void {
    if (activeConfirm && !activeConfirm.contains(e.target as Node)) {
      dismissConfirm();
    }
  }

  function injectForkButtons(): void {
    const pairs = collectForkChatPairs();

    pairs.forEach((pair, index) => {
      const userEl = pair.userElement;
      ensureTurnId(userEl, index);
      const hostEl = resolveForkButtonHost(userEl);

      const existingButton = userEl.querySelector<HTMLElement>(`.${FORK_BTN_CLASS}`);
      if (existingButton) {
        hostEl.style.position = hostEl.style.position || 'relative';
        if (existingButton.parentElement !== hostEl) {
          hostEl.appendChild(existingButton);
        }
        return;
      }

      const btn = document.createElement('button');
      btn.className = FORK_BTN_CLASS;
      btn.title = getTranslationSync('forkConversation');
      btn.innerHTML = `${FORK_ICON}<span>${getTranslationSync('forkConversation')}</span>`;

      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        e.preventDefault();
        showForkConfirmation(btn, userEl, index);
      });

      // Add at the end of the user message container
      hostEl.style.position = hostEl.style.position || 'relative';
      hostEl.appendChild(btn);
    });
  }

  function showForkConfirmation(btn: HTMLElement, userEl: HTMLElement, turnIndex: number): void {
    dismissConfirm();

    const confirm = document.createElement('div');
    confirm.className = FORK_CONFIRM_CLASS;
    confirm.innerHTML = `
    <p>${getTranslationSync('forkConfirm')}</p>
    <div class="gv-fork-actions">
      <button class="gv-fork-cancel">${getTranslationSync('forkCancel')}</button>
      <button class="gv-fork-secondary">${getTranslationSync('forkMarkdownBtn')}</button>
      <button class="gv-fork-primary">${getTranslationSync('forkConfirmBtn')}</button>
    </div>
  `;

    const cancelBtn = confirm.querySelector('.gv-fork-cancel')!;
    const markdownBtn = confirm.querySelector('.gv-fork-secondary')!;
    const confirmBtn = confirm.querySelector('.gv-fork-primary')!;

    cancelBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      e.preventDefault();
      dismissConfirm();
    });
    confirmBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      e.preventDefault();
      dismissConfirm();
      void onFork(userEl, turnIndex, 'paste');
    });
    markdownBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      e.preventDefault();
      dismissConfirm();
      void onFork(userEl, turnIndex, 'fileUpload');
    });

    // Prevent clicks inside the dialog from bubbling to parent handlers
    confirm.addEventListener('click', (e) => e.stopPropagation());

    // Position near the fork button using fixed positioning
    const btnRect = btn.getBoundingClientRect();
    confirm.style.position = 'fixed';
    confirm.style.top = `${btnRect.top - 4}px`;
    confirm.style.left = `${btnRect.right}px`;
    confirm.style.transform = 'translateY(-100%)';

    document.body.appendChild(confirm);
    activeConfirm = confirm;
  }

  function updateForkButtonTexts(): void {
    const buttons = document.querySelectorAll<HTMLElement>(`.${FORK_BTN_CLASS}`);
    buttons.forEach((btn) => {
      btn.title = getTranslationSync('forkConversation');
      const span = btn.querySelector('span');
      if (span) span.textContent = getTranslationSync('forkConversation');
    });
  }
  return {
    inject: injectForkButtons,
    updateLanguage: updateForkButtonTexts,
    stop() {
      dismissConfirm();
      document.removeEventListener('click', onDocumentClick);
      document.querySelectorAll(`.${FORK_BTN_CLASS}`).forEach((element) => element.remove());
      document.getElementById(STYLE_ID)?.remove();
    },
  };
}
