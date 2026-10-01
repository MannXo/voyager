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

function create(): NavigatorStars {
  return new NavigatorStars({
    routeId: () => route,
    starId: () => route,
    alive: () => true,
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
    stars.observe(new Set());
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
    stars.observe(new Set());
    const release = deferRead();
    void stars.load();

    const toggled = stars.toggle(turn, () => ({ url: 'https://site/c/b', title: 'B' }));
    route = 'site:conv:c';
    stars.observe(new Set());
    void stars.load();
    release([]);

    expect(await toggled).toBe(false);
    expect(addStarredMessage).not.toHaveBeenCalled();
  });

  it('refuses a press while turns from the previous conversation are on screen', async () => {
    const stars = create();
    stars.observe(new Set(['a-1']));
    await stars.load();
    route = 'site:conv:c';
    stars.observe(new Set(['a-1', 'c-1']));

    expect(stars.canStar()).toBe(false);
    stars.observe(new Set(['c-1']));
    expect(stars.canStar()).toBe(true);
  });

  it('allows a press at once when every turn was replaced before the URL changed', async () => {
    const stars = create();
    stars.observe(new Set(['a-1']));
    stars.observe(new Set(['c-1']));
    route = 'site:conv:c';
    stars.observe(new Set(['c-1']));

    expect(stars.canStar()).toBe(true);
  });

  it('writes the turn as it was when pressed, even if the marker changes meanwhile', async () => {
    const stars = create();
    stars.observe(new Set());
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
