import './testSetup';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { requireBundledSiteAdapter } from '@/features/plugins/catalog/sites';
import { PluginScope } from '@/features/plugins/runtime/pluginScope';
import { turnNavigatorPrimitive } from '@/features/plugins/verbs/turnNavigator';

vi.mock('@/utils/i18n', () => ({
  initI18n: vi.fn().mockResolvedValue(undefined),
  getTranslationSync: (key: string) => key,
}));
vi.mock('@/pages/content/timeline/timelineStyleCoachmark', () => ({
  showTimelineStyleCoachmark: vi.fn().mockResolvedValue(undefined),
}));

const scopes: PluginScope[] = [];
let releaseRead: (() => void) | null;

async function flush(): Promise<void> {
  for (let i = 0; i < 30; i++) await Promise.resolve();
}

beforeEach(() => {
  history.replaceState({}, '', '/c/one');
  document.body.innerHTML =
    '<main data-conversation-id="one"><div data-user-message-bubble>Prompt</div></main>';
  releaseRead = null;
  let firstRead = true;
  vi.mocked(chrome.runtime.sendMessage).mockImplementation(((
    request: { type: string },
    callback: (value: unknown) => void,
  ) => {
    if (request.type === 'gv.starred.getForConversation') {
      const respond = () => callback({ ok: true, messages: [] });
      if (firstRead) {
        firstRead = false;
        releaseRead = respond;
      } else respond();
    }
  }) as typeof chrome.runtime.sendMessage);
});

afterEach(async () => {
  releaseRead?.();
  for (const scope of scopes.splice(0)) await scope.dispose();
  document.body.innerHTML = '';
});

function enable(): PluginScope {
  const scope = new PluginScope();
  scopes.push(scope);
  turnNavigatorPrimitive.activate(
    scope,
    {},
    {
      doc: document,
      adapter: requireBundledSiteAdapter('chatgpt'),
      pluginId: 'voyager.chatgpt-timeline',
      settings: {},
      setTargetCounter: () => {},
    },
  );
  return scope;
}

describe('timeline scope lifetime', () => {
  it('late cleanup cannot remove a re-enabled rail while the first library read is pending', async () => {
    const oldScope = enable();
    await flush();
    const oldRail = document.querySelector('.gemini-timeline-bar');
    expect(oldRail).not.toBeNull();
    expect(releaseRead).not.toBeNull();

    const disposal = oldScope.dispose();
    expect(oldRail?.isConnected).toBe(false);
    const newScope = enable();
    await flush();
    const newRail = document.querySelector('.gemini-timeline-bar');
    expect(newRail).not.toBeNull();
    expect(newRail).not.toBe(oldRail);
    expect(newRail?.querySelectorAll('.timeline-dot')).toHaveLength(1);

    releaseRead?.();
    await disposal;
    await flush();
    expect(newScope.isDisposed).toBe(false);
    expect(document.querySelector('.gemini-timeline-bar')).toBe(newRail);
    expect(newRail?.isConnected).toBe(true);
  });
});

describe('timeline startup outline', () => {
  it('editing a level while the Library read is delayed preserves saved chapters and collapse state', async () => {
    const { buildTurnId } = await import('./turnMerge');
    const key = 'gvTimelineHierarchy:chatgpt:chatgpt:conv:one';
    const heading = buildTurnId('Saved heading');
    const child = buildTurnId('Saved child');
    localStorage.setItem(key, JSON.stringify({ levels: { [child]: 2 }, collapsed: [heading] }));
    enable();
    await flush();
    document
      .querySelector('main')!
      .insertAdjacentHTML(
        'beforeend',
        '<div data-user-message-bubble>Saved heading</div><div data-user-message-bubble>Saved child</div>',
      );
    await vi.waitFor(() => expect(document.querySelector('.timeline-dot')).not.toBeNull());
    expect(releaseRead).not.toBeNull();
    document
      .querySelector('.timeline-dot')!
      .dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, button: 2 }));
    document.querySelector<HTMLButtonElement>('.timeline-context-menu [data-level="3"]')!.click();
    expect(JSON.parse(localStorage.getItem(key)!)).toEqual({
      levels: { [child]: 2, [buildTurnId('Prompt')]: 3 },
      collapsed: [heading],
    });
    releaseRead?.();
    await flush();
    expect(JSON.parse(localStorage.getItem(key)!)).toEqual({
      levels: { [child]: 2, [buildTurnId('Prompt')]: 3 },
      collapsed: [heading],
    });
  });
});
