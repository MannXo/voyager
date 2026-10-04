import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { StorageKeys } from '@/core/types/common';
import { createStarStore } from '@/features/savedLibrary/starStore';
import type { StarredMessage, StarredMessagesData } from '@/features/savedLibrary/starTypes';
import { createStarredMessagesHandler } from '@/pages/background/starredMessages';
import { createGeminiTimelineStoragePolicy } from '@/pages/content/timeline/GeminiTimelineStorage';

import { TimelineState } from '../TimelineState';

const LIBRARY_ONLY = 's-1111111111111111';
const LOCAL = 's-2222222222222222';
const NEW = 's-3333333333333333';
const CONVERSATION = 'gemini:conv:ordering';
const PRIMARY = `geminiTimelineStars:${CONVERSATION}`;
let state: TimelineState | null = null;

async function settle(): Promise<void> {
  for (let i = 0; i < 30; i++) await Promise.resolve();
}

beforeEach(() => {
  vi.restoreAllMocks();
  localStorage.clear();
  document.body.replaceChildren();
  history.replaceState({}, '', '/app/ordering');
  vi.mocked(chrome.storage.local.get).mockImplementation(async () => ({}));
  vi.mocked(chrome.storage.local.set).mockResolvedValue();
});
afterEach(() => {
  state?.destroy();
  state = null;
});

describe('Library hydration ordering', () => {
  it('a partial local stars event cannot make an invalidated Library read authorize an edit', async () => {
    const message = (turnId: string): StarredMessage => ({
      turnId,
      conversationId: CONVERSATION,
      conversationUrl: location.href,
      content: turnId,
      starredAt: 1,
    });
    let library: StarredMessagesData = {
      messages: { [CONVERSATION]: [message(LIBRARY_ONLY), message(LOCAL)] },
    };
    let releaseInitial!: () => void;
    let releaseRetry!: () => void;
    let reads = 0;
    const area = {
      get: vi.fn(async () => {
        reads += 1;
        if (reads <= 2)
          await new Promise<void>((resolve) => {
            if (reads === 1) releaseInitial = resolve;
            else releaseRetry = resolve;
          });
        return { [StorageKeys.TIMELINE_STARRED_MESSAGES]: structuredClone(library) };
      }),
      set: vi.fn(async (values: Record<string, unknown>) => {
        library = structuredClone(
          values[StorageKeys.TIMELINE_STARRED_MESSAGES],
        ) as StarredMessagesData;
      }),
    };
    const handle = createStarredMessagesHandler(createStarStore(area));
    const requests: string[] = [];
    vi.mocked(chrome.runtime.sendMessage).mockImplementation(((
      request: { type: string },
      callback: (response: unknown) => void,
    ) => {
      requests.push(request.type);
      void handle(request)?.then(callback, (error: Error) =>
        callback({ ok: false, error: error.message }),
      );
    }) as typeof chrome.runtime.sendMessage);
    localStorage.setItem(PRIMARY, JSON.stringify([LOCAL]));
    state = new TimelineState(() => {}, createGeminiTimelineStoragePolicy());
    state.replaceMarkers(
      [LIBRARY_ONLY, LOCAL, NEW].map((id, index) => ({
        id,
        element: document.createElement('div'),
        summary: id,
        assistantSummary: '',
        baseN: index / 2,
        starred: false,
      })),
    );
    const initial = state.init();
    await settle();

    // Another context updated the compatibility list; it is not the complete Library snapshot.
    const event = new Event('storage');
    Object.assign(event, {
      key: PRIMARY,
      newValue: JSON.stringify([LOCAL]),
      storageArea: localStorage,
    });
    window.dispatchEvent(event);
    releaseInitial();
    await initial;
    const edit = state.toggleStar(NEW);
    await settle();
    const beforeCompleteRead = localStorage.getItem(PRIMARY);
    const writesBeforeCompleteRead = area.set.mock.calls.length;
    releaseRetry();
    await edit;

    expect(beforeCompleteRead).toBe(JSON.stringify([LOCAL]));
    expect(writesBeforeCompleteRead).toBe(0);
    expect(requests.filter((type) => type === 'gv.starred.getAll')).toHaveLength(2);
    expect(JSON.parse(localStorage.getItem(PRIMARY)!)).toEqual([LIBRARY_ONLY, LOCAL, NEW]);
    expect(library.messages[CONVERSATION].map((star) => star.turnId)).toEqual([
      LIBRARY_ONLY,
      LOCAL,
      NEW,
    ]);
    expect(state.markers.map((marker) => marker.starred)).toEqual([true, true, true]);
  });
});
