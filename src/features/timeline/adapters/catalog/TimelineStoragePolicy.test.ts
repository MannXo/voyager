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
const accountAttributes = ['data-theme-user-id', 'data-theme-account-id'];
const accountA = 'chatgpt:ab894c1ca59dbaea95295fae9a616794d31cffbfdf53b53649933ca4842b5bca';

function setAccount(userId: string | null, accountId: string | null) {
  for (const [attribute, value] of [
    ['data-theme-user-id', userId],
    ['data-theme-account-id', accountId],
  ] as const) {
    if (value === null) document.documentElement.removeAttribute(attribute);
    else document.documentElement.setAttribute(attribute, value);
  }
}

async function fixture(siteId: string, accountIdAttributes?: readonly string[]) {
  const config: CatalogTimelineConfig = {
    siteId,
    siteLabel: siteId,
    accountIdAttributes,
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
  setAccount(null, null);
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

afterEach(() => {
  states.splice(0).forEach((state) => state.destroy());
  setAccount(null, null);
});

describe('ChatGPT star accounts', () => {
  it.each([
    { label: 'omitted', attributes: undefined },
    { label: 'empty', attributes: [] },
  ])('a site with $label account attributes leaves its stars untagged', async ({ attributes }) => {
    setAccount('user-account-a', 'workspace-a');
    const state = await fixture('chatgpt', attributes);
    await state.toggleStar('c-turn');
    const message = library.get('chatgpt:conv:one')?.[0];
    expect(message).toMatchObject({ content: 'Prompt' });
    expect(message).not.toHaveProperty('account');
  });

  it('a configured site stamps stars from its own attribute names under its own namespace', async () => {
    document.documentElement.setAttribute('data-example-user', 'user-account-a');
    document.documentElement.setAttribute('data-example-workspace', 'workspace-a');
    try {
      const state = await fixture('example', ['data-example-user', 'data-example-workspace']);
      await state.toggleStar('c-turn');
      expect(library.get('example:conv:one')?.[0].account).toBe(
        accountA.replace('chatgpt:', 'example:'),
      );
    } finally {
      document.documentElement.removeAttribute('data-example-user');
      document.documentElement.removeAttribute('data-example-workspace');
    }
  });

  it('a star added on account A carries A’s opaque key even when the attributes change after the press', async () => {
    const state = await fixture('chatgpt', accountAttributes);
    setAccount('user-account-a', 'workspace-a');
    const pressed = state.toggleStar('c-turn');
    setAccount('user-account-b', 'workspace-b');
    await pressed;
    expect(library.get('chatgpt:conv:one')?.[0].account).toBe(accountA);

    await state.toggleStar('c-turn');
    await state.toggleStar('c-turn');
    const nextAccount = library.get('chatgpt:conv:one')?.[0].account;
    expect(nextAccount).toMatch(/^chatgpt:[a-f0-9]{64}$/);
    expect(nextAccount).not.toBe(accountA);
  });

  it.each([
    [null, null],
    [null, 'workspace-a'],
    ['user-account-a', null],
    ['', 'workspace-a'],
    ['user-account-a', ''],
  ])(
    'a star has no account when either theme attribute is missing or empty (%s, %s)',
    async (userId, accountId) => {
      setAccount(userId, accountId);
      const state = await fixture('chatgpt', accountAttributes);
      await state.toggleStar('c-turn');
      const message = library.get('chatgpt:conv:one')?.[0];
      expect(message).toMatchObject({ turnId: 'c-turn', content: 'Prompt' });
      expect(message).not.toHaveProperty('account');
    },
  );

  it('the same account pair keeps its key after the document and timeline are recreated', async () => {
    setAccount('user-account-a', 'workspace-a');
    const first = await fixture('chatgpt', accountAttributes);
    await first.toggleStar('c-turn');
    const originalKey = library.get('chatgpt:conv:one')?.[0].account;
    expect(originalKey).toBe(accountA);
    first.destroy();
    library.clear();
    document.body.replaceChildren();
    setAccount(null, null);
    setAccount('user-account-a', 'workspace-a');

    const reloaded = await fixture('chatgpt', accountAttributes);
    await reloaded.toggleStar('c-turn');
    expect(library.get('chatgpt:conv:one')?.[0].account).toBe(originalKey);
  });

  it.each([
    ['user-account-b', 'workspace-a'],
    ['user-account-a', 'workspace-b'],
  ])(
    'changing either part of the account pair gives a star a different key (%s, %s)',
    async (userId, accountId) => {
      const state = await fixture('chatgpt', accountAttributes);
      setAccount(userId, accountId);
      await state.toggleStar('c-turn');
      const key = library.get('chatgpt:conv:one')?.[0].account;
      expect(key).toMatch(/^chatgpt:[a-f0-9]{64}$/);
      expect(key).not.toBe(accountA);
    },
  );

  it.each(['claude', 'deepseek'])(
    '%s stars stay untagged even when ChatGPT theme attributes exist',
    async (siteId) => {
      setAccount('user-account-a', 'workspace-a');
      const state = await fixture(siteId);
      await state.toggleStar('c-turn');
      const message = library.get(`${siteId}:conv:one`)?.[0];
      expect(message).toMatchObject({ turnId: 'c-turn', content: 'Prompt' });
      expect(message).not.toHaveProperty('account');
    },
  );
});

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
