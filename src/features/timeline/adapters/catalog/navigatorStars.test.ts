import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { StarredMessage } from '@/pages/content/timeline/starredTypes';

import { NavigatorStars } from './navigatorStars';

const { addStarredMessage, getStarredMessagesForConversation, removeStarredMessage } = vi.hoisted(
  () => ({
    addStarredMessage: vi.fn().mockResolvedValue(undefined),
    getStarredMessagesForConversation: vi.fn().mockResolvedValue([]),
    removeStarredMessage: vi.fn().mockResolvedValue(undefined),
  }),
);

vi.mock('@/pages/content/timeline/StarredMessagesService', () => ({
  StarredMessagesService: {
    addStarredMessage,
    getStarredMessagesForConversation,
    removeStarredMessage,
  },
}));

const turn = { id: 'c-same', hash: 'same', summary: 'Same prompt' };

let route: string;
let stars: NavigatorStars;

/** The conversation a host that names it puts on the turn's container. */
function stated(element: Element): string | null {
  const id = element.closest('[data-conv]')?.getAttribute('data-conv');
  return id ? `site:conv:${id}` : null;
}

function create(
  starId: () => string | null = () => route,
  turnConversation?: (element: Element) => string | null | undefined,
  storageKey?: (id: string) => string,
): NavigatorStars {
  stars = new NavigatorStars({
    routeId: () => route,
    starId,
    alive: () => true,
    turnConversation,
    storageKey,
  });
  stars.begin();
  return stars;
}

/** The host inserts a turn now, under whatever the URL names. */
function insert(): HTMLElement {
  const element = document.createElement('div');
  document.body.appendChild(element);
  stars.recordInsertions([{ addedNodes: [element] } as unknown as MutationRecord]);
  return element;
}

const seen = (element: Element, hash = 'same') => ({ element, hash });

function deferRead(): (messages: StarredMessage[]) => void {
  let release!: (messages: StarredMessage[]) => void;
  getStarredMessagesForConversation.mockImplementationOnce(
    () =>
      new Promise<StarredMessage[]>((resolve) => {
        release = resolve;
      }),
  );
  return (messages) => release(messages);
}

beforeEach(() => {
  document.body.innerHTML = '';
  route = 'site:conv:b';
  addStarredMessage.mockClear();
  getStarredMessagesForConversation.mockClear();
});

describe('navigator star writes', () => {
  it('writes what was pressed, where it was pressed, once the read lands', async () => {
    create();
    const element = insert();
    stars.observe([seen(element)]);
    const release = deferRead();
    void stars.load();

    const toggled = stars.toggle({ ...turn, element }, () => ({
      url: 'https://site/c/b',
      title: 'B',
    }));
    release([]);

    expect(await toggled).toBe(true);
    expect(addStarredMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        conversationId: 'site:conv:b',
        conversationUrl: 'https://site/c/b',
        content: 'Same prompt',
      }),
    );
  });

  it('drops a press when the conversation changes while its read is pending', async () => {
    create();
    const element = insert();
    stars.observe([seen(element)]);
    const release = deferRead();
    void stars.load();

    const toggled = stars.toggle({ ...turn, element }, () => ({
      url: 'https://site/c/b',
      title: 'B',
    }));
    route = 'site:conv:c';
    stars.observe([seen(insert())]);
    void stars.load();
    release([]);

    expect(await toggled).toBe(false);
    expect(addStarredMessage).not.toHaveBeenCalled();
  });

  it('refuses a press before a refresh has seen the current route', () => {
    create();
    const element = insert();
    stars.observe([seen(element)]);
    route = 'site:conv:c';
    expect(stars.canStar(element)).toBe(false);
  });

  it("never stars a new chat's turn, not even under the id the chat gets", () => {
    route = '/';
    create(() => (route.startsWith('site:conv:') ? route : null));
    const draft = insert();
    stars.observe([seen(draft, 'x')]);
    route = 'site:conv:c';
    stars.observe([seen(draft, 'x')]);

    expect(stars.canStar(draft)).toBe(false);
  });

  it('refuses a turn that entered the page under another conversation', () => {
    create();
    const item = insert();
    stars.observe([seen(item)]);
    route = 'site:conv:c';
    // Inserted while B's turn is still on screen: whose it is is not proven.
    const early = insert();
    stars.observe([seen(item), seen(early, 'other')]);
    item.remove();
    stars.observe([seen(early, 'other')]);
    const later = document.createElement('div');
    early.replaceWith(later);
    stars.recordInsertions([{ addedNodes: [later] } as unknown as MutationRecord]);
    stars.observe([seen(later, 'other')]);

    expect(stars.canStar(item)).toBe(false);
    expect(stars.canStar(early)).toBe(false);
    expect(stars.canStar(later)).toBe(true);
  });

  it("lets the host's id for a turn's conversation decide, both ways", () => {
    route = '/';
    create(() => (route.startsWith('site:conv:') ? route : null), stated);
    const draft = insert();
    stars.observe([seen(draft, 'x')]);
    route = 'site:conv:c';
    stars.observe([seen(draft, 'x')]);
    expect(stars.canStar(draft)).toBe(false);

    // The host says the new chat became this conversation.
    draft.setAttribute('data-conv', 'c');
    expect(stars.canStar(draft)).toBe(true);
    // A turn that entered under this URL, but the host files it elsewhere.
    const other = insert();
    other.setAttribute('data-conv', 'd');
    stars.observe([seen(draft, 'x'), seen(other, 'y')]);
    expect(stars.canStar(other)).toBe(false);

    // Where the host names conversations, a turn without its id is not starrable,
    // even one that entered the page under this conversation.
    const pending = insert();
    stars.observe([seen(draft, 'x'), seen(pending, 'z')]);
    expect(stars.canStar(pending)).toBe(false);
    pending.setAttribute('data-conv', 'c');
    expect(stars.canStar(pending)).toBe(true);
  });

  it('drops a press when the host files the turn elsewhere while its read is pending', async () => {
    create(() => route, stated);
    const element = insert();
    element.setAttribute('data-conv', 'b');
    stars.observe([seen(element)]);
    const release = deferRead();
    void stars.load();

    const toggled = stars.toggle({ ...turn, element }, () => ({
      url: 'https://site/c/b',
      title: 'B',
    }));
    element.setAttribute('data-conv', 'c');
    release([]);

    expect(await toggled).toBe(false);
    expect(addStarredMessage).not.toHaveBeenCalled();
  });

  it('writes the turn as it was when pressed, even if the marker changes meanwhile', async () => {
    create();
    const element = insert();
    stars.observe([seen(element)]);
    const release = deferRead();
    void stars.load();
    const target = { ...turn, element };

    const toggled = stars.toggle(target, () => ({ url: 'https://site/c/b', title: 'B' }));
    target.summary = 'Edited later';
    target.id = 'c-other';
    release([]);
    await toggled;

    expect(addStarredMessage).toHaveBeenCalledWith(
      expect.objectContaining({ turnId: 'c-same', content: 'Same prompt' }),
    );
  });
});

describe('catalog star primary storage', () => {
  beforeEach(() => localStorage.clear());
  const key = (id: string) => `gvTimelineStars:site:${id}`;

  it('reads a primary star even when the Saved Library mirror is missing it', async () => {
    localStorage.setItem(key(route), JSON.stringify(['c-same']));
    getStarredMessagesForConversation.mockResolvedValueOnce([]);
    create(() => route, undefined, key);
    await stars.load();
    expect(stars.get('same')?.turnId).toBe('c-same');
  });

  it('does not resurrect a Saved Library removal from the primary ids', async () => {
    localStorage.setItem(key(route), JSON.stringify(['c-same']));
    create(() => route, undefined, key);
    await stars.load();
    expect(stars.get('same')).toBeDefined();
    getStarredMessagesForConversation.mockResolvedValueOnce([]);
    await stars.load(true, true);
    expect(stars.get('same')).toBeUndefined();
    expect(JSON.parse(localStorage.getItem(key(route))!)).toEqual([]);
  });

  it('retains historical site stars without rewriting Gemini-prefixed compatibility keys', async () => {
    const legacyKey = `geminiTimelineStars:${route}`;
    localStorage.setItem(legacyKey, JSON.stringify(['c-old']));
    create(() => route, undefined, key);
    await stars.load();
    expect(stars.get('old')?.turnId).toBe('c-old');
    expect(localStorage.getItem(key(route))).toBeNull();
    expect(localStorage.getItem(legacyKey)).toBe(JSON.stringify(['c-old']));
  });

  it('stores new stars in the per-site key and mirrors their existing message format', async () => {
    create(() => route, undefined, key);
    const element = insert();
    stars.observe([seen(element)]);
    await stars.load();
    await stars.toggle({ ...turn, element }, () => ({ url: 'https://site/c/b', title: 'B' }));
    expect(JSON.parse(localStorage.getItem(key(route))!)).toEqual(['c-same']);
    expect(addStarredMessage).toHaveBeenCalledWith(
      expect.objectContaining({ turnId: 'c-same', conversationId: route }),
    );
  });
});
