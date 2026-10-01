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

const turn = { id: 'c-same', hash: 'same', summary: 'Same prompt', token: 'item-1' };

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
): NavigatorStars {
  stars = new NavigatorStars({
    routeId: () => route,
    starId,
    alive: () => true,
    keyedTurns: () => true,
    turnConversation,
  });
  stars.begin();
  return stars;
}

/** The host inserts a turn item now, under whatever the URL names. */
function insert(): HTMLElement {
  const element = document.createElement('div');
  document.body.appendChild(element);
  stars.recordInsertions([{ addedNodes: [element] } as unknown as MutationRecord]);
  return element;
}

const seen = (token: string, element: Node, hash = 'same') => ({ token, element, hash });

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
    stars.observe([seen(turn.token, element)]);
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
    stars.observe([seen(turn.token, element)]);
    const release = deferRead();
    void stars.load();

    const toggled = stars.toggle({ ...turn, element }, () => ({
      url: 'https://site/c/b',
      title: 'B',
    }));
    route = 'site:conv:c';
    stars.observe([seen('item-c', insert())]);
    void stars.load();
    release([]);

    expect(await toggled).toBe(false);
    expect(addStarredMessage).not.toHaveBeenCalled();
  });

  it('refuses a press before a refresh has seen the current route', () => {
    create();
    const element = insert();
    stars.observe([seen(turn.token, element)]);
    route = 'site:conv:c';
    expect(stars.canStar({ token: turn.token, element })).toBe(false);
  });

  it("never stars a new chat's turn, not even under the id the chat gets", () => {
    route = '/';
    create(() => (route.startsWith('site:conv:') ? route : null));
    const draft = insert();
    stars.observe([seen('draft-1', draft, 'x')]);
    route = 'site:conv:c';
    stars.observe([seen('draft-1', draft, 'x')]);

    expect(stars.canStar({ token: 'draft-1', element: draft })).toBe(false);
  });

  it('refuses a turn that entered the page under another conversation', () => {
    create();
    const item = insert();
    stars.observe([seen(turn.token, item)]);
    route = 'site:conv:c';
    // Inserted while B's turn is still on screen: whose it is is not proven.
    const early = insert();
    stars.observe([seen(turn.token, item), seen('item-c', early, 'other')]);
    item.remove();
    stars.observe([seen('item-c', early, 'other')]);
    const later = document.createElement('div');
    early.replaceWith(later);
    stars.recordInsertions([{ addedNodes: [later] } as unknown as MutationRecord]);
    stars.observe([seen('item-d', later, 'other')]);

    expect(stars.canStar({ token: turn.token, element: item })).toBe(false);
    expect(stars.canStar({ token: 'item-c', element: early })).toBe(false);
    expect(stars.canStar({ token: 'item-d', element: later })).toBe(true);
  });

  it("lets the host's id for a turn's conversation decide, both ways", () => {
    route = '/';
    create(() => (route.startsWith('site:conv:') ? route : null), stated);
    const draft = insert();
    stars.observe([seen('draft-1', draft, 'x')]);
    route = 'site:conv:c';
    stars.observe([seen('draft-1', draft, 'x')]);
    expect(stars.canStar({ token: 'draft-1', element: draft })).toBe(false);

    // The host says the new chat became this conversation.
    draft.setAttribute('data-conv', 'c');
    expect(stars.canStar({ token: 'draft-1', element: draft })).toBe(true);
    // A turn that entered under this URL, but the host files it elsewhere.
    const other = insert();
    other.setAttribute('data-conv', 'd');
    stars.observe([seen('draft-1', draft, 'x'), seen('item-d', other, 'y')]);
    expect(stars.canStar({ token: 'item-d', element: other })).toBe(false);

    // Where the host names conversations, a turn without its id is not starrable,
    // even one that entered the page under this conversation.
    const pending = insert();
    stars.observe([seen('draft-1', draft, 'x'), seen('item-e', pending, 'z')]);
    expect(stars.canStar({ token: 'item-e', element: pending })).toBe(false);
    pending.setAttribute('data-conv', 'c');
    expect(stars.canStar({ token: 'item-e', element: pending })).toBe(true);
  });

  it('drops a press when the host files the turn elsewhere while its read is pending', async () => {
    create(() => route, stated);
    const element = insert();
    element.setAttribute('data-conv', 'b');
    stars.observe([seen(turn.token, element)]);
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
    stars.observe([seen(turn.token, element)]);
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
