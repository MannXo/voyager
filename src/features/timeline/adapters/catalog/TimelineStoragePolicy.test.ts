import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { StarredMessagesService } from '@/features/savedLibrary/StarredMessagesService';

import { TimelineState } from '../../TimelineState';
import { createCatalogTimelineStoragePolicy } from './CatalogTimelineStorage';
import { CatalogTurnOwnership } from './CatalogTurnOwnership';
import type { CatalogTimelineConfig } from './config';
import { starConversationId, turnConversationId } from './conversationId';

const states: TimelineState[] = [];

async function fixture(siteId: string, mirror = true) {
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
  const state = new TimelineState(vi.fn(), {
    ...policy,
    stars: { ...policy.stars, libraryMirror: mirror },
  });
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
  vi.spyOn(StarredMessagesService, 'getStarredMessagesForConversation').mockResolvedValue([]);
  vi.spyOn(StarredMessagesService, 'addStarredMessage').mockResolvedValue();
  vi.spyOn(StarredMessagesService, 'removeStarredMessage').mockResolvedValue();
});

afterEach(() => states.splice(0).forEach((state) => state.destroy()));

describe.each(['chatgpt', 'claude', 'deepseek'])('%s shared timeline storage policy', (siteId) => {
  it('writes the exact site keys and existing hierarchy format from the shared state', async () => {
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
    expect(localStorage.getItem(`gvTimelineStars:${siteId}:${conversationId}`)).toBe('["c-turn"]');
    expect(StarredMessagesService.addStarredMessage).toHaveBeenCalledWith(
      expect.objectContaining({ conversationId, turnId: 'c-turn' }),
    );
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

  it('uses the same local star owner when Saved Library mirroring is off', async () => {
    const state = await fixture(siteId, false);
    await state.toggleStar('c-turn');
    expect(state.markers[0].starred).toBe(true);
    expect(localStorage.getItem(`gvTimelineStars:${siteId}:${siteId}:conv:one`)).toBe('["c-turn"]');
    expect(StarredMessagesService.getStarredMessagesForConversation).not.toHaveBeenCalled();
    expect(StarredMessagesService.addStarredMessage).not.toHaveBeenCalled();
    await state.toggleStar('c-turn');
    expect(state.markers[0].starred).toBe(false);
    expect(StarredMessagesService.removeStarredMessage).not.toHaveBeenCalled();
  });
});
