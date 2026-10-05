import { createToaster } from '@/core/ui/toast/toaster';
import { createTranslator, initI18n } from '@/utils/i18n';

const REDIRECT_WINDOW_MS = 30000;
const ROUTE_CHECK_MS = 200;
const LOAD_FAILURE =
  /(?:conversation|chat).*(?:not found|could not be found)|(?:unable|cannot|can't|couldn't|could not) (?:to )?load (?:conversation|chat)|(?:correct|different|another) account/i;

/** A home redirect alone is normal navigation, so require the host's access/load error too. */
export function startChatGptLegacyJumpHint(): () => void {
  if (!/^\/c\/[^/]+\/?$/.test(location.pathname) || !location.hash.startsWith('#gv-turn-'))
    return () => {};
  const toaster = createToaster();
  const t = createTranslator();
  let failureSeen = false;
  let stopped = false;
  let shown = false;
  const noteErrors = (node: Node): void => {
    if (!(node instanceof Element)) return;
    const alerts = [
      ...(node.matches('[role="alert"]') ? [node] : []),
      ...node.querySelectorAll('[role="alert"]'),
    ];
    if (alerts.some((alert) => LOAD_FAILURE.test(alert.textContent ?? ''))) failureSeen = true;
  };
  const check = (): void => {
    noteErrors(document.documentElement);
    if (!shown && failureSeen && location.pathname === '/') {
      shown = true;
      observer.disconnect();
      clearInterval(interval);
      clearTimeout(expiry);
      const showHint = (): void => {
        if (stopped) return;
        toaster.show({
          message: t('savedLibraryChatGptSwitchHint'),
          tone: 'warning',
          durationMs: null,
          dismissLabel: t('changelog_close'),
        });
      };
      void initI18n().then(showHint, showHint);
    }
  };
  const observer = new MutationObserver((changes) => {
    for (const change of changes) {
      // Hosts remove the error while replacing the conversation with their home screen.
      for (const removed of change.removedNodes) noteErrors(removed);
    }
    check();
  });
  observer.observe(document.documentElement, {
    childList: true,
    subtree: true,
    characterData: true,
  });
  const interval = setInterval(check, ROUTE_CHECK_MS);
  const expiry = setTimeout(() => {
    observer.disconnect();
    clearInterval(interval);
  }, REDIRECT_WINDOW_MS);
  check();
  return () => {
    stopped = true;
    observer.disconnect();
    clearInterval(interval);
    clearTimeout(expiry);
    toaster.destroy();
  };
}
