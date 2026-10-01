import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  type ResearchPackStorageArea,
  createResearchPackStore,
} from '@/features/researchPack/services/packStore';
import type { ResearchPack } from '@/features/researchPack/services/types';

import { findChatInput, insertTextIntoChatInput } from '../../chatInput';
import { startResearchPack } from '../index';
import { ADD_BUTTON_CLASS } from '../turnButtons';
import { collectAnswerLinks } from '../turnCapture';

vi.mock('../../chatInput', () => ({
  findChatInput: vi.fn(),
  insertTextIntoChatInput: vi.fn(),
}));

const KEY = 'test-pack';

function memoryStore() {
  const data = new Map<string, unknown>();
  const area: ResearchPackStorageArea = {
    get: async (key) => (data.has(key) ? { [key]: data.get(key) } : {}),
    set: async (items) => {
      for (const [key, value] of Object.entries(items)) data.set(key, structuredClone(value));
    },
  };
  const store = createResearchPackStore({ area, resolveKey: async () => KEY });
  return { store, stored: () => data.get(KEY) as ResearchPack | undefined };
}

function turn(answerHtml: string, prompt = 'Why is the sky blue?'): HTMLElement {
  const container = document.createElement('div');
  container.className = 'conversation-container';
  container.innerHTML = `
    <user-query><div class="query-text">${prompt}</div></user-query>
    <model-response>
      <div class="response-container">
        <model-thoughts><a href="https://thoughts.example/hidden">thinking</a></model-thoughts>
        <message-content><div class="markdown">${answerHtml}</div></message-content>
        <message-actions>
          <div class="actions-container-v2">
            <div class="buttons-container-v2">
              <button class="copy">Copy</button>
              <a href="https://g.co/share/x">Share</a>
            </div>
          </div>
        </message-actions>
      </div>
    </model-response>`;
  document.body.appendChild(container);
  return container.querySelector('model-response') as HTMLElement;
}

async function flush(): Promise<void> {
  for (let i = 0; i < 5; i += 1) await Promise.resolve();
  await new Promise((resolve) => setTimeout(resolve, 0));
}

function clickAdd(host: HTMLElement): void {
  const button = host.querySelector<HTMLButtonElement>(`.${ADD_BUTTON_CLASS}`)!;
  button.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true }));
  button.click();
}

describe('research pack on Gemini', () => {
  let stop: (() => void) | null = null;

  beforeEach(() => {
    document.body.innerHTML = '';
    vi.mocked(findChatInput).mockReset();
    vi.mocked(insertTextIntoChatInput).mockReset();
  });

  afterEach(() => {
    stop?.();
    stop = null;
    document.body.innerHTML = '';
  });

  it('collects answer and source links but not thoughts or action-bar links', () => {
    const host = turn(
      'See <a href="https://example.com/a">Example A</a> and <a href="#local">jump</a>.' +
        '<a aria-label="Source B" href="https://example.org/b">chip</a>',
    );

    expect(collectAnswerLinks(host)).toEqual([
      { url: 'https://example.com/a', title: 'Example A' },
      { url: 'https://example.org/b', title: 'Source B' },
    ]);
  });

  it('adds a clicked answer with its prompt and sources, and renders it in the panel', async () => {
    const host = turn('<p>Rayleigh scattering.</p><a href="https://example.com/a">Example A</a>');
    const { store, stored } = memoryStore();
    stop = startResearchPack({ store });

    const buttons = host.querySelectorAll(`.${ADD_BUTTON_CLASS}`);
    expect(buttons).toHaveLength(1);
    expect(host.querySelector('.buttons-container-v2')!.lastElementChild).toBe(buttons[0]);

    clickAdd(host);
    await flush();

    const pack = stored()!;
    expect(pack.items).toHaveLength(1);
    expect(pack.items[0]).toMatchObject({ excerpt: false, sourceUrl: window.location.href });
    expect(pack.items[0].text).toContain('Rayleigh scattering.');
    expect(pack.items[0].prompt).toContain('Why is the sky blue?');
    expect(pack.items[0].citations).toEqual([{ url: 'https://example.com/a', title: 'Example A' }]);
    expect(document.querySelectorAll('.gv-rp-item')).toHaveLength(1);
    expect(document.querySelector('.gv-rp-markdown')!.textContent).toContain(
      '[Example A](https://example.com/a)',
    );

    clickAdd(host);
    await flush();
    expect(stored()!.items).toHaveLength(1);
  });

  it('inserts the assembled Markdown into the composer without sending it', async () => {
    const host = turn('<p>Answer text.</p>');
    const composer = document.createElement('div');
    vi.mocked(findChatInput).mockReturnValue(composer);
    vi.mocked(insertTextIntoChatInput).mockReturnValue(true);
    const { store } = memoryStore();
    stop = startResearchPack({ store });

    clickAdd(host);
    await flush();
    const insert = document.querySelector<HTMLButtonElement>('.gv-rp-btn-primary')!;
    insert.click();

    expect(insertTextIntoChatInput).toHaveBeenCalledOnce();
    const [text, target] = vi.mocked(insertTextIntoChatInput).mock.calls[0];
    expect(target).toBe(composer);
    expect(text).toContain('# Research pack');
    expect(text).toContain('Answer text.');
  });

  it('adds only the selected part of an answer as an excerpt', async () => {
    const host = turn('<p id="first">First sentence.</p><p>Second sentence.</p>');
    const { store, stored } = memoryStore();
    stop = startResearchPack({ store });

    const range = document.createRange();
    range.selectNodeContents(host.querySelector('#first')!);
    window.getSelection()!.removeAllRanges();
    window.getSelection()!.addRange(range);
    clickAdd(host);
    await flush();

    expect(stored()!.items[0]).toMatchObject({ text: 'First sentence.', excerpt: true });
    window.getSelection()!.removeAllRanges();
  });

  it('removes its buttons and panel on stop and leaves the stored pack intact', async () => {
    const host = turn('<p>Keep me.</p>');
    const { store, stored } = memoryStore();
    stop = startResearchPack({ store });
    clickAdd(host);
    await flush();

    stop();
    stop = null;

    expect(document.querySelector(`.${ADD_BUTTON_CLASS}`)).toBeNull();
    expect(document.querySelector('.gv-rp-root')).toBeNull();
    expect(stored()!.items).toHaveLength(1);

    turn('<p>Later answer.</p>');
    await new Promise((resolve) => setTimeout(resolve, 350));
    expect(document.querySelector(`.${ADD_BUTTON_CLASS}`)).toBeNull();
  });

  it('adds buttons to answers that stream in later', async () => {
    const { store } = memoryStore();
    stop = startResearchPack({ store });

    const host = turn('<p>Late.</p>');
    expect(host.querySelector(`.${ADD_BUTTON_CLASS}`)).toBeNull();
    await new Promise((resolve) => setTimeout(resolve, 350));
    expect(host.querySelectorAll(`.${ADD_BUTTON_CLASS}`)).toHaveLength(1);
  });
});
