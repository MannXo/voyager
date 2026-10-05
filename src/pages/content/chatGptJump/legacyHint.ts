import { createToaster } from '@/core/ui/toast/toaster';
import { CHATGPT_CONVERSATION_ID_ATTRIBUTE } from '@/features/plugins/builtin';
import { createTranslator, initI18n } from '@/utils/i18n';

const REDIRECT_WINDOW_MS = 30000;
const ROUTE_CHECK_MS = 200;
const CONVERSATION_ROUTE = /^\/c\/([^/]+)\/?$/;
const HOME_ROUTE = '/';

function conversationInRoute(): string | undefined {
  return CONVERSATION_ROUTE.exec(location.pathname)?.[1];
}

function targetTurnsRendered(conversationId: string): boolean {
  return Array.from(document.querySelectorAll(`[${CHATGPT_CONVERSATION_ID_ATTRIBUTE}]`)).some(
    (node) => node.getAttribute(CHATGPT_CONVERSATION_ID_ATTRIBUTE)?.trim() === conversationId,
  );
}

/**
 * A saved-turn link the host bounces home on its own suggests another account
 * (or a deleted chat). The route alone is language-independent; user input,
 * history navigation and a successful load all mean a later home route is the
 * user's choice, not a bounce.
 */
export function startChatGptLegacyJumpHint(): () => void {
  const target = conversationInRoute();
  if (!target || !location.hash.startsWith('#gv-turn-')) return () => {};
  const toaster = createToaster();
  const t = createTranslator();
  let stopped = false;
  let armed = true;

  const disarm = (): void => {
    if (!armed) return;
    armed = false;
    window.removeEventListener('pointerdown', onUserInput, true);
    window.removeEventListener('keydown', onUserInput, true);
    window.removeEventListener('popstate', disarm);
    clearInterval(interval);
    clearTimeout(expiry);
  };
  const onUserInput = (event: Event): void => {
    if (event.isTrusted) disarm();
  };
  const showHint = (): void => {
    if (stopped) return;
    toaster.show({
      message: t('savedLibraryChatGptSwitchHint'),
      tone: 'warning',
      durationMs: null,
      dismissLabel: t('changelog_close'),
    });
  };
  const check = (): void => {
    if (!armed) return;
    if (conversationInRoute() === target) {
      if (targetTurnsRendered(target)) disarm();
      return;
    }
    const bouncedHome = location.pathname === HOME_ROUTE;
    disarm();
    if (bouncedHome) void initI18n().then(showHint, showHint);
  };

  // Capture phase sees the click or shortcut before the host's router acts on it.
  window.addEventListener('pointerdown', onUserInput, true);
  window.addEventListener('keydown', onUserInput, true);
  window.addEventListener('popstate', disarm);
  const interval = setInterval(check, ROUTE_CHECK_MS);
  const expiry = setTimeout(disarm, REDIRECT_WINDOW_MS);
  check();
  return () => {
    stopped = true;
    disarm();
    toaster.destroy();
  };
}
