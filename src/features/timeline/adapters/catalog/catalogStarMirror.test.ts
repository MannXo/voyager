import { beforeEach, describe, expect, it, vi } from 'vitest';

import { StarredMessagesService } from '@/pages/content/timeline/StarredMessagesService';
import type { StarredMessage } from '@/pages/content/timeline/starredTypes';

import { catalogStarsStorageKey } from './config';

beforeEach(() => {
  localStorage.clear();
  vi.mocked(chrome.runtime.sendMessage).mockImplementation(((...args: unknown[]) => {
    const callback = args.at(-1);
    if (typeof callback === 'function') callback({ ok: true, added: true, removed: true });
  }) as typeof chrome.runtime.sendMessage);
});

function message(conversationId: string): StarredMessage {
  return {
    conversationId,
    turnId: 'c-new',
    content: 'New prompt',
    conversationUrl: location.href,
    starredAt: 1,
  };
}

describe('Saved Library local mirrors', () => {
  it.each(['claude', 'chatgpt', 'deepseek'])(
    'preserves %s primary ids without writing a Gemini key',
    async (site) => {
      const conversationId = `${site}:conv:one`;
      const key = catalogStarsStorageKey(site, conversationId);
      localStorage.setItem(key, JSON.stringify(['c-existing']));
      await StarredMessagesService.addStarredMessage(message(conversationId));
      expect(JSON.parse(localStorage.getItem(key)!)).toEqual(['c-existing', 'c-new']);
      expect(localStorage.getItem(`geminiTimelineStars:${conversationId}`)).toBeNull();
      await StarredMessagesService.removeStarredMessage(conversationId, 'c-new');
      expect(JSON.parse(localStorage.getItem(key)!)).toEqual(['c-existing']);
    },
  );

  it('keeps the existing Gemini local key and ids format', async () => {
    await StarredMessagesService.addStarredMessage(message('gemini-conversation'));
    expect(localStorage.getItem('geminiTimelineStars:gemini-conversation')).toBe(
      JSON.stringify(['c-new']),
    );
  });
});
