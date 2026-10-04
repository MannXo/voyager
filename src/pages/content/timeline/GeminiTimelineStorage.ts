import {
  accountIsolationService,
  detectAccountContextFromDocument,
} from '@/core/services/AccountIsolationService';
import { StorageKeys } from '@/core/types/common';
import {
  buildConversationIdFromUrl,
  buildLegacyConversationIdFromUrl,
  buildRouteConversationIdFromUrl,
  extractConversationIdFromUrl,
} from '@/core/utils/conversationIdentity';
import type { TimelineStoragePolicy } from '@/features/timeline/TimelineStoragePolicy';
import type { TimelineMarker } from '@/features/timeline/types';

import { getLegacyTurnIndex } from '../fork/turnId';
import {
  type HistoryTimestampStore,
  historyTimestampStore as sharedHistoryTimestampStore,
} from '../timestamp/historyTimestamps';
import {
  getLegacyTimelineCollapsedStorageKey,
  getLegacyTimelineLevelsStorageKey,
} from './hierarchyTypes';

export function createGeminiTimelineStoragePolicy(
  url = window.location.href,
  historyTimestampStore: Pick<
    HistoryTimestampStore,
    'getTurnIdAliases' | 'resolveCanonicalTurnId'
  > = sharedHistoryTimestampStore,
): TimelineStoragePolicy {
  const conversationId = buildConversationIdFromUrl(url);
  const nativeConversationId = extractConversationIdFromUrl(url);
  const resolveAccountScope = async () => {
    // Gemini may render or update its account header after the adapter mounts.
    const context = detectAccountContextFromDocument(url, document);
    if (!context.routeUserId && !context.email) return null;
    return accountIsolationService.resolveAccountScope({
      pageUrl: url,
      routeUserId: context.routeUserId,
      email: context.email,
    });
  };
  const key = conversationId ? `geminiTimelineStars:${conversationId}` : null;
  return {
    conversationId,
    url,
    settingsPrefix: 'geminiTimeline',
    stars: {
      key,
      legacyKeys: [buildRouteConversationIdFromUrl(url), buildLegacyConversationIdFromUrl(url)]
        .filter(Boolean)
        .map((id) => `geminiTimelineStars:${id}`)
        .filter((candidate) => candidate !== key),
      copyLegacy: true,
      source: 'library',
      libraryMirror: true,
      matchLegacyConversations: true,
      resolveAccount: async () => (await resolveAccountScope())?.accountKey,
    },
    hierarchy: {
      extensionKey: StorageKeys.TIMELINE_HIERARCHY,
      legacyLevelsKey: conversationId ? getLegacyTimelineLevelsStorageKey(conversationId) : null,
      legacyCollapsedKey: conversationId
        ? getLegacyTimelineCollapsedStorageKey(conversationId)
        : null,
      resolveAccountScope,
    },
    // A mounted u-N is an unverified window position even when stored u-N has a history alias.
    resolveMountedTurnId: (id) => (getLegacyTurnIndex(id) === null ? id : null),
    resolveStoredTurnId: (id) =>
      nativeConversationId
        ? historyTimestampStore.resolveCanonicalTurnId(nativeConversationId, id)
        : getLegacyTurnIndex(id) === null
          ? id
          : null,
    getStoredTurnIdAliases: (id) => {
      // A mounted positional fallback is not evidence of its full-conversation identity.
      if (getLegacyTurnIndex(id) !== null) return [];
      if (!nativeConversationId) return [id];
      const aliases = historyTimestampStore.getTurnIdAliases(nativeConversationId, id);
      return aliases.length > 0 ? aliases : [id];
    },
    canEdit: (_marker, id) => getLegacyTurnIndex(id) === null,
    isCurrent: () => true,
    getConversationTitle: (markers) => getConversationTitle(url, markers),
  };
}

function getConversationTitle(url: string, markers: readonly TimelineMarker[]): string {
  const selected = document
    .querySelector('.gv-folder-conversation-selected .gv-conversation-title')
    ?.textContent?.trim();
  if (selected) return selected;
  const title = document.querySelector('title')?.textContent?.trim();
  if (
    title &&
    !['Gemini', 'Google Gemini', 'Google AI Studio'].includes(title) &&
    !title.startsWith('Gemini -') &&
    !title.startsWith('Google AI Studio -')
  )
    return title;
  for (const selector of [
    'mat-list-item.mdc-list-item--activated [mat-line]',
    'mat-list-item[aria-current="page"] [mat-line]',
    '.conversation-list-item.active .conversation-title',
    '.active-conversation .title',
  ]) {
    const text = document.querySelector(selector)?.textContent?.trim();
    if (text && text !== 'New chat') return text;
  }
  const summary = markers[0]?.summary;
  if (summary) return summary.length > 50 ? `${summary.slice(0, 50)}...` : summary;
  const id = new URL(url).pathname.match(/\/app\/([a-zA-Z0-9_-]+)/)?.[1];
  return id ? `Conversation ${id.slice(0, 8)}...` : 'Untitled Conversation';
}
