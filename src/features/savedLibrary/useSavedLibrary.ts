import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { useLanguage } from '@/contexts/LanguageContext';
import {
  HIGHLIGHT_STORAGE_NAMESPACE,
  type HighlightAccountScope,
  type HighlightRecordV1,
} from '@/core/types/highlight';
import { askConfirm } from '@/core/ui/confirm';

import { StarredMessagesService } from './StarredMessagesService';
import { listLibraryHighlights, removeLibraryItem } from './libraryClient';
import { type SavedLibraryItem, savedLibraryItemKey, toSavedLibraryItems } from './model';
import type { StarredMessage } from './starTypes';
import { type SavedLibrarySelection, getSavedLibraryView } from './viewModel';

type HighlightSource = 'all' | (() => Promise<HighlightAccountScope | null>);

/** Reads and mutations belong here; popup and full-page views only present the result. */
export function useSavedLibrary({
  highlightScope,
  confirmRemoval = true,
}: {
  highlightScope: HighlightSource;
  confirmRemoval?: boolean;
}) {
  const { t } = useLanguage();
  const [sources, setSources] = useState<{
    stars: StarredMessage[];
    highlights: HighlightRecordV1[];
  }>({ stars: [], highlights: [] });
  const [selection, updateSelection] = useState<SavedLibrarySelection>({
    kind: 'all',
    query: '',
    site: 'all',
    account: 'all',
  });
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);
  const [notice, setNotice] = useState<{ text: string; error: boolean } | null>(null);
  const alive = useRef(false);
  const generation = useRef(0);
  const lifetime = useRef<AbortController | null>(null);
  const allItems = useMemo(() => toSavedLibraryItems(sources.stars, sources.highlights), [sources]);
  const currentItems = useRef(allItems);
  useEffect(() => {
    currentItems.current = allItems;
  }, [allItems]);
  const view = useMemo(() => getSavedLibraryView(allItems, selection), [allItems, selection]);

  const reload = useCallback(async () => {
    const request = ++generation.current;
    setLoading(true);
    const [stars, highlights] = await Promise.allSettled([
      StarredMessagesService.getAllStarredMessagesSorted(),
      (async () =>
        listLibraryHighlights(
          typeof highlightScope === 'function' ? await highlightScope() : highlightScope,
        ))(),
    ]);
    if (!alive.current || request !== generation.current) return;
    // A failed source keeps its last readable data instead of masquerading as an empty store.
    setSources((previous) => ({
      stars: stars.status === 'fulfilled' ? stars.value : previous.stars,
      highlights: highlights.status === 'fulfilled' ? highlights.value : previous.highlights,
    }));
    setError(stars.status === 'rejected' || highlights.status === 'rejected');
    setLoading(false);
  }, [highlightScope]);

  useEffect(() => {
    alive.current = true;
    lifetime.current = new AbortController();
    const changed = (changes: Record<string, chrome.storage.StorageChange>, area: string) => {
      const stars = StarredMessagesService.decodeStorageChange(area, changes);
      const highlights =
        area === 'local' &&
        Object.keys(changes).some((key) => key.startsWith(`${HIGHLIGHT_STORAGE_NAMESPACE}:`));
      if (stars !== undefined || highlights) void reload();
    };
    chrome.storage.onChanged.addListener(changed);
    void reload();
    return () => {
      alive.current = false;
      generation.current += 1;
      lifetime.current?.abort();
      chrome.storage.onChanged.removeListener(changed);
    };
  }, [reload]);

  const setSelection = useCallback((next: Partial<SavedLibrarySelection>) => {
    updateSelection((previous) => ({
      ...previous,
      ...next,
      ...(next.site !== undefined && next.site !== previous.site ? { account: 'all' } : {}),
    }));
  }, []);

  const remove = useCallback(
    async (item: SavedLibraryItem): Promise<boolean> => {
      const session = lifetime.current;
      setNotice(null);
      if (confirmRemoval) {
        const answer = await askConfirm({
          message: t(
            item.kind === 'starred'
              ? 'savedLibraryRemoveStarConfirm'
              : 'savedLibraryDeleteHighlightConfirm',
          ),
          tone: 'danger',
          cancelLabel: t('pm_cancel'),
          choices: [
            { id: 'remove', label: t(item.kind === 'starred' ? 'removeFromStarred' : 'pm_delete') },
          ],
          signal: session?.signal,
        });
        if (answer !== 'remove') return false;
      }
      const key = savedLibraryItemKey(item);
      if (
        !alive.current ||
        session?.signal.aborted ||
        !currentItems.current.some((candidate) => savedLibraryItemKey(candidate) === key)
      )
        return false;
      const removalGeneration = ++generation.current;
      try {
        await removeLibraryItem(item);
        if (!alive.current || session?.signal.aborted) return false;
        const refreshOverlapped = generation.current !== removalGeneration;
        // A read issued before the removal settled must not reintroduce its deleted row.
        generation.current += 1;
        setSources((previous) => ({
          stars:
            item.kind === 'starred'
              ? previous.stars.filter(
                  (star) =>
                    star.conversationId !== item.conversationId || star.turnId !== item.turnId,
                )
              : previous.stars,
          highlights:
            item.kind === 'highlight'
              ? previous.highlights.filter(
                  (record) =>
                    record.id !== item.id ||
                    record.platform !== item.platform ||
                    record.accountHash !== item.accountHash ||
                    record.conversationId !== item.conversationId,
                )
              : previous.highlights,
        }));
        setLoading(false);
        // Replay an overlapping refresh so another tab's additions are not dropped with stale rows.
        if (refreshOverlapped) void reload();
        return true;
      } catch {
        if (alive.current && !session?.signal.aborted) {
          setNotice({
            text: t(item.kind === 'highlight' ? 'highlightDeleteFailed' : 'starredDeleteFailed'),
            error: true,
          });
          setLoading(false);
        }
        return false;
      }
    },
    [confirmRemoval, reload, t],
  );

  return { ...view, allItems, selection, setSelection, loading, error, notice, reload, remove };
}
