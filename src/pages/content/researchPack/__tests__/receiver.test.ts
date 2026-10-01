import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { HANDOFF_MESSAGES, type HandoffMessage } from '@/features/researchPack/services/handoff';

import {
  RECEIVER_COMPOSER_TIMEOUT_MS,
  RECEIVER_POLL_MS,
  RECEIVER_STABLE_POLLS,
  startResearchPackReceiver,
} from '../receiver';

const PACK = '# Research pack\n\n## 1. Why is the sky blue?\n\nRayleigh scattering.';
const SETTLE_MS = RECEIVER_POLL_MS * (RECEIVER_STABLE_POLLS + 1);

function chatgptComposer(): {
  composer: HTMLElement;
  submitted: ReturnType<typeof vi.fn>;
  sendClicked: ReturnType<typeof vi.fn>;
  enterPressed: ReturnType<typeof vi.fn>;
} {
  document.body.innerHTML = `
    <main>
      <form>
        <div id="prompt-textarea" contenteditable="true"></div>
        <button type="submit" data-testid="send-button">Send</button>
      </form>
    </main>`;
  const form = document.querySelector('form')!;
  const composer = document.querySelector<HTMLElement>('#prompt-textarea')!;
  const submitted = vi.fn((event: Event) => event.preventDefault());
  const sendClicked = vi.fn();
  const enterPressed = vi.fn();
  form.addEventListener('submit', submitted);
  document.querySelector('[data-testid="send-button"]')!.addEventListener('click', sendClicked);
  composer.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') enterPressed();
  });
  return { composer, submitted, sendClicked, enterPressed };
}

describe('research pack receiver on ChatGPT and Claude', () => {
  let stop: (() => void) | null = null;
  let pending: boolean;
  let claimReply: unknown;
  let send: ReturnType<typeof vi.fn<(message: HandoffMessage) => Promise<unknown>>>;

  const sent = () => send.mock.calls.map(([message]) => message.type);
  const toast = () => document.querySelector<HTMLElement>('.gv-rp-root .gv-rp-toast');

  function start(pageUrl = 'https://chatgpt.com/', isTopFrame = true): void {
    stop = startResearchPackReceiver({
      send,
      pageUrl: () => pageUrl,
      isTopFrame: () => isTopFrame,
    });
  }

  beforeEach(() => {
    vi.useFakeTimers();
    document.body.innerHTML = '';
    pending = true;
    claimReply = { ok: true, markdown: PACK };
    send = vi.fn(async (message: HandoffMessage) => {
      if (message.type === HANDOFF_MESSAGES.peek) return { ok: true, pending };
      if (message.type === HANDOFF_MESSAGES.claim) return claimReply;
      return undefined;
    });
  });

  afterEach(() => {
    stop?.();
    stop = null;
    vi.useRealTimers();
    document.body.innerHTML = '';
  });

  it('fills the ChatGPT composer once and sends nothing', async () => {
    const { composer, submitted, sendClicked, enterPressed } = chatgptComposer();
    start();
    await vi.advanceTimersByTimeAsync(SETTLE_MS);

    expect(sent()).toEqual([HANDOFF_MESSAGES.peek, HANDOFF_MESSAGES.claim]);
    expect(composer.textContent).toContain('Rayleigh scattering.');
    expect(composer.textContent).toContain('# Research pack');
    expect(submitted).not.toHaveBeenCalled();
    expect(sendClicked).not.toHaveBeenCalled();
    expect(enterPressed).not.toHaveBeenCalled();
    expect(toast()?.textContent).toBe(
      'Research pack added from Gemini. Review it, then send it yourself.',
    );
    expect(toast()?.dataset.tone).toBe('ok');

    await vi.advanceTimersByTimeAsync(RECEIVER_COMPOSER_TIMEOUT_MS);
    expect(sent()).toEqual([HANDOFF_MESSAGES.peek, HANDOFF_MESSAGES.claim]);
    expect(toast()).toBeNull();
  });

  it('fills the Claude composer found through the site adapter', async () => {
    document.body.innerHTML =
      '<fieldset><div contenteditable="true" class="ProseMirror"><p></p></div></fieldset>';
    start('https://claude.ai/new');
    await vi.advanceTimersByTimeAsync(SETTLE_MS);

    expect(document.querySelector('.ProseMirror')!.textContent).toContain('Rayleigh scattering.');
    expect(sent()).toEqual([HANDOFF_MESSAGES.peek, HANDOFF_MESSAGES.claim]);
  });

  it('waits for a composer that mounts late, and claims only once it holds still', async () => {
    start();
    await vi.advanceTimersByTimeAsync(SETTLE_MS * 3);
    expect(sent()).toEqual([HANDOFF_MESSAGES.peek]);

    const { composer } = chatgptComposer();
    await vi.advanceTimersByTimeAsync(SETTLE_MS);
    expect(sent()).toEqual([HANDOFF_MESSAGES.peek, HANDOFF_MESSAGES.claim]);
    expect(composer.textContent).toContain('Rayleigh scattering.');
  });

  it('does nothing on an ordinary page load: no observer, no timer, no claim', async () => {
    pending = false;
    chatgptComposer();
    start();
    await vi.advanceTimersByTimeAsync(0);

    expect(sent()).toEqual([HANDOFF_MESSAGES.peek]);
    expect(vi.getTimerCount()).toBe(0);
    expect(toast()).toBeNull();
  });

  it('leaves the pack unclaimed and says so when no composer ever appears', async () => {
    start();
    await vi.advanceTimersByTimeAsync(RECEIVER_COMPOSER_TIMEOUT_MS + SETTLE_MS);

    expect(sent()).toEqual([HANDOFF_MESSAGES.peek]);
    expect(toast()?.dataset.tone).toBe('error');
    expect(toast()?.textContent).toBe(
      "Couldn't add the research pack here. Go back to Gemini and copy it.",
    );
  });

  it('inserts nothing when another claim already took the pack', async () => {
    claimReply = { ok: false };
    const { composer } = chatgptComposer();
    start();
    await vi.advanceTimersByTimeAsync(SETTLE_MS);

    expect(composer.textContent).toBe('');
    expect(toast()).toBeNull();
  });

  it('stops waiting on teardown and never claims afterwards', async () => {
    start();
    await vi.advanceTimersByTimeAsync(RECEIVER_POLL_MS);
    stop!();
    stop = null;

    chatgptComposer();
    await vi.advanceTimersByTimeAsync(RECEIVER_COMPOSER_TIMEOUT_MS + SETTLE_MS);
    expect(sent()).toEqual([HANDOFF_MESSAGES.peek]);
    expect(vi.getTimerCount()).toBe(0);
    expect(toast()).toBeNull();
  });

  it('removes its toast on teardown', async () => {
    chatgptComposer();
    start();
    await vi.advanceTimersByTimeAsync(SETTLE_MS);
    expect(toast()).not.toBeNull();

    stop!();
    stop = null;
    expect(document.querySelector('.gv-rp-root')).toBeNull();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('stays out of Gemini pages and embedded frames', async () => {
    chatgptComposer();
    start('https://gemini.google.com/app');
    stop!();
    start('https://chatgpt.com/', false);
    await vi.advanceTimersByTimeAsync(SETTLE_MS);

    expect(send).not.toHaveBeenCalled();
  });
});
