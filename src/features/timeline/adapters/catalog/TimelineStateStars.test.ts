import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { StorageKeys } from '@/core/types/common';
import type { StarredMessage } from '@/features/savedLibrary/starTypes';
import { eventBus } from '@/pages/content/timeline/EventBus';

import { TimelineState } from '../../TimelineState';
import type { TimelineStoragePolicy } from '../../TimelineStoragePolicy';
import type { TimelineMarker } from '../../types';
import { CatalogTurnOwnership } from './CatalogTurnOwnership';
import { extractTurnHash } from './turnHash';

const { addStarredMessage, getStarredMessagesForConversation, removeStarredMessage } = vi.hoisted(
  () => ({
    addStarredMessage: vi.fn().mockResolvedValue(undefined),
    getStarredMessagesForConversation: vi.fn().mockResolvedValue([]),
    removeStarredMessage: vi.fn().mockResolvedValue(undefined),
  }),
);

vi.mock('@/features/savedLibrary/StarredMessagesService', async (importOriginal) => ({
  StarredMessagesService: {
    decodeStorageChange: (
      await importOriginal<typeof import('@/features/savedLibrary/StarredMessagesService')>()
    ).StarredMessagesService.decodeStorageChange,
    addStarredMessage,
    getStarredMessagesForConversation,
    removeStarredMessage,
  },
}));

const turn = { id: 'c-same', hash: 'same', summary: 'Same prompt' };

let route: string;
let ownership: CatalogTurnOwnership;
let state: TimelineState;
const states: TimelineState[] = [];
const init = () => state.init();

/** The conversation a host that names it puts on the turn's container. */
function stated(element: Element): string | null {
  const id = element.closest('[data-conv]')?.getAttribute('data-conv');
  return id ? `site:conv:${id}` : null;
}

function create(
  starId: () => string | null = () => route,
  turnConversation?: (element: Element) => string | null | undefined,
  storageKey?: (id: string) => string,
): void {
  ownership = new CatalogTurnOwnership({ routeId: () => route, starId, turnConversation });
  ownership.begin();
  const capturedRoute = route;
  const capturedId = starId();
  const policy: TimelineStoragePolicy = {
    conversationId: capturedId ?? route,
    url: `https://site/c/${route.split(':').at(-1)}`,
    settingsPrefix: 'gvTimeline:site:',
    stars: {
      key: capturedId && storageKey ? storageKey(capturedId) : null,
      legacyKeys: capturedId ? [`geminiTimelineStars:${capturedId}`] : [],
      copyLegacy: false,
      source: 'local',
      libraryMirror: true,
      matchLegacyConversations: false,
      resolveAccount: async () => undefined,
    },
    hierarchy: { localKey: null },
    isCurrent: () => route === capturedRoute,
    canEdit: (marker) => !!marker && ownership.canStar(marker.element),
    resolveMountedTurnId: extractTurnHash,
    resolveStoredTurnId: extractTurnHash,
    getStoredTurnIdAliases: (id) => [id],
    getConversationTitle: () => 'B',
  };
  state = new TimelineState(() => {}, policy);
  states.push(state);
}

function observe(turns: Array<{ element: Element; hash: string }>): void {
  ownership.observe(turns);
  state.replaceMarkers(
    turns.map(({ element, hash }) => ({
      id: `c-${hash}`,
      element: element as HTMLElement,
      summary: 'Same prompt',
      assistantSummary: '',
      baseN: 0,
      starred: false,
    })),
  );
}

function press(target: {
  id: string;
  hash: string;
  summary: string;
  element: Element;
}): Promise<void> {
  const marker: TimelineMarker = {
    ...target,
    element: target.element as HTMLElement,
    assistantSummary: '',
    baseN: 0,
    starred: false,
  };
  state.replaceMarkers([marker]);
  return state.toggleStar(target.id);
}

function synchronizeLibrary(messages: StarredMessage[]): void {
  for (const [listener] of vi.mocked(chrome.storage.onChanged.addListener).mock.calls)
    listener(
      {
        [StorageKeys.SAVED_LIBRARY_STARS]: { newValue: { messages: { [route]: messages } } },
      },
      'local',
    );
}

/** The host inserts a turn now, under whatever the URL names. */
function insert(): HTMLElement {
  const element = document.createElement('div');
  document.body.appendChild(element);
  ownership.recordInsertions([{ addedNodes: [element] } as unknown as MutationRecord]);
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
  removeStarredMessage.mockClear();
  getStarredMessagesForConversation.mockReset().mockResolvedValue([]);
});

afterEach(() => states.splice(0).forEach((state) => state.destroy()));

describe('shared timeline star writes', () => {
  it('writes what was pressed, where it was pressed, once the read lands', async () => {
    create();
    const element = insert();
    observe([seen(element)]);
    const release = deferRead();
    void init();

    const toggled = press({ ...turn, element });
    release([]);

    await toggled;
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
    observe([seen(element)]);
    const release = deferRead();
    void init();

    const toggled = press({ ...turn, element });
    route = 'site:conv:c';
    observe([seen(insert())]);
    void init();
    release([]);

    await toggled;
    expect(addStarredMessage).not.toHaveBeenCalled();
  });

  it('refuses a press before a refresh has seen the current route', () => {
    create();
    const element = insert();
    observe([seen(element)]);
    route = 'site:conv:c';
    expect(ownership.canStar(element)).toBe(false);
  });

  it("never stars a new chat's turn, not even under the id the chat gets", () => {
    route = '/';
    create(() => (route.startsWith('site:conv:') ? route : null));
    const draft = insert();
    observe([seen(draft, 'x')]);
    route = 'site:conv:c';
    observe([seen(draft, 'x')]);

    expect(ownership.canStar(draft)).toBe(false);
  });

  it('refuses a turn that entered the page under another conversation', () => {
    create();
    const item = insert();
    observe([seen(item)]);
    route = 'site:conv:c';
    // Inserted while B's turn is still on screen: whose it is is not proven.
    const early = insert();
    observe([seen(item), seen(early, 'other')]);
    item.remove();
    observe([seen(early, 'other')]);
    const later = document.createElement('div');
    early.replaceWith(later);
    ownership.recordInsertions([{ addedNodes: [later] } as unknown as MutationRecord]);
    observe([seen(later, 'other')]);

    expect(ownership.canStar(item)).toBe(false);
    expect(ownership.canStar(early)).toBe(false);
    expect(ownership.canStar(later)).toBe(true);
  });

  it("lets the host's id for a turn's conversation decide, both ways", () => {
    route = '/';
    create(() => (route.startsWith('site:conv:') ? route : null), stated);
    const draft = insert();
    observe([seen(draft, 'x')]);
    route = 'site:conv:c';
    observe([seen(draft, 'x')]);
    expect(ownership.canStar(draft)).toBe(false);

    // The host says the new chat became this conversation.
    draft.setAttribute('data-conv', 'c');
    expect(ownership.canStar(draft)).toBe(true);
    // A turn that entered under this URL, but the host files it elsewhere.
    const other = insert();
    other.setAttribute('data-conv', 'd');
    observe([seen(draft, 'x'), seen(other, 'y')]);
    expect(ownership.canStar(other)).toBe(false);

    // Where the host names conversations, a turn without its id is not starrable,
    // even one that entered the page under this conversation.
    const pending = insert();
    observe([seen(draft, 'x'), seen(pending, 'z')]);
    expect(ownership.canStar(pending)).toBe(false);
    pending.setAttribute('data-conv', 'c');
    expect(ownership.canStar(pending)).toBe(true);
  });

  it('drops a press when the host files the turn elsewhere while its read is pending', async () => {
    create(() => route, stated);
    const element = insert();
    element.setAttribute('data-conv', 'b');
    observe([seen(element)]);
    const release = deferRead();
    void init();

    const toggled = press({ ...turn, element });
    element.setAttribute('data-conv', 'c');
    release([]);

    await toggled;
    expect(addStarredMessage).not.toHaveBeenCalled();
  });

  it('writes the turn as it was when pressed, even if the marker changes meanwhile', async () => {
    create();
    const element = insert();
    observe([seen(element)]);
    const release = deferRead();
    void init();
    const target = { ...turn, element };

    const toggled = press(target);
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
    await init();
    expect(state.isMarkerStarred('c-same')).toBe(true);
  });

  it('does not resurrect a Saved Library removal from the primary ids', async () => {
    localStorage.setItem(key(route), JSON.stringify(['c-same']));
    create(() => route, undefined, key);
    await init();
    expect(state.isMarkerStarred('c-same')).toBe(true);
    synchronizeLibrary([]);
    expect(state.isMarkerStarred('c-same')).toBe(false);
    expect(JSON.parse(localStorage.getItem(key(route))!)).toEqual([]);
  });

  it('retains historical site stars without rewriting Gemini-prefixed compatibility keys', async () => {
    const legacyKey = `geminiTimelineStars:${route}`;
    localStorage.setItem(legacyKey, JSON.stringify(['c-old']));
    create(() => route, undefined, key);
    await init();
    expect(state.isMarkerStarred('c-old')).toBe(true);
    expect(localStorage.getItem(key(route))).toBeNull();
    expect(localStorage.getItem(legacyKey)).toBe(JSON.stringify(['c-old']));
  });

  it('retains historical and library-only stars when the first primary edit occurs', async () => {
    const legacyKey = `geminiTimelineStars:${route}`;
    localStorage.setItem(legacyKey, JSON.stringify(['c-old']));
    getStarredMessagesForConversation.mockResolvedValueOnce([
      {
        turnId: 'c-library',
        conversationId: route,
        conversationUrl: 'https://site/c/b',
        content: 'Library',
        starredAt: 1,
      },
    ]);
    create(() => route, undefined, key);
    const element = insert();
    observe([seen(element)]);
    await init();
    await press({ ...turn, element });
    expect(JSON.parse(localStorage.getItem(key(route))!)).toEqual(['c-library', 'c-old', 'c-same']);
    expect(localStorage.getItem(legacyKey)).toBe(JSON.stringify(['c-old']));
  });

  it('seeds the complete primary when an external star edit arrives during initial hydration', async () => {
    const legacyKey = `geminiTimelineStars:${route}`;
    localStorage.setItem(legacyKey, JSON.stringify(['c-old', 'c-removed']));
    create(() => route, undefined, key);
    const release = deferRead();
    const pending = init();
    eventBus.emit('starred:added', { conversationId: route, turnId: 'c-new' });
    eventBus.emit('starred:removed', { conversationId: route, turnId: 'c-removed' });
    eventBus.emit('starred:removed', { conversationId: route, turnId: 'c-library-removed' });
    expect(localStorage.getItem(key(route))).toBeNull();
    release(
      ['c-library', 'c-library-removed'].map((turnId) => ({
        turnId,
        conversationId: route,
        conversationUrl: 'https://site/c/b',
        content: turnId,
        starredAt: 1,
      })),
    );
    await pending;
    expect(JSON.parse(localStorage.getItem(key(route))!)).toEqual(['c-library', 'c-old', 'c-new']);
    expect(localStorage.getItem(legacyKey)).toBe('["c-old","c-removed"]');
  });

  it('ignores malformed Chrome library snapshots without overwriting a healthy primary', async () => {
    localStorage.setItem(key(route), JSON.stringify(['c-same']));
    create(() => route, undefined, key);
    await init();
    for (const value of [
      {},
      { messages: [] },
      { messages: { [route]: null } },
      { messages: { [route]: [null] } },
    ]) {
      for (const [listener] of vi.mocked(chrome.storage.onChanged.addListener).mock.calls)
        listener({ [StorageKeys.SAVED_LIBRARY_STARS]: { newValue: value } }, 'local');
      expect(localStorage.getItem(key(route))).toBe('["c-same"]');
      expect(state.isMarkerStarred('c-same')).toBe(true);
    }
  });

  it('preserves primary stars and refuses edits when the initial library read fails', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    localStorage.setItem(key(route), JSON.stringify(['c-same']));
    getStarredMessagesForConversation.mockRejectedValue(new Error('Message port closed'));
    create(() => route, undefined, key);
    const element = insert();
    observe([seen(element)]);
    await init();
    await press({ ...turn, element });
    expect(state.markers[0].starred).toBe(true);
    expect(localStorage.getItem(key(route))).toBe(JSON.stringify(['c-same']));
    expect(removeStarredMessage).not.toHaveBeenCalled();
    expect(addStarredMessage).not.toHaveBeenCalled();
  });

  it('does not overwrite a newer library removal with the initial pending snapshot', async () => {
    localStorage.setItem(key(route), JSON.stringify(['c-same']));
    create(() => route, undefined, key);
    const element = insert();
    observe([seen(element)]);
    const release = deferRead();
    const pending = init();
    synchronizeLibrary([]);
    release([
      {
        turnId: 'c-same',
        conversationId: route,
        conversationUrl: 'https://site/c/b',
        content: 'Same prompt',
        starredAt: 1,
      },
    ]);
    await pending;
    expect(state.markers[0].starred).toBe(false);
    expect(localStorage.getItem(key(route))).toBe('[]');
  });

  it('resolves historical hash aliases for every mounted copy and removes their stored records', async () => {
    localStorage.setItem(key(route), JSON.stringify(['c-0-same']));
    create(() => route, undefined, key);
    const element = insert();
    const duplicate = insert();
    ownership.observe([seen(element), seen(duplicate)]);
    state.replaceMarkers([
      {
        id: 'c-same',
        element,
        summary: 'Same prompt',
        assistantSummary: '',
        baseN: 0,
        starred: false,
      },
      {
        id: 'c-same~2',
        element: duplicate,
        summary: 'Same prompt',
        assistantSummary: '',
        baseN: 1,
        starred: false,
      },
    ]);
    await init();
    expect(state.markers.map((marker) => marker.starred)).toEqual([true, true]);
    expect(state.resolveMarkerIdForStorageId('c-0-same')).toBe('c-same');
    await state.toggleStar('c-same~2');
    expect(removeStarredMessage).toHaveBeenCalledWith(route, 'c-0-same');
    expect(localStorage.getItem(key(route))).toBe('[]');
  });

  it('stores new stars in the per-site key and mirrors their existing message format', async () => {
    create(() => route, undefined, key);
    const element = insert();
    observe([seen(element)]);
    await init();
    await press({ ...turn, element });
    expect(JSON.parse(localStorage.getItem(key(route))!)).toEqual(['c-same']);
    expect(addStarredMessage).toHaveBeenCalledWith(
      expect.objectContaining({ turnId: 'c-same', conversationId: route }),
    );
  });
});
