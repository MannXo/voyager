import { beforeEach, describe, expect, it, vi } from 'vitest';

import { CatalogTimelineAdapter } from './CatalogTimelineAdapter';
import { catalogHierarchyStorageKey, type CatalogTimelineConfig } from './config';
import { buildConversationId, starConversationId, turnConversationId } from './conversationId';
import { NavigatorStars } from './navigatorStars';

vi.mock('@/pages/content/timeline/StarredMessagesService', () => ({
  StarredMessagesService: {
    getStarredMessagesForConversation: vi.fn().mockResolvedValue([]),
    addStarredMessage: vi.fn().mockResolvedValue(undefined),
    removeStarredMessage: vi.fn().mockResolvedValue(undefined),
  },
}));

const fixtures = [
  {
    siteId: 'claude',
    siteLabel: 'Claude',
    turnSelector: '[data-testid="user-message"]',
    assistantTurnSelector: '.assistant',
    conversationIdPattern: '^/chat/([^/?#]+)',
    conversationIdAttribute: 'data-conv-id',
    path: '/chat/first',
  },
  {
    siteId: 'chatgpt',
    siteLabel: 'ChatGPT',
    turnSelector: '[data-user-message-bubble]',
    assistantTurnSelector: '[data-message-author-role="assistant"]',
    conversationIdPattern: '^/c/([^/?#]+)',
    conversationIdAttribute: 'data-conversation-id',
    path: '/c/first',
  },
];

beforeEach(() => {
  document.body.innerHTML = '';
  localStorage.clear();
});

for (const fixture of fixtures) {
  describe(`${fixture.siteId} shared timeline adapter`, () => {
    const config: CatalogTimelineConfig = {
      ...fixture,
      position: 'right',
      pluginId: `voyager.${fixture.siteId}-timeline`,
      coachmarkId: 'test',
    };
    function turn(text: string, role: 'user' | 'assistant' = 'user'): HTMLElement {
      const element = document.createElement('div');
      if (fixture.siteId === 'claude') {
        if (role === 'user') element.dataset.testid = 'user-message';
        else element.className = 'assistant';
      } else if (role === 'user') element.setAttribute('data-user-message-bubble', '');
      else element.dataset.messageAuthorRole = 'assistant';
      element.textContent = text;
      return element;
    }
    function create() {
      history.replaceState({}, '', fixture.path);
      document.body.setAttribute(fixture.conversationIdAttribute, 'first');
      const stars = new NavigatorStars({
        routeId: () => location.href.split('#')[0],
        starId: () => starConversationId(config),
        alive: () => true,
        turnConversation: (element) => turnConversationId(config, element),
      });
      stars.begin();
      const adapter = new CatalogTimelineAdapter(config, stars);
      return { adapter, stars };
    }

    it('collects prompt and assistant summaries through catalog selectors across virtualized windows', () => {
      const { adapter } = create();
      const first = turn('First prompt');
      document.body.append(first, turn('First answer', 'assistant'), turn('Next prompt'));
      let markers = adapter.collect(document.body, config.turnSelector, []);
      const id = markers[0].id;
      expect(markers.map((marker) => [marker.summary, marker.assistantSummary])).toEqual([
        ['First prompt', 'First answer'],
        ['Next prompt', ''],
      ]);
      first.remove();
      markers = adapter.collect(document.body, config.turnSelector, markers);
      expect(markers.map((marker) => marker.summary)).toEqual(['First prompt', 'Next prompt']);
      document.body.prepend(turn('First prompt'));
      markers = adapter.collect(document.body, config.turnSelector, markers);
      expect(markers[0].id).toBe(id);
      expect(markers).toHaveLength(2);
      adapter.destroy();
      expect(document.querySelector('[data-gv-turn-id]')).toBeNull();
      document.body.removeAttribute(fixture.conversationIdAttribute);
    });

    it('persists hierarchy under its site and restores collapse geometry on conversation remount', async () => {
      const { adapter } = create();
      document.body.append(turn('Parent'), turn('Child'), turn('Next parent'));
      const state = adapter.createState(() => {});
      await state.init();
      state.replaceMarkers(adapter.collect(document.body, config.turnSelector, []));
      state.hierarchy.markerLevelEnabled = true;
      state.hierarchy.setMarkerLevel(state.markers[1].id, 2);
      state.hierarchy.toggleCollapse(state.markers[0].id);
      expect(state.hierarchy.getHiddenMarkerIndices()).toEqual(new Set([1]));
      const key = catalogHierarchyStorageKey(fixture.siteId, buildConversationId(config));
      expect(localStorage.getItem(key)).toBeTruthy();
      expect(
        localStorage.getItem(`geminiTimelineLevels:${buildConversationId(config)}`),
      ).toBeNull();
      state.destroy();
      const restored = adapter.createState(() => {});
      await restored.init();
      restored.replaceMarkers(state.markers);
      restored.hierarchy.markerLevelEnabled = true;
      expect(restored.hierarchy.getHiddenMarkerIndices()).toEqual(new Set([1]));
      restored.destroy();
      adapter.destroy();
      document.body.removeAttribute(fixture.conversationIdAttribute);
    });

    it('refuses hierarchy edits for a previous conversation still on screen after the route changes', async () => {
      const { adapter, stars } = create();
      document.body.append(turn('Cached previous prompt'));
      adapter.collect(document.body, config.turnSelector, []);
      history.replaceState({}, '', fixture.path.replace('first', 'next'));
      const nextAdapter = new CatalogTimelineAdapter(config, stars);
      const state = nextAdapter.createState(() => {});
      await state.init();
      state.replaceMarkers(nextAdapter.collect(document.body, config.turnSelector, []));
      state.hierarchy.setMarkerLevel(state.markers[0].id, 2);
      state.hierarchy.toggleCollapse(state.markers[0].id);
      expect(state.hierarchy.getMarkerLevel(state.markers[0].id)).toBe(1);
      expect(
        localStorage.getItem(
          catalogHierarchyStorageKey(fixture.siteId, buildConversationId(config)),
        ),
      ).toBeNull();
      state.destroy();
      adapter.destroy();
      nextAdapter.destroy();
      document.body.removeAttribute(fixture.conversationIdAttribute);
    });
  });
}
