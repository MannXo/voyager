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
const onScreen = [{ token: turn.token, hash: turn.hash }];

let route: string;

function create(): NavigatorStars {
  return new NavigatorStars({
    routeId: () => route,
    starId: () => route,
    alive: () => true,
    keyedTurns: () => true,
  });
}

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
  route = 'site:conv:b';
  addStarredMessage.mockClear();
  getStarredMessagesForConversation.mockClear();
});

describe('navigator star writes', () => {
  it('writes what was pressed, where it was pressed, once the read lands', async () => {
    const stars = create();
    stars.observe(onScreen);
    const release = deferRead();
    void stars.load();

    const toggled = stars.toggle(turn, () => ({ url: 'https://site/c/b', title: 'B' }));
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
    const stars = create();
    stars.observe(onScreen);
    const release = deferRead();
    void stars.load();

    const toggled = stars.toggle(turn, () => ({ url: 'https://site/c/b', title: 'B' }));
    route = 'site:conv:c';
    stars.observe([{ token: 'item-c', hash: 'same' }]);
    void stars.load();
    release([]);

    expect(await toggled).toBe(false);
    expect(addStarredMessage).not.toHaveBeenCalled();
  });

  it('refuses a press before a refresh has seen the current route', () => {
    route = '/';
    const stars = new NavigatorStars({
      routeId: () => route,
      starId: () => (route.startsWith('site:conv:') ? route : null),
      alive: () => true,
      keyedTurns: () => true,
    });
    // A new chat's turn: any id it gets may star it, but only once a refresh saw that id.
    stars.observe([{ token: 'draft-1', hash: 'x' }]);
    route = 'site:conv:c';
    expect(stars.canStar('draft-1')).toBe(false);

    stars.observe([{ token: 'draft-1', hash: 'x' }]);
    expect(stars.canStar('draft-1')).toBe(true);
  });

  it('refuses a turn first seen under another conversation', () => {
    const stars = create();
    stars.observe(onScreen);
    route = 'site:conv:c';
    stars.observe([...onScreen, { token: 'item-c', hash: 'other' }]);

    expect(stars.canStar('item-1')).toBe(false);
    expect(stars.canStar('item-c')).toBe(true);
  });

  it('writes the turn as it was when pressed, even if the marker changes meanwhile', async () => {
    const stars = create();
    stars.observe(onScreen);
    const release = deferRead();
    void stars.load();
    const target = { ...turn };

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
