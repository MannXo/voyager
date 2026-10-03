import { describe, expect, it, vi } from 'vitest';

import { StorageKeys } from '@/core/types/common';
import type { StarredMessage, StarredMessagesData } from '@/pages/content/timeline/starredTypes';

import { createStarredMessagesOwner } from '../starredMessages';

const key = StorageKeys.TIMELINE_STARRED_MESSAGES;
const star = (conversationId: string, turnId: string, starredAt = 1): StarredMessage => ({
  conversationId,
  turnId,
  starredAt,
  content: `${conversationId} prompt`,
  conversationUrl: `https://gemini.google.com/u/2/app/${conversationId}`,
});

function setup(initial: unknown = { messages: {} }) {
  let stored = structuredClone(initial);
  const area = {
    get: vi.fn(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
      return { [key]: structuredClone(stored) };
    }),
    set: vi.fn(async (items: Record<string, unknown>) => {
      await new Promise((resolve) => setTimeout(resolve, 0));
      stored = structuredClone(items[key]);
    }),
  };
  return {
    owner: createStarredMessagesOwner(area),
    area,
    stored: () => stored as StarredMessagesData,
  };
}

const add = (payload: StarredMessage) => ({ type: 'gv.starred.add', payload });

describe('starred messages owner', () => {
  it('serializes concurrent writes, deduplicates only per conversation, and keeps previews bounded', async () => {
    const { owner, area, stored } = setup();
    const first = { ...star('a', '1'), content: 'x'.repeat(80) };
    await expect(
      Promise.all([
        owner.handle(add(first)),
        owner.handle(add(star('a', '2'))),
        owner.handle(add(star('a', '1', 9))),
        owner.handle(add(star('b', '1'))),
      ]),
    ).resolves.toEqual([
      { ok: true, added: true },
      { ok: true, added: true },
      { ok: true, added: false },
      { ok: true, added: true },
    ]);
    expect(stored()).toEqual({
      messages: {
        a: [{ ...first, content: `${'x'.repeat(60)}...` }, star('a', '2')],
        b: [star('b', '1')],
      },
    });
    expect(area.set).toHaveBeenCalledTimes(3);
    expect(area.get).toHaveBeenCalledWith([key]);
    await expect(
      owner.handle({ type: 'gv.starred.isStarred', payload: { conversationId: 'a', turnId: '2' } }),
    ).resolves.toEqual({ ok: true, isStarred: true });
  });

  it('reconciles draft ids by latest timestamp while retaining first-seen turn order and unrelated chats', async () => {
    const { owner, stored } = setup({
      messages: {
        stable: [star('stable', 'shared', 5), star('stable', 'first', 1)],
        draft: [star('draft', 'shared', 5), star('draft', 'second', 2)],
        other: [star('other', 'unchanged', 3)],
      },
    });
    const url = 'https://gemini.google.com/u/2/app/stable';
    const expected = [
      star('draft', 'shared', 5),
      star('stable', 'first', 1),
      star('draft', 'second', 2),
    ].map((message) => ({ ...message, conversationId: 'stable', conversationUrl: url }));
    await expect(
      owner.handle({
        type: 'gv.starred.reconcileConversationIds',
        payload: {
          targetConversationId: 'stable',
          sourceConversationIds: ['draft', 'draft', ''],
          conversationUrl: url,
        },
      }),
    ).resolves.toEqual({ ok: true, messages: expected });
    expect(stored()).toEqual({
      messages: { stable: expected, other: [star('other', 'unchanged', 3)] },
    });
    await expect(owner.getAllStarredMessages()).resolves.toEqual(stored());
  });

  it('removes empty buckets without writing for a missing turn and resumes after a rejected write', async () => {
    const { owner, area, stored } = setup({ messages: { a: [star('a', '1')] } });
    await expect(
      owner.handle({
        type: 'gv.starred.remove',
        payload: { conversationId: 'a', turnId: 'missing' },
      }),
    ).resolves.toEqual({ ok: true, removed: false });
    expect(area.set).not.toHaveBeenCalled();
    area.set.mockRejectedValueOnce(new Error('quota'));
    await expect(owner.handle(add(star('a', '2')))).rejects.toThrow('quota');
    await expect(
      owner.handle({ type: 'gv.starred.remove', payload: { conversationId: 'a', turnId: '1' } }),
    ).resolves.toEqual({ ok: true, removed: true });
    expect(stored()).toEqual({ messages: {} });
  });

  it('rejects failed reads while retaining malformed-data fallback and leaving unrelated messages alone', async () => {
    const { owner, area } = setup({ messages: { broken: null } });
    await expect(owner.getAllStarredMessages()).resolves.toEqual({ messages: {} });
    area.get.mockRejectedValueOnce(new Error('unavailable'));
    await expect(owner.handle({ type: 'gv.starred.getAll' })).rejects.toThrow('unavailable');
    expect(owner.handle({ type: 'gv.fork.getAll' })).toBeNull();
    expect(owner.handle(null)).toBeNull();
  });
});
