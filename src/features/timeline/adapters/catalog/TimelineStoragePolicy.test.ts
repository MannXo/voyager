import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { StarredMessagesService } from '@/features/savedLibrary/StarredMessagesService';
import type { StarredMessage } from '@/features/savedLibrary/starTypes';

import { TimelineState } from '../../TimelineState';
import { createCatalogTimelineStoragePolicy } from './CatalogTimelineStorage';
import { CatalogTurnOwnership } from './CatalogTurnOwnership';
import type { CatalogTimelineConfig } from './config';
import { starConversationId, turnConversationId } from './conversationId';

const states: TimelineState[] = [];
const library = new Map<string, StarredMessage[]>();

async function fixture(siteId: string) {
  const config: CatalogTimelineConfig = {
    siteId,
    siteLabel: siteId,
    turnSelector: '.turn',
    conversationIdPattern: '^/c/([^/?#]+)',
    position: 'right',
    pluginId: `${siteId}.timeline`,
    coachmarkId: 'timeline-style',
  };
  const ownership = new CatalogTurnOwnership({
    routeId: () => location.href.split('#')[0],
    starId: () => starConversationId(config),
    turnConversation: (element) => turnConversationId(config, element),
  });
  ownership.begin();
  const element = document.createElement('div');
  document.body.appendChild(element);
  ownership.recordInsertions([{ addedNodes: [element] } as unknown as MutationRecord]);
  ownership.observe([{ element, hash: 'turn' }]);
  const policy = createCatalogTimelineStoragePolicy(config, ownership);
  const state = new TimelineState(vi.fn(), policy);
  states.push(state);
  state.replaceMarkers([
    { id: 'c-turn', element, summary: 'Prompt', assistantSummary: '', baseN: 0, starred: false },
  ]);
  await state.init();
  return state;
}

beforeEach(() => {
  vi.restoreAllMocks();
  history.replaceState({}, '', '/c/one');
  localStorage.clear();
  document.body.replaceChildren();
  library.clear();
  vi.spyOn(StarredMessagesService, 'getStarredMessagesForConversation').mockImplementation(
    async (conversationId) => library.get(conversationId) ?? [],
  );
  vi.spyOn(StarredMessagesService, 'addStarredMessage').mockImplementation(async (message) => {
    library.set(message.conversationId, [
      ...(library.get(message.conversationId) ?? []).filter(
        (stored) => stored.turnId !== message.turnId,
      ),
      message,
    ]);
  });
  vi.spyOn(StarredMessagesService, 'removeStarredMessage').mockImplementation(
    async (conversationId, turnId) => {
      library.set(
        conversationId,
        (library.get(conversationId) ?? []).filter((stored) => stored.turnId !== turnId),
      );
    },
  );
});

afterEach(() => states.splice(0).forEach((state) => state.destroy()));

describe.each(['chatgpt', 'claude', 'deepseek'])('%s shared timeline storage policy', (siteId) => {
  it('keeps the site hierarchy format and saves stars through the Library', async () => {
    const state = await fixture(siteId);
    const conversationId = `${siteId}:conv:one`;
    const hierarchyKey = `gvTimelineHierarchy:${siteId}:${conversationId}`;
    state.hierarchy.setMarkerLevel('c-turn', 2);
    state.hierarchy.toggleCollapse('c-turn');
    expect(localStorage.getItem(hierarchyKey)).toBe(
      '{"levels":{"c-turn":2},"collapsed":["c-turn"]}',
    );
    state.hierarchy.setMarkerLevel('c-turn', 1);
    state.hierarchy.toggleCollapse('c-turn');
    expect(localStorage.getItem(hierarchyKey)).toBe('{"levels":{},"collapsed":[]}');
    await state.toggleStar('c-turn');
    expect(StarredMessagesService.addStarredMessage).toHaveBeenCalledWith(
      expect.objectContaining({ conversationId, turnId: 'c-turn' }),
    );
    expect(state.markers[0].starred).toBe(true);
    expect(
      vi.mocked(StarredMessagesService.addStarredMessage).mock.calls.at(-1)?.[0].account,
    ).toBeUndefined();
  });

  it('refuses stars and hierarchy edits after its captured route is replaced', async () => {
    const state = await fixture(siteId);
    history.replaceState({}, '', '/c/two');
    state.hierarchy.setMarkerLevel('c-turn', 2);
    state.hierarchy.toggleCollapse('c-turn');
    await state.toggleStar('c-turn');
    expect(localStorage.length).toBe(0);
    expect(StarredMessagesService.addStarredMessage).not.toHaveBeenCalled();
  });

  it('keeps unnamed new-chat turns outside persisted conversation state', async () => {
    history.replaceState({}, '', '/');
    const state = await fixture(siteId);
    state.hierarchy.setMarkerLevel('c-turn', 2);
    state.hierarchy.toggleCollapse('c-turn');
    await state.toggleStar('c-turn');
    expect(localStorage.length).toBe(0);
    expect(StarredMessagesService.getStarredMessagesForConversation).not.toHaveBeenCalled();
    expect(StarredMessagesService.addStarredMessage).not.toHaveBeenCalled();
  });
});
