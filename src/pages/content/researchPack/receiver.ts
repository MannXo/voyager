/**
 * Receiving end of "Continue in ChatGPT / Claude", on the new chat tab the
 * background opened (see `features/researchPack/services/handoff.ts`).
 *
 * Order: peek → wait for the composer → claim → insert. Peeking first keeps
 * every ordinary page load free of observers and timers. Claiming only once
 * the composer exists means a login redirect or a slow page leaves the record
 * to expire instead of spending it. The pack goes into the composer and
 * nothing is sent: the user reviews it and presses send.
 *
 * The composer comes from the site adapter's `composer` selector and the text
 * goes in through the shared `insertTextIntoChatInput`.
 */
import { SiteRegistry } from '@/features/plugins/sites/registry';
import {
  HANDOFF_MESSAGES,
  type HandoffMessage,
  handoffTargetForUrl,
} from '@/features/researchPack/services/handoff';
import { getTranslationSync } from '@/utils/i18n';
import type { TranslationKey } from '@/utils/translations';

import { insertTextIntoChatInput } from '../chatInput';
import type { StopNativeFeature } from '../featureLifecycle';

export const RECEIVER_POLL_MS = 150;
/** The same element on this many polls in a row: the app has finished mounting it. */
export const RECEIVER_STABLE_POLLS = 3;
export const RECEIVER_COMPOSER_TIMEOUT_MS = 20_000;
export const RECEIVER_TOAST_MS = 6_000;

export interface ResearchPackReceiverDeps {
  send?: (message: HandoffMessage) => Promise<unknown>;
  insert?: (text: string, input: HTMLElement) => boolean;
  pageUrl?: () => string;
  isTopFrame?: () => boolean;
  t?: (key: TranslationKey) => string;
}

function isUsable(candidate: HTMLElement): boolean {
  return (
    candidate.isConnected &&
    !candidate.matches('[aria-disabled="true"]') &&
    !candidate.closest('[hidden], [inert], [aria-hidden="true"]')
  );
}

/** The site's composer: the last usable match of its adapter selector, visible ones first. */
export function findHandoffComposer(pageUrl: string, doc: Document = document): HTMLElement | null {
  const selector = SiteRegistry.createDefault().resolveByUrl(pageUrl)?.selectors.composer;
  if (!selector) return null;
  let candidates: HTMLElement[];
  try {
    candidates = Array.from(doc.querySelectorAll<HTMLElement>(selector)).filter(isUsable);
  } catch {
    return null;
  }
  const visible = candidates.filter((candidate) => candidate.getBoundingClientRect().height > 0);
  return visible.at(-1) ?? candidates.at(-1) ?? null;
}

function isClaim(value: unknown): value is { ok: true; markdown: string } {
  if (!value || typeof value !== 'object') return false;
  const record = value as { ok?: unknown; markdown?: unknown };
  return record.ok === true && typeof record.markdown === 'string' && record.markdown.length > 0;
}

export function startResearchPackReceiver(deps: ResearchPackReceiverDeps = {}): StopNativeFeature {
  const pageUrl = deps.pageUrl ?? (() => window.location.href);
  const isTopFrame = deps.isTopFrame ?? (() => window.top === window);
  if (!handoffTargetForUrl(pageUrl()) || !isTopFrame()) return () => {};

  const send = deps.send ?? ((message: HandoffMessage) => chrome.runtime.sendMessage(message));
  const insert =
    deps.insert ?? ((text: string, input: HTMLElement) => insertTextIntoChatInput(text, input));
  const t = deps.t ?? getTranslationSync;

  // Teardown is synchronous: every timer, the composer wait and the toast go at once.
  let stopped = false;
  const timers = new Set<ReturnType<typeof setTimeout>>();
  const toasts = new Set<HTMLElement>();
  let abandonWait: (() => void) | null = null;

  const later = (run: () => void, ms: number): void => {
    const timer = setTimeout(() => {
      timers.delete(timer);
      if (!stopped) run();
    }, ms);
    timers.add(timer);
  };

  const toast = (key: TranslationKey, tone: 'ok' | 'error'): void => {
    if (stopped || !document.body) return;
    // Inside .gv-rp-root so the research pack's theme variables apply here too.
    const root = document.createElement('div');
    root.className = 'gv-rp-root';
    const message = document.createElement('div');
    message.className = 'gv-rp-toast';
    message.setAttribute('role', 'status');
    message.setAttribute('aria-live', 'polite');
    message.dataset.tone = tone;
    message.textContent = t(key);
    root.append(message);
    document.body.append(root);
    toasts.add(root);
    later(() => {
      toasts.delete(root);
      root.remove();
    }, RECEIVER_TOAST_MS);
  };

  /** Resolve with the composer once it has held still, or null on timeout or teardown. */
  const waitForComposer = (): Promise<HTMLElement | null> =>
    new Promise((resolve) => {
      const deadline = Date.now() + RECEIVER_COMPOSER_TIMEOUT_MS;
      let previous: HTMLElement | null = null;
      let stable = 0;
      const finish = (composer: HTMLElement | null): void => {
        abandonWait = null;
        resolve(composer);
      };
      abandonWait = () => finish(null);
      const poll = (): void => {
        const composer = findHandoffComposer(pageUrl());
        stable = composer && composer === previous ? stable + 1 : composer ? 1 : 0;
        previous = composer;
        if (composer && stable >= RECEIVER_STABLE_POLLS) return finish(composer);
        if (Date.now() >= deadline) return finish(null);
        later(poll, RECEIVER_POLL_MS);
      };
      poll();
    });

  const receive = async (): Promise<void> => {
    const peek = (await send({ type: HANDOFF_MESSAGES.peek })) as { pending?: unknown } | undefined;
    if (stopped || peek?.pending !== true) return;

    const composer = await waitForComposer();
    if (stopped) return;
    if (!composer) {
      // Not claimed: the record expires on its own.
      toast('researchPackHandoffFailed', 'error');
      return;
    }

    const claim = await send({ type: HANDOFF_MESSAGES.claim });
    if (stopped || !isClaim(claim)) return;
    const input = composer.isConnected ? composer : findHandoffComposer(pageUrl());
    if (!input || !insert(claim.markdown, input)) {
      toast('researchPackHandoffFailed', 'error');
      return;
    }
    toast('researchPackHandoffReady', 'ok');
  };

  void receive().catch(() => undefined);
  return () => {
    if (stopped) return;
    stopped = true;
    for (const timer of timers) clearTimeout(timer);
    timers.clear();
    for (const root of toasts) root.remove();
    toasts.clear();
    abandonWait?.();
  };
}
